/**
 * SSH ControlMaster multiplexing.
 *
 * Each Pi process gets one control socket per host/user/port. The first
 * command starts the master (`ControlMaster=auto`, `ControlPersist=yes`).
 * Later commands reuse that socket. Workspace paths are not copied.
 * Loaded skill directories are copied to the remote home on session start.
 *
 * Stale sockets (crashed master) are unlinked after `ssh -O check` fails.
 * On process exit, `ssh -O exit` stops the master and the socket is removed.
 *
 * Orphaned masters: a pi process killed before its exit hook leaves the
 * master alive (reparented to init) with `ControlPersist=yes`. Such a
 * master can go bad — e.g. after the host reboots or the TCP conn dies —
 * and then answers `Permission denied` locally, so the host never sees an
 * auth attempt and its logs look clean. Two defenses:
 *   1. `sweepOrphanMasters` unlinks sockets (and `ssh -O exit` their
 *      masters) whose embedded owner-pid no longer names a live process.
 *      Runs once per `ensureControlMaster`, outside the bootstrap lock.
 *   2. `ControlPersist=600` (not `yes`) so a leaked master self-terminates
 *      after 10 idle minutes anyway.
 *
 * Bootstrap serialization: when the socket is cold, parallel callers all
 * pass `ControlMaster=auto` and each would race to open its own new TCP
 * connection. A burst of simultaneous unauthenticated connections trips
 * sshd `MaxStartups` and (OpenSSH 10+) `PerSourcePenalties`, which then
 * rejects even valid keys for minutes. So the first caller runs a tiny
 * exclusive bootstrap connection (`ssh … true`) to start the master and
 * every other caller awaits the same in-process promise.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  buildBootstrapArgv,
  buildMuxCtlArgv,
  controlSocketPath,
  type EnabledSshTarget,
} from "./lib.ts";

export const DEFAULT_MUX_CACHE_DIR = path.join(os.tmpdir(), "pi-kit-ssh");

export type MuxFs = {
  exists: (file: string) => boolean;
  unlink: (file: string) => void;
  mkdirp: (dir: string) => void;
  readdir?: (dir: string) => string[];
};

export const defaultMuxFs: MuxFs = {
  exists: (file) => fs.existsSync(file),
  unlink: (file) => {
    try {
      fs.unlinkSync(file);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw err;
    }
  },
  mkdirp: (dir) => {
    fs.mkdirSync(dir, { recursive: true });
  },
  readdir: (dir) => {
    try {
      return fs.readdirSync(dir);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return [];
      throw err;
    }
  },
};

export function attachControlPath(
  target: EnabledSshTarget,
  opts: { pid?: number; cacheDir?: string } = {},
): EnabledSshTarget {
  if (target.mux === false) return target;
  if (target.controlPath) return target;
  return {
    ...target,
    controlPath: controlSocketPath({
      host: target.host,
      user: target.user,
      port: target.port,
      pid: opts.pid ?? process.pid,
      cacheDir: opts.cacheDir ?? DEFAULT_MUX_CACHE_DIR,
    }),
  };
}

export type StaleSocketAction = "reuse" | "unlink" | "none";

export function staleSocketAction(opts: {
  checkExitCode: number | null;
  socketExists: boolean;
}): StaleSocketAction {
  if (opts.checkExitCode === 0) return "reuse";
  if (opts.socketExists) return "unlink";
  return "none";
}

type SpawnResult = { status: number | null; stderr: string };

export type MuxSpawn = (argv: string[]) => Promise<SpawnResult>;

type BootstrapResult = { status: number | null; stderr: string; action: StaleSocketAction };

/**
 * One in-process bootstrap per control socket, shared by every caller.
 * Keyed by controlPath: a process only ever has one target per socket,
 * but tests reuse the module across targets.
 */
const bootstraps = new Map<string, Promise<BootstrapResult>>();

/** Test hook: drop cached bootstrap promises. */
export function resetBootstrapLocks(): void {
  bootstraps.clear();
}

/** True while another caller is starting the master on this socket. */
export function bootstrapInFlight(controlPath: string): boolean {
  return bootstraps.has(controlPath);
}

/**
 * Extract the owner-pid from a socket name produced by `controlSocketPath`
 * (`cm-<hash>-<pid>`). Returns undefined when the suffix is not a pid.
 */
export function ownerPidFromSocketName(name: string): number | undefined {
  const m = /cm-[0-9a-f]+-(\d+)$/.exec(path.basename(name));
  if (!m) return undefined;
  const pid = Number(m[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

/**
 * Stop and unlink masters whose owning pi process is gone. A killed pi
 * never runs its exit hook, so its `ControlPersist=yes` master survives as
 * an init-parented orphan. A later session that reuses the pid keeps the
 * check honest; every other orphan is a leak. Best-effort: failures to
 * signal a master are ignored (it dies on its own eventually), only the
 * socket file cleanup matters.
 */
export function sweepOrphanMasters(
  muxFs: MuxFs = defaultMuxFs,
  opts: { cacheDir?: string; run?: (argv: string[]) => void } = {},
): void {
  const cacheDir = opts.cacheDir ?? DEFAULT_MUX_CACHE_DIR;
  const readdir = muxFs.readdir;
  if (!readdir) return; // fs-less test mux: nothing to sweep
  let entries: string[];
  try {
    entries = readdir.call(muxFs, cacheDir);
  } catch {
    return; // dir absent: nothing to sweep
  }
  for (const name of entries) {
    if (!name.startsWith("cm-")) continue;
    const pid = ownerPidFromSocketName(name);
    if (pid === undefined || processAlive(pid)) continue;
    const socket = path.join(cacheDir, name);
    if (opts.run) {
      // Injected runner (tests): must not throw either.
      try {
        opts.run(["ssh", "-O", "exit", "-o", `ControlPath=${socket}`, "ignored"]);
      } catch {
        // best-effort
      }
    } else {
      try {
        spawnSync("ssh", ["-O", "exit", "-o", `ControlPath=${socket}`, "ignored"], {
          timeout: 5000,
        });
      } catch {
        // best-effort
      }
    }
    muxFs.unlink(socket);
  }
}

function processAlive(pid: number): boolean {
  try {
    // signal 0 probes existence without side effects. A zombified owner
    // still counts as alive here — harmless, its master dies with it.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Make sure a live master exists on `target.controlPath` without a
 * connection race: one caller starts it, the rest await the same promise.
 * Returns the stale-socket action for the caller that did the work
 * ("none" for waiters).
 */
export async function ensureControlMaster(
  target: EnabledSshTarget,
  spawn: MuxSpawn,
  muxFs: MuxFs = defaultMuxFs,
): Promise<StaleSocketAction> {
  if (!target.controlPath) return "none";
  // Orphan sweep before the bootstrap lock: reap masters left by dead pi
  // processes so a bad master cannot answer auth failures locally (the
  // host never sees those attempts, so its logs stay clean and the real
  // cause stays invisible). Cheap: one readdir per exec at most.
  sweepOrphanMasters(muxFs);
  const key = target.controlPath;
  const existing = bootstraps.get(key);
  if (existing) {
    const r = await existing;
    if (r.status !== 0) throw new Error(r.stderr || "mux bootstrap failed");
    return "none";
  }
  const run = (async (): Promise<BootstrapResult> => {
    muxFs.mkdirp(path.dirname(key));
    const check = await spawn(buildMuxCtlArgv(target, "check"));
    const action = staleSocketAction({
      checkExitCode: check.status,
      socketExists: muxFs.exists(key),
    });
    if (action === "unlink") muxFs.unlink(key);
    if (action === "reuse") {
      return { status: 0, stderr: "", action };
    }
    // Start the master with one tiny exclusive connection. Concurrent
    // callers are awaiting this same promise, so exactly one new TCP
    // connection opens no matter how many tool calls race.
    const result = await spawn(buildBootstrapArgv(target));
    return { ...result, action };
  })();
  bootstraps.set(key, run);
  try {
    const r = await run;
    if (r.status !== 0) throw new Error(r.stderr || "mux bootstrap failed");
    return r.action;
  } catch (err) {
    bootstraps.delete(key);
    throw err;
  }
}

export function closeControlMasterSync(
  target: EnabledSshTarget,
  muxFs: MuxFs = defaultMuxFs,
  run: (argv: string[]) => SpawnResult = (argv) => {
    const r = spawnSync(argv[0]!, argv.slice(1), { encoding: "utf8" });
    return { status: r.status, stderr: r.stderr ?? "" };
  },
): void {
  if (!target.controlPath) return;
  try {
    run(buildMuxCtlArgv(target, "exit"));
  } catch {
    // best-effort teardown
  }
  if (muxFs.exists(target.controlPath)) muxFs.unlink(target.controlPath);
}

let exitHookInstalled = false;

export function installMuxExitHook(target: EnabledSshTarget): void {
  if (exitHookInstalled) return;
  if (!target.controlPath) return;
  exitHookInstalled = true;
  const close = () => closeControlMasterSync(target);
  process.once("exit", close);
}
