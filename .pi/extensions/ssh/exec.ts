/**
 * Spawn `ssh` for a framed remote command. IO is injectable so unit tests
 * never need a live host.
 */

import { spawn } from "node:child_process";

import {
  buildRemoteScript,
  buildSshArgv,
  classifySshFailure,
  formatSpawnError,
  formatTransportError,
  DEFAULT_MAX_CONCURRENT,
  type EnabledSshTarget,
} from "./lib.ts";
import { ensureControlMaster } from "./mux.ts";

export type ExecResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutBuffer: Buffer;
  stderrBuffer: Buffer;
  ok: boolean;
};

export type ExecChunk = {
  stream: "stdout" | "stderr";
  data: Buffer;
};

export type SshSpawnResult = {
  exitCode: number;
  stdout: Buffer;
  stderr: Buffer;
};

export type SshIo = {
  spawn: (
    argv: string[],
    opts: { signal?: AbortSignal },
  ) => Promise<SshSpawnResult> & { output?: () => AsyncIterable<ExecChunk> };
};

export class SshTransportError extends Error {
  readonly transport = true;
  constructor(message: string) {
    super(message);
    this.name = "SshTransportError";
  }
}

function joinChunks(chunks: Buffer[]): Buffer {
  if (chunks.length === 0) return Buffer.alloc(0);
  if (chunks.length === 1) return chunks[0]!;
  return Buffer.concat(chunks);
}

/**
 * Counting semaphore over concurrent ssh channels. All channels share one
 * mux master connection and sshd refuses session opens past `MaxSessions`
 * (default 10). The cap default 8 leaves headroom. FIFO waiters queue
 * until a slot frees.
 */
export class ChannelSemaphore {
  private limit: number;
  private active = 0;
  private waiters: Array<() => void> = [];

  constructor(limit: number = DEFAULT_MAX_CONCURRENT) {
    this.limit = limit;
  }

  get capacity(): number {
    return this.limit;
  }

  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active++;
      return () => this.release();
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active++;
    return () => this.release();
  }

  private release(): void {
    this.active--;
    const next = this.waiters.shift();
    if (next) next();
  }
}

/** Per-process channel cap. Keyed by controlPath, one master per socket. */
const semaphores = new Map<string, ChannelSemaphore>();

/** Test hook. */
export function resetChannelSemaphores(): void {
  semaphores.clear();
}

function semaphoreFor(target: EnabledSshTarget): ChannelSemaphore | undefined {
  if (!target.controlPath) return undefined;
  let s = semaphores.get(target.controlPath);
  if (!s) {
    s = new ChannelSemaphore(target.maxConcurrent);
    semaphores.set(target.controlPath, s);
  }
  return s;
}

export function defaultSshIo(): SshIo {
  return {
    spawn(argv, opts) {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      const outputChunks: ExecChunk[] = [];
      let outputWaiters: Array<(item: IteratorResult<ExecChunk>) => void> = [];
      let done: IteratorResult<ExecChunk> | undefined;

      const flush = (item: IteratorResult<ExecChunk>) => {
        if (outputWaiters.length === 0) {
          if (item.done) done = item;
          else outputChunks.push(item.value);
          return;
        }
        const waiters = outputWaiters;
        outputWaiters = [];
        for (const w of waiters) w(item);
      };

      const child = spawn(argv[0]!, argv.slice(1), {
        stdio: ["ignore", "pipe", "pipe"],
      });

      child.stdout?.on("data", (buf: Buffer) => {
        stdoutChunks.push(buf);
        flush({ done: false, value: { stream: "stdout", data: buf } });
      });
      child.stderr?.on("data", (buf: Buffer) => {
        stderrChunks.push(buf);
        flush({ done: false, value: { stream: "stderr", data: buf } });
      });

      const promise = new Promise<SshSpawnResult>((resolve, reject) => {
        const onAbort = () => {
          child.kill("SIGTERM");
        };
        opts.signal?.addEventListener("abort", onAbort, { once: true });
        child.on("error", (err) => {
          opts.signal?.removeEventListener("abort", onAbort);
          flush({ done: true, value: undefined });
          reject(new SshTransportError(formatSpawnError(err)));
        });
        child.on("close", (code, signal) => {
          opts.signal?.removeEventListener("abort", onAbort);
          flush({ done: true, value: undefined });
          resolve({
            exitCode: code ?? (signal ? 1 : 0),
            stdout: joinChunks(stdoutChunks),
            stderr: joinChunks(stderrChunks),
          });
        });
      });

      const withOutput = promise as Promise<SshSpawnResult> & {
        output: () => AsyncIterable<ExecChunk>;
      };
      withOutput.output = async function* () {
        while (true) {
          if (outputChunks.length > 0) {
            yield outputChunks.shift()!;
            continue;
          }
          if (done) return;
          const item = await new Promise<IteratorResult<ExecChunk>>((resolve) => {
            outputWaiters.push(resolve);
          });
          if (item.done) return;
          yield item.value;
        }
      };
      return withOutput;
    },
  };
}

export type SshExecOptions = {
  argv?: string[];
  script?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  /**
   * Internal: set on the retry pass after a transport failure. Escapes
   * the retry loop instead of retrying again.
   */
  _retried?: boolean;
};

function toResult(spawned: SshSpawnResult): ExecResult {
  return {
    exitCode: spawned.exitCode,
    stdout: spawned.stdout.toString("utf8"),
    stderr: spawned.stderr.toString("utf8"),
    stdoutBuffer: spawned.stdout,
    stderrBuffer: spawned.stderr,
    ok: spawned.exitCode === 0,
  };
}

export type SshExecHandle = Promise<ExecResult> & {
  output(): AsyncIterable<ExecChunk>;
};

const TRANSPORT_RETRY_DELAY_MS = 2000;

type SpawnedHandle = Promise<SshSpawnResult> & {
  output?: () => AsyncIterable<ExecChunk>;
};

export function sshExec(
  target: EnabledSshTarget,
  opts: SshExecOptions,
  io: SshIo = defaultSshIo(),
): SshExecHandle {
  /** Attempt records in order. Registered at attempt start so output() can
   * begin streaming as soon as a spawn exists. The handle is boxed so the
   * raw spawn promise keeps its .output() (returning it through then()
   * would adopt the thenable and drop the property). */
  const attempts: Array<Promise<{ handle: SpawnedHandle }>> = [];

  const startAttempt = (attemptOpts: SshExecOptions): Promise<{ handle: SpawnedHandle }> => {
    const attempt = (async (): Promise<{ handle: SpawnedHandle }> => {
      // Hold a channel slot for the whole command. All channels share one
      // mux master and sshd refuses session opens past MaxSessions.
      const sem = semaphoreFor(target);
      const release = sem ? await sem.acquire() : undefined;
      try {
        const script = buildRemoteScript(attemptOpts);
        const argv = buildSshArgv(target, script);
        await ensureControlMaster(target, async (ctlArgv) => {
          const raw = await io.spawn(ctlArgv, { signal: attemptOpts.signal });
          return { status: raw.exitCode, stderr: raw.stderr.toString("utf8") };
        });
        const handle = io.spawn(argv, { signal: attemptOpts.signal });
        // Release when the child settles, without altering the handle.
        void handle.then(
          () => release?.(),
          () => release?.(),
        );
        return { handle };
      } catch (err) {
        release?.();
        throw err;
      }
    })();
    attempts.push(attempt);
    return attempt;
  };

  const promise = (async (): Promise<ExecResult> => {
    let attemptOpts = opts;
    for (;;) {
      try {
        const { handle } = await startAttempt(attemptOpts);
        const result = toResult(await handle);
        if (
          !result.ok &&
          classifySshFailure(result.exitCode, result.stderr) === "transport"
        ) {
          throw new SshTransportError(
            formatTransportError(target, result.exitCode, result.stderr),
          );
        }
        return result;
      } catch (err) {
        // One retry after a short backoff. A connection dropped by sshd
        // MaxStartups or a per-source penalty window clears in seconds to
        // minutes; a single spaced retry absorbs the short end without
        // masking a real outage (the retry failure is surfaced as-is).
        // Bootstrap failures arrive as plain Errors from mux.ts (no import
        // cycle), so classify their message the same way as spawn stderr.
        const transportLike =
          err instanceof SshTransportError ||
          (err instanceof Error &&
            err.name !== "AbortError" &&
            classifySshFailure(255, err.message) === "transport");
        if (
          transportLike &&
          !attemptOpts._retried &&
          !attemptOpts.signal?.aborted
        ) {
          await new Promise((r) => setTimeout(r, TRANSPORT_RETRY_DELAY_MS));
          attemptOpts = { ...attemptOpts, _retried: true };
          continue;
        }
        throw err;
      }
    }
  })();

  const handle = promise as SshExecHandle;
  handle.output = async function* () {
    // Drain attempt streams in order. A transport-failed attempt never ran
    // the command, so it yields nothing; the retry attempt follows it.
    let i = 0;
    for (;;) {
      while (i >= attempts.length) {
        const settled = await Promise.race([
          promise.then(
            () => true,
            () => true,
          ),
          new Promise<false>((r) => setTimeout(() => r(false), 5)),
        ]);
        if (settled && i >= attempts.length) return;
      }
      const spawned = (await attempts[i]!).handle;
      if (spawned.output) yield* spawned.output();
      i++;
    }
  };
  return handle;
}

export async function sshExecBuffered(
  target: EnabledSshTarget,
  opts: SshExecOptions,
  io: SshIo = defaultSshIo(),
): Promise<ExecResult> {
  return sshExec(target, opts, io);
}
