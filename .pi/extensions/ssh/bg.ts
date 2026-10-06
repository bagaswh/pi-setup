/**
 * SSH-backed bg_run / bg_status / bg_logs / bg_kill.
 *
 * Same tool names as pi-background-tasks, but the process lives on the SSH
 * host. Pi hard-fails on a second registration of the same tool name, so
 * Aide disables that package's `background-tasks.js` via project package
 * filter while SSH is on. When SSH is off or refuse-local, these tools are
 * not registered and Gondolin launches drop the filter so the package's
 * host tools remain.
 *
 * Remote layout (source of truth):
 *   {remoteWorkspace}/.pi/ssh-bg/<sessionId>/<taskId>/{meta.json,output,pid,status,exitcode,killed}
 * Do not write into pi-background-tasks' `.pi/tasks/` tree.
 *
 * Start uses setsid (or a plain background subshell) so the ssh channel can
 * close; kill targets the remote session leader / process group.
 */

import { randomBytes } from "node:crypto";

import {
  sshExecBuffered,
  SshTransportError,
  type ExecResult,
} from "./exec.ts";
import {
  isSafeRemotePath,
  quoteShell,
  sanitizeRemoteEnv,
  type EnabledSshTarget,
} from "./lib.ts";
import { sanitizeSessionId } from "./shell-state.ts";

export const MAX_LOG_BYTES = 50 * 1024;
export const BG_ROOT_DIRNAME = "ssh-bg";

export type SshBgStatus = "running" | "completed" | "failed" | "killed";

export type SshBgTaskMeta = {
  id: string;
  name: string;
  command: string;
  description?: string;
  cwd: string;
  outputPath: string;
  startedAt: string;
  timeoutSeconds?: number;
  deadlineAt?: string;
  isAgent?: boolean;
};

export type SshBgTaskSnapshot = SshBgTaskMeta & {
  status: SshBgStatus;
  pid?: number;
  exitCode?: number;
  error?: string;
};

export type SshExecBufferedFn = (
  target: EnabledSshTarget,
  opts: { argv?: string[]; script?: string; cwd?: string; env?: Record<string, string> },
) => Promise<ExecResult>;

export type TransportReporter = (err: unknown) => void;

export function newTaskId(): string {
  return `b${randomBytes(4).toString("hex")}`;
}

export function remoteBgSessionDir(
  remoteWorkspace: string,
  sessionId: string,
): string {
  return [
    remoteWorkspace.replace(/\/+$/, ""),
    ".pi",
    BG_ROOT_DIRNAME,
    sanitizeSessionId(sessionId),
  ].join("/");
}

export function remoteBgTaskDir(
  remoteWorkspace: string,
  sessionId: string,
  taskId: string,
): string {
  return `${remoteBgSessionDir(remoteWorkspace, sessionId)}/${taskId}`;
}

/** Exact id or unambiguous prefix, matching pi-background-tasks. */
export function resolveTaskId(
  ids: string[],
  idOrPrefix: string,
): string {
  const id = idOrPrefix.trim();
  if (!id) throw new Error("Task ID is required");
  if (ids.includes(id)) return id;
  const matches = ids.filter((candidate) => candidate.startsWith(id));
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous task ID prefix "${id}": ${matches.join(", ")}`,
    );
  }
  throw new Error(`Unknown background task ID: ${id}`);
}

export function clampLogBytes(maxBytes?: number): number {
  if (typeof maxBytes !== "number" || !Number.isFinite(maxBytes)) {
    return MAX_LOG_BYTES;
  }
  return Math.min(MAX_LOG_BYTES, Math.max(1, Math.floor(maxBytes)));
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Build the remote start script. Detaches via setsid when available so the
 * ssh channel returns immediately. stdout/stderr append to the task output
 * file; pid/status/exitcode live beside it.
 */
export function buildBgStartScript(opts: {
  taskDir: string;
  taskId: string;
  name: string;
  command: string;
  cwd: string;
  description?: string;
  timeoutSeconds?: number;
  isAgent?: boolean;
  env?: Record<string, string | undefined>;
  startedAt?: string;
}): string {
  if (!isSafeRemotePath(opts.taskDir)) {
    throw new Error(`ssh bg: unsafe task dir: ${opts.taskDir}`);
  }
  if (!isSafeRemotePath(opts.cwd)) {
    throw new Error(`ssh bg: unsafe remote cwd: ${opts.cwd}`);
  }
  const startedAt = opts.startedAt ?? new Date().toISOString();
  const outputPath = `${opts.taskDir}/output`;
  const deadlineAt =
    typeof opts.timeoutSeconds === "number" && opts.timeoutSeconds > 0
      ? new Date(
          Date.parse(startedAt) + opts.timeoutSeconds * 1000,
        ).toISOString()
      : undefined;

  const meta: SshBgTaskMeta = {
    id: opts.taskId,
    name: opts.name,
    command: opts.command,
    cwd: opts.cwd,
    outputPath,
    startedAt,
  };
  if (opts.description !== undefined) meta.description = opts.description;
  if (opts.timeoutSeconds !== undefined) meta.timeoutSeconds = opts.timeoutSeconds;
  if (deadlineAt !== undefined) meta.deadlineAt = deadlineAt;
  if (opts.isAgent !== undefined) meta.isAgent = opts.isAgent;

  const metaJson = JSON.stringify(meta);
  const env = sanitizeRemoteEnv(opts.env);
  const envExports = Object.entries(env).map(
    ([key, value]) => `export ${key}=${quoteShell(value)}`,
  );

  const timeoutSecs =
    typeof opts.timeoutSeconds === "number" && opts.timeoutSeconds > 0
      ? Math.floor(opts.timeoutSeconds)
      : 0;

  // timeout(1) enforces timeoutSeconds when present and available.
  const runCommand =
    timeoutSecs > 0
      ? `if command -v timeout >/dev/null 2>&1; then timeout ${timeoutSecs}s sh -c ${quoteShell(opts.command)}; else sh -c ${quoteShell(opts.command)}; fi`
      : `sh -c ${quoteShell(opts.command)}`;

  // Write a run.sh on the remote, then setsid it. One quote level keeps
  // cwd/command/env readable in the start script (and in unit tests).
  const runLines = [
    "#!/bin/sh",
    `echo $$ > ${quoteShell(`${opts.taskDir}/pid`)}`,
    `echo running > ${quoteShell(`${opts.taskDir}/status`)}`,
    ...envExports,
    `cd -- ${quoteShell(opts.cwd)} || exit 127`,
    `${runCommand} >>${quoteShell(outputPath)} 2>&1`,
    "ec=$?",
    `echo "$ec" > ${quoteShell(`${opts.taskDir}/exitcode`)}`,
    `if [ -f ${quoteShell(`${opts.taskDir}/killed`)} ]; then`,
    `  echo killed > ${quoteShell(`${opts.taskDir}/status`)}`,
    `elif [ "$ec" -eq 0 ]; then`,
    `  echo completed > ${quoteShell(`${opts.taskDir}/status`)}`,
    `else`,
    `  echo failed > ${quoteShell(`${opts.taskDir}/status`)}`,
    `fi`,
  ];
  const writeRunSh = [
    `{`,
    ...runLines.map((line) => `  printf '%s\\n' ${quoteShell(line)}`),
    `} > ${quoteShell(`${opts.taskDir}/run.sh`)}`,
    `chmod +x ${quoteShell(`${opts.taskDir}/run.sh`)}`,
  ];

  return [
    `set -eu`,
    `mkdir -p ${quoteShell(opts.taskDir)}`,
    `printf '%s\\n' ${quoteShell(metaJson)} > ${quoteShell(`${opts.taskDir}/meta.json`)}`,
    `: > ${quoteShell(outputPath)}`,
    ...writeRunSh,
    `if command -v setsid >/dev/null 2>&1; then`,
    `  setsid ${quoteShell(`${opts.taskDir}/run.sh`)} </dev/null >/dev/null 2>&1 &`,
    `else`,
    `  ${quoteShell(`${opts.taskDir}/run.sh`)} </dev/null >/dev/null 2>&1 &`,
    `fi`,
    `# Wait briefly for the child to record its pid.`,
    `i=0`,
    `while [ "$i" -lt 50 ]; do`,
    `  if [ -s ${quoteShell(`${opts.taskDir}/pid`)} ]; then break; fi`,
    `  i=$((i + 1))`,
    `  sleep 0.02 2>/dev/null || sleep 1`,
    `done`,
    `if [ ! -s ${quoteShell(`${opts.taskDir}/pid`)} ]; then`,
    `  echo 'ssh bg: remote process did not record a pid' >&2`,
    `  exit 1`,
    `fi`,
    `printf '%s\\n' ${quoteShell(opts.taskId)}`,
    `cat ${quoteShell(`${opts.taskDir}/pid`)}`,
    `printf '%s\\n' ${quoteShell(outputPath)}`,
  ].join("\n");
}

export function buildBgListIdsScript(sessionDir: string): string {
  if (!isSafeRemotePath(sessionDir)) {
    throw new Error(`ssh bg: unsafe session dir: ${sessionDir}`);
  }
  return [
    `set -eu`,
    `dir=${quoteShell(sessionDir)}`,
    `if [ ! -d "$dir" ]; then exit 0; fi`,
    `find "$dir" -mindepth 1 -maxdepth 1 -type d -printf '%f\\n' 2>/dev/null | sort`,
  ].join("\n");
}

export function buildBgStatusScript(taskDir: string): string {
  if (!isSafeRemotePath(taskDir)) {
    throw new Error(`ssh bg: unsafe task dir: ${taskDir}`);
  }
  const q = quoteShell(taskDir);
  return [
    `set -eu`,
    `dir=${q}`,
    `if [ ! -d "$dir" ]; then echo 'missing'; exit 1; fi`,
    `meta=""`,
    `if [ -f "$dir/meta.json" ]; then meta=$(cat "$dir/meta.json"); fi`,
    `pid=""`,
    `if [ -f "$dir/pid" ]; then pid=$(tr -d ' \\t\\r\\n' < "$dir/pid" || true); fi`,
    `exitcode=""`,
    `if [ -f "$dir/exitcode" ]; then exitcode=$(tr -d ' \\t\\r\\n' < "$dir/exitcode" || true); fi`,
    `status=""`,
    `if [ -f "$dir/status" ]; then status=$(tr -d ' \\t\\r\\n' < "$dir/status" || true); fi`,
    `alive=0`,
    `if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then alive=1; fi`,
    `if [ -z "$status" ]; then`,
    `  if [ "$alive" -eq 1 ]; then status=running`,
    `  elif [ -n "$exitcode" ]; then`,
    `    if [ "$exitcode" -eq 0 ]; then status=completed; else status=failed; fi`,
    `  else status=failed`,
    `  fi`,
    `fi`,
    `# Enforce recorded deadline when the process is still alive.`,
    `if [ "$status" = running ] && [ -n "$meta" ]; then`,
    `  deadline=$(printf '%s' "$meta" | sed -n 's/.*"deadlineAt"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p')`,
    `  if [ -n "$deadline" ]; then`,
    `    now=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || true)`,
    `    if [ -n "$now" ] && [ "$now" \\> "$deadline" ]; then`,
    `      if [ "$alive" -eq 1 ]; then`,
    `        kill -TERM -"$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true`,
    `        sleep 0.2 2>/dev/null || true`,
    `        kill -KILL -"$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true`,
    `      fi`,
    `      echo timed_out > "$dir/killed"`,
    `      echo 124 > "$dir/exitcode"`,
    `      echo failed > "$dir/status"`,
    `      status=failed`,
    `      exitcode=124`,
    `      alive=0`,
    `    fi`,
    `  fi`,
    `fi`,
    `if [ "$status" = running ] && [ "$alive" -eq 0 ] && [ -z "$exitcode" ]; then`,
    `  status=failed`,
    `  echo failed > "$dir/status"`,
    `fi`,
    `printf 'STATUS=%s\\n' "$status"`,
    `printf 'PID=%s\\n' "$pid"`,
    `printf 'EXIT=%s\\n' "$exitcode"`,
    `printf 'META=%s\\n' "$meta"`,
  ].join("\n");
}

export function buildBgKillScript(taskDir: string): string {
  if (!isSafeRemotePath(taskDir)) {
    throw new Error(`ssh bg: unsafe task dir: ${taskDir}`);
  }
  const q = quoteShell(taskDir);
  return [
    `set -eu`,
    `dir=${q}`,
    `if [ ! -d "$dir" ]; then echo 'missing'; exit 1; fi`,
    `status=""`,
    `if [ -f "$dir/status" ]; then status=$(tr -d ' \\t\\r\\n' < "$dir/status" || true); fi`,
    `pid=""`,
    `if [ -f "$dir/pid" ]; then pid=$(tr -d ' \\t\\r\\n' < "$dir/pid" || true); fi`,
    `alive=0`,
    `if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then alive=1; fi`,
    `if [ -z "$status" ]; then`,
    `  if [ "$alive" -eq 1 ]; then status=running`,
    `  elif [ -f "$dir/exitcode" ]; then`,
    `    ec=$(tr -d ' \\t\\r\\n' < "$dir/exitcode" || true)`,
    `    if [ "$ec" = 0 ]; then status=completed; else status=failed; fi`,
    `  else status=failed`,
    `  fi`,
    `fi`,
    `if [ "$status" != running ]; then`,
    `  printf 'NOT_RUNNING=%s\\n' "$status"`,
    `  exit 2`,
    `fi`,
    `touch "$dir/killed"`,
    `if [ -n "$pid" ]; then`,
    `  kill -TERM -"$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true`,
    `  sleep 0.3 2>/dev/null || true`,
    `  if kill -0 "$pid" 2>/dev/null; then`,
    `    kill -KILL -"$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true`,
    `  fi`,
    `fi`,
    `echo killed > "$dir/status"`,
    `if [ ! -f "$dir/exitcode" ]; then echo 143 > "$dir/exitcode"; fi`,
    `printf 'KILLED=1\\n'`,
    `printf 'PID=%s\\n' "$pid"`,
  ].join("\n");
}

export function buildBgLogsScript(
  taskDir: string,
  maxBytes: number,
  tail: boolean,
): string {
  if (!isSafeRemotePath(taskDir)) {
    throw new Error(`ssh bg: unsafe task dir: ${taskDir}`);
  }
  const bytes = clampLogBytes(maxBytes);
  const q = quoteShell(taskDir);
  const output = `"$dir/output"`;
  return [
    `set -eu`,
    `dir=${q}`,
    `out=${output}`,
    `if [ ! -f "$out" ]; then echo 'missing_output'; exit 1; fi`,
    `size=$(wc -c < "$out" | tr -d ' \\t')`,
    `printf 'SIZE=%s\\n' "$size"`,
    `printf 'PATH=%s\\n' "$out"`,
    `if [ "$size" -gt ${bytes} ]; then`,
    `  printf 'TRUNCATED=1\\n'`,
    tail
      ? `  printf 'MODE=tail\\n'; tail -c ${bytes} "$out"`
      : `  printf 'MODE=head\\n'; head -c ${bytes} "$out"`,
    `else`,
    `  printf 'TRUNCATED=0\\n'`,
    `  printf 'MODE=full\\n'`,
    `  cat "$out"`,
    `fi`,
  ].join("\n");
}

export function parseStatusOutput(stdout: string): {
  status: SshBgStatus;
  pid?: number;
  exitCode?: number;
  meta?: SshBgTaskMeta;
} {
  const lines = stdout.split("\n");
  let status: SshBgStatus = "failed";
  let pid: number | undefined;
  let exitCode: number | undefined;
  let meta: SshBgTaskMeta | undefined;
  for (const line of lines) {
    if (line.startsWith("STATUS=")) {
      const v = line.slice("STATUS=".length).trim();
      if (
        v === "running" ||
        v === "completed" ||
        v === "failed" ||
        v === "killed"
      ) {
        status = v;
      }
    } else if (line.startsWith("PID=")) {
      const raw = line.slice("PID=".length).trim();
      if (/^\d+$/.test(raw)) pid = Number(raw);
    } else if (line.startsWith("EXIT=")) {
      const raw = line.slice("EXIT=".length).trim();
      if (/^-?\d+$/.test(raw)) exitCode = Number(raw);
    } else if (line.startsWith("META=")) {
      const raw = line.slice("META=".length);
      if (raw.trim()) {
        try {
          meta = JSON.parse(raw) as SshBgTaskMeta;
        } catch {
          // ignore malformed meta
        }
      }
    }
  }
  return { status, pid, exitCode, meta };
}

export function parseStartOutput(stdout: string): {
  taskId: string;
  pid: number;
  outputPath: string;
} {
  const lines = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length < 3) {
    throw new Error(
      `ssh bg: start returned unexpected output: ${JSON.stringify(stdout)}`,
    );
  }
  const taskId = lines[0]!;
  const pid = Number(lines[1]);
  const outputPath = lines[2]!;
  if (!taskId || !Number.isFinite(pid) || pid <= 0 || !outputPath) {
    throw new Error(
      `ssh bg: start returned unexpected output: ${JSON.stringify(stdout)}`,
    );
  }
  return { taskId, pid, outputPath };
}

export function parseLogsOutput(stdout: string): {
  size: number;
  path: string;
  truncated: boolean;
  mode: "tail" | "head" | "full";
  body: string;
} {
  const lines = stdout.split("\n");
  let size = 0;
  let path = "";
  let truncated = false;
  let mode: "tail" | "head" | "full" = "full";
  let bodyStart = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith("SIZE=")) {
      size = Number(line.slice("SIZE=".length).trim()) || 0;
    } else if (line.startsWith("PATH=")) {
      path = line.slice("PATH=".length);
    } else if (line.startsWith("TRUNCATED=")) {
      truncated = line.slice("TRUNCATED=".length).trim() === "1";
    } else if (line.startsWith("MODE=")) {
      const m = line.slice("MODE=".length).trim();
      if (m === "tail" || m === "head" || m === "full") mode = m;
      bodyStart = i + 1;
      break;
    }
  }
  const body = lines.slice(bodyStart).join("\n");
  return { size, path, truncated, mode, body };
}

function rethrowTransport(err: unknown, onTransport?: TransportReporter): never {
  if (err instanceof SshTransportError) onTransport?.(err);
  throw err;
}

async function execScript(
  target: EnabledSshTarget,
  script: string,
  exec: SshExecBufferedFn,
  onTransport?: TransportReporter,
): Promise<ExecResult> {
  try {
    return await exec(target, {
      argv: ["/bin/sh", "-lc", script],
    });
  } catch (err) {
    rethrowTransport(err, onTransport);
  }
}

async function listTaskIds(
  target: EnabledSshTarget,
  sessionId: string,
  exec: SshExecBufferedFn,
  onTransport?: TransportReporter,
): Promise<string[]> {
  const sessionDir = remoteBgSessionDir(target.remoteWorkspace, sessionId);
  const r = await execScript(
    target,
    buildBgListIdsScript(sessionDir),
    exec,
    onTransport,
  );
  if (!r.ok) {
    throw new Error(
      `ssh bg: list tasks failed (exit ${r.exitCode}): ${r.stderr || "no stderr"}`,
    );
  }
  return r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^b[0-9a-f]+$/i.test(l));
}

export async function sshBgRun(
  target: EnabledSshTarget,
  opts: {
    sessionId: string;
    command: string;
    name: string;
    isAgent: boolean;
    description?: string;
    timeoutSeconds?: number;
    cwd: string;
    env?: Record<string, string | undefined>;
    taskId?: string;
  },
  exec: SshExecBufferedFn = sshExecBuffered,
  onTransport?: TransportReporter,
): Promise<{
  task: SshBgTaskSnapshot;
  message: string;
}> {
  const command = opts.command.trim();
  if (!command) throw new Error("Background command is empty");
  const name = opts.name.trim();
  if (!name) throw new Error("bg_run requires name string");
  if (!opts.sessionId) throw new Error("bg_run requires a session id");
  if (!isSafeRemotePath(opts.cwd)) {
    throw new Error(`ssh bg: unsafe remote cwd: ${opts.cwd}`);
  }

  const taskId = opts.taskId ?? newTaskId();
  const taskDir = remoteBgTaskDir(
    target.remoteWorkspace,
    opts.sessionId,
    taskId,
  );
  const script = buildBgStartScript({
    taskDir,
    taskId,
    name,
    command,
    cwd: opts.cwd,
    description: opts.description,
    timeoutSeconds: opts.timeoutSeconds,
    isAgent: opts.isAgent,
    env: opts.env,
  });
  const r = await execScript(target, script, exec, onTransport);
  if (!r.ok) {
    throw new Error(
      `ssh bg: start failed (exit ${r.exitCode}): ${r.stderr || r.stdout || "no stderr"}`,
    );
  }
  const started = parseStartOutput(r.stdout);
  const outputPath = started.outputPath;
  const task: SshBgTaskSnapshot = {
    id: started.taskId,
    name,
    command,
    cwd: opts.cwd,
    outputPath,
    startedAt: new Date().toISOString(),
    status: "running",
    pid: started.pid,
    isAgent: opts.isAgent,
  };
  if (opts.description !== undefined) task.description = opts.description;
  if (opts.timeoutSeconds !== undefined) task.timeoutSeconds = opts.timeoutSeconds;

  const message = [
    `Started background task ${name} (${started.taskId}) on SSH host ${target.host}`,
    `Status: running`,
    `PID: ${started.pid}`,
    `Output: ${outputPath}`,
    `Completion does not wake a follow-up turn; use bg_status / bg_logs to inspect.`,
    `notifyOnCompletion, triggerOnCompletion, and surviveReload are not supported over SSH.`,
  ].join("\n");

  return { task, message };
}

export async function sshBgStatus(
  target: EnabledSshTarget,
  opts: { sessionId: string; taskId?: string },
  exec: SshExecBufferedFn = sshExecBuffered,
  onTransport?: TransportReporter,
): Promise<{ tasks: SshBgTaskSnapshot[]; message: string }> {
  if (!opts.sessionId) throw new Error("bg_status requires a session id");
  const ids = await listTaskIds(target, opts.sessionId, exec, onTransport);
  let selected = ids;
  if (opts.taskId !== undefined) {
    const resolved = resolveTaskId(ids, opts.taskId);
    selected = [resolved];
  }
  // Recent-first: ids are sorted ascending from find; reverse for recent.
  if (opts.taskId === undefined) {
    selected = [...selected].reverse().slice(0, 50);
  }

  const tasks: SshBgTaskSnapshot[] = [];
  for (const id of selected) {
    const taskDir = remoteBgTaskDir(
      target.remoteWorkspace,
      opts.sessionId,
      id,
    );
    const r = await execScript(
      target,
      buildBgStatusScript(taskDir),
      exec,
      onTransport,
    );
    if (!r.ok) {
      throw new Error(
        `ssh bg: status failed for ${id} (exit ${r.exitCode}): ${r.stderr || "no stderr"}`,
      );
    }
    const parsed = parseStatusOutput(r.stdout);
    const meta = parsed.meta;
    const snap: SshBgTaskSnapshot = {
      id,
      name: meta?.name ?? id,
      command: meta?.command ?? "",
      cwd: meta?.cwd ?? target.remoteWorkspace,
      outputPath: meta?.outputPath ?? `${taskDir}/output`,
      startedAt: meta?.startedAt ?? "",
      status: parsed.status,
    };
    if (meta?.description !== undefined) snap.description = meta.description;
    if (meta?.timeoutSeconds !== undefined) snap.timeoutSeconds = meta.timeoutSeconds;
    if (meta?.deadlineAt !== undefined) snap.deadlineAt = meta.deadlineAt;
    if (meta?.isAgent !== undefined) snap.isAgent = meta.isAgent;
    if (parsed.pid !== undefined) snap.pid = parsed.pid;
    if (parsed.exitCode !== undefined) snap.exitCode = parsed.exitCode;
    tasks.push(snap);
  }

  const message =
    tasks.length === 0
      ? "No SSH background tasks for this session."
      : tasks
          .map((t) => {
            const pid = t.pid !== undefined ? ` pid=${t.pid}` : "";
            const ec =
              t.exitCode !== undefined ? ` exit=${t.exitCode}` : "";
            return `${t.id} ${t.status}${pid}${ec} ${t.name} — ${t.outputPath}`;
          })
          .join("\n");

  return { tasks, message };
}

export async function sshBgLogs(
  target: EnabledSshTarget,
  opts: {
    sessionId: string;
    taskId: string;
    maxBytes?: number;
    tail?: boolean;
  },
  exec: SshExecBufferedFn = sshExecBuffered,
  onTransport?: TransportReporter,
): Promise<{
  taskId: string;
  path: string;
  bytesRead: number;
  truncated: boolean;
  tail: boolean;
  message: string;
}> {
  if (!opts.sessionId) throw new Error("bg_logs requires a session id");
  const ids = await listTaskIds(target, opts.sessionId, exec, onTransport);
  const taskId = resolveTaskId(ids, opts.taskId);
  const taskDir = remoteBgTaskDir(
    target.remoteWorkspace,
    opts.sessionId,
    taskId,
  );
  const maxBytes = clampLogBytes(opts.maxBytes);
  const tail = opts.tail !== false;
  const r = await execScript(
    target,
    buildBgLogsScript(taskDir, maxBytes, tail),
    exec,
    onTransport,
  );
  if (!r.ok) {
    if (/missing_output/.test(r.stdout) || /missing_output/.test(r.stderr)) {
      throw new Error(
        `Output file does not exist for ${taskId}: ${taskDir}/output`,
      );
    }
    throw new Error(
      `ssh bg: logs failed for ${taskId} (exit ${r.exitCode}): ${r.stderr || "no stderr"}`,
    );
  }
  const parsed = parseLogsOutput(r.stdout);
  const bytesRead = Buffer.byteLength(parsed.body, "utf8");
  let message: string;
  if (parsed.truncated) {
    const note = `[Showing ${parsed.mode} ${formatSize(bytesRead)} of ${formatSize(parsed.size)}. Full output: ${parsed.path}]`;
    message =
      parsed.mode === "tail"
        ? `${note}\n${parsed.body}`
        : `${parsed.body}\n${note}`;
  } else {
    message = `${parsed.body}\n[Full output: ${parsed.path}]`;
  }
  return {
    taskId,
    path: parsed.path,
    bytesRead,
    truncated: parsed.truncated,
    tail,
    message,
  };
}

export async function sshBgKill(
  target: EnabledSshTarget,
  opts: { sessionId: string; taskId: string },
  exec: SshExecBufferedFn = sshExecBuffered,
  onTransport?: TransportReporter,
): Promise<{ taskId: string; message: string }> {
  if (!opts.sessionId) throw new Error("bg_kill requires a session id");
  const ids = await listTaskIds(target, opts.sessionId, exec, onTransport);
  const taskId = resolveTaskId(ids, opts.taskId);
  const taskDir = remoteBgTaskDir(
    target.remoteWorkspace,
    opts.sessionId,
    taskId,
  );
  const r = await execScript(
    target,
    buildBgKillScript(taskDir),
    exec,
    onTransport,
  );
  if (r.exitCode === 2 || /NOT_RUNNING=/.test(r.stdout)) {
    const m = /NOT_RUNNING=(\S+)/.exec(r.stdout);
    const status = m?.[1] ?? "not running";
    throw new Error(`Task ${taskId} is ${status}, not running`);
  }
  if (!r.ok) {
    throw new Error(
      `ssh bg: kill failed for ${taskId} (exit ${r.exitCode}): ${r.stderr || "no stderr"}`,
    );
  }
  return {
    taskId,
    message: `Killed background task ${taskId} on SSH host ${target.host}. Output: ${taskDir}/output`,
  };
}
