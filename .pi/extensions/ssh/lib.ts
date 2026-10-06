/**
 * Standalone SSH tool backend for Aide.
 *
 * This is a Pi extension helper, not a Gondolin backend. Config lives in
 * the project: `PI_AIDE_SSH_CONFIG`, or `<cwd>/.pi/ssh.json`. It is not
 * read from `~/.pi/agent/ssh.json` and it is not merged with a global
 * file. The extension registers only when `PI_AIDE_SSH=1` (Aide sets
 * that). A missing config file registers nothing. `enabled: true` alone
 * does not. A host must be set explicitly. There is no host
 * auto-discovery. Empty host with SSH requested fails. Tools do not
 * fall back to this machine.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

export const SSH_ENABLE_ENV = "PI_AIDE_SSH";
export const SSH_CONFIG_ENV = "PI_AIDE_SSH_CONFIG";
export const SSH_HOST_ENV = "PI_AIDE_SSH_HOST";
export const SSH_USER_ENV = "PI_AIDE_SSH_USER";
export const SSH_PORT_ENV = "PI_AIDE_SSH_PORT";
export const SSH_IDENTITY_ENV = "PI_AIDE_SSH_IDENTITY_FILE";
export const SSH_REMOTE_WORKSPACE_ENV = "PI_AIDE_SSH_REMOTE_WORKSPACE";
export const SSH_LOCAL_WORKSPACE_ENV = "PI_AIDE_SSH_LOCAL_WORKSPACE";

export const DEFAULT_REMOTE_WORKSPACE = "~/workspace";
/** Tried in order when identityFile is empty. Key files only. Never printed. */
export const DEFAULT_IDENTITY_CANDIDATES = [
  "~/.ssh/id_ed25519",
  "~/.ssh/id_ed25519_sk",
  "~/.ssh/id_ecdsa",
  "~/.ssh/id_rsa",
] as const;

export const DEFAULT_CONNECT_TIMEOUT = 10;
export const DEFAULT_STRICT_HOST_KEY = "accept-new";
export const SSH_STRICT_ENV = "PI_AIDE_SSH_STRICT_HOST_KEY";
export const SSH_KNOWN_HOSTS_ENV = "PI_AIDE_SSH_KNOWN_HOSTS";
export const SSH_CONNECT_TIMEOUT_ENV = "PI_AIDE_SSH_CONNECT_TIMEOUT";
export const SSH_MUX_ENV = "PI_AIDE_SSH_MUX";
export const SSH_MAX_CONCURRENT_ENV = "PI_AIDE_SSH_MAX_CONCURRENT";

/**
 * Cap on concurrent ssh channels per master connection. sshd defaults to
 * `MaxSessions 10`; staying below it keeps mux session opens from being
 * refused under parallel tool calls.
 */
export const DEFAULT_MAX_CONCURRENT = 8;

export type StrictHostKeyChecking = "accept-new" | "yes" | "no";

export type SshJsonConfig = {
  enabled?: boolean;
  host?: string;
  user?: string;
  port?: number;
  identityFile?: string;
  extraSshArgs?: string[];
  remoteWorkspace?: string;
  localWorkspace?: string;
  strictHostKeyChecking?: string;
  knownHostsFile?: string;
  connectTimeout?: number;
  mux?: boolean;
  maxConcurrent?: number;
};

export type DisabledSshTarget = { enabled: false };

export type EnabledSshTarget = {
  enabled: true;
  host: string;
  user?: string;
  port?: number;
  identityFile: string;
  extraSshArgs?: string[];
  remoteWorkspace: string;
  localWorkspace: string;
  strictHostKeyChecking: StrictHostKeyChecking;
  knownHostsFile?: string;
  connectTimeout: number;
  mux: boolean;
  /**
   * Max concurrent ssh channels per master (semaphore in exec.ts).
   * sshd `MaxSessions` defaults to 10; default here is 8.
   */
  maxConcurrent?: number;
  /** Per-process ControlMaster socket. Set by attachControlPath. */
  controlPath?: string;
};

export type SshTarget = DisabledSshTarget | EnabledSshTarget;

export type EnvMap = Record<string, string | undefined>;

export type ResolveSshOptions = {
  defaultLocalWorkspace: string;
  homeDir?: string;
  identityExists?: (file: string) => boolean;
};

function envString(env: EnvMap, key: string): string | undefined {
  const value = env[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function envPort(env: EnvMap, key: string): number | undefined {
  const raw = envString(env, key);
  if (!raw) return undefined;
  return parsePort(raw, key);
}

function parsePort(raw: string | number, label: string): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) {
    throw new Error(
      `ssh: ${label} must be an integer port, got ${JSON.stringify(raw)}`,
    );
  }
  return n;
}

function parseTimeout(raw: string | number, label: string): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > 120) {
    throw new Error(
      `ssh: ${label} must be an integer 1-120 seconds, got ${JSON.stringify(raw)}`,
    );
  }
  return n;
}

function parseMaxConcurrent(
  raw: string | number,
  label: string,
): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 32) {
    throw new Error(
      `ssh: ${label} must be an integer 1-32, got ${JSON.stringify(raw)}`,
    );
  }
  return n;
}

function parseStrictHostKey(raw: string | undefined): StrictHostKeyChecking {
  if (raw === undefined || raw.trim() === "") return DEFAULT_STRICT_HOST_KEY;
  const v = raw.trim().toLowerCase();
  if (v === "accept-new" || v === "yes" || v === "no") return v;
  throw new Error(
    `ssh: strictHostKeyChecking must be accept-new, yes, or no (not ask). Got ${JSON.stringify(raw)}`,
  );
}

function parseMuxFlag(raw: string | undefined, jsonMux: boolean | undefined): boolean {
  if (raw !== undefined) {
    const v = raw.trim().toLowerCase();
    if (v === "1" || v === "true" || v === "on" || v === "yes") return true;
    if (v === "0" || v === "false" || v === "off" || v === "no") return false;
    throw new Error(
      `ssh: ${SSH_MUX_ENV} must be 1 or 0, got ${JSON.stringify(raw)}`,
    );
  }
  if (jsonMux === false) return false;
  return true;
}

function parseEnableFlag(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "on" || v === "yes") return true;
  if (v === "0" || v === "false" || v === "off" || v === "no") return false;
  throw new Error(
    `ssh: ${SSH_ENABLE_ENV} must be 1 or 0, got ${JSON.stringify(raw)}`,
  );
}

export function quoteShell(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

export function expandHome(file: string, homeDir: string = os.homedir()): string {
  if (file === "~") return homeDir;
  if (file.startsWith("~/")) return path.join(homeDir, file.slice(2));
  return file;
}

/**
 * Expand a remoteWorkspace value that starts with `~` using the SSH login
 * user's home (`/home/<user>/...`). Absolute paths pass through unchanged.
 */
export function expandRemoteWorkspace(
  raw: string,
  user: string | undefined,
): string {
  if (raw !== "~" && !raw.startsWith("~/")) return raw;
  if (!user) {
    throw new Error(
      `ssh: remoteWorkspace ${JSON.stringify(raw)} needs user to expand ~ ` +
        `(set user in the SSH config file pointed at by PI_AIDE_SSH_CONFIG, ` +
        `or set PI_AIDE_SSH_USER)`,
    );
  }
  const remoteHome = path.posix.join("/home", user);
  if (raw === "~") return remoteHome;
  return path.posix.join(remoteHome, raw.slice(2));
}

export function sshDestination(target: Pick<EnabledSshTarget, "host" | "user">): string {
  return target.user ? `${target.user}@${target.host}` : target.host;
}

export function isSafeRemotePath(value: string): boolean {
  if (!value.startsWith("/") || value.includes("\0") || /[\n\r]/.test(value)) {
    return false;
  }
  return !value.split("/").includes("..");
}

/**
 * True when a tool path targets the remote skill sync tree at
 * `$HOME/.pi/skills` (or `~/.pi/skills`). Agents must not write/edit there;
 * skill text is changed with skill_edit / skill_file_edit on the host.
 */
export function isRemoteSkillCatalogPath(toolPath: string): boolean {
  const raw = toolPath.trim().replace(/\\/g, "/");
  if (!raw) return false;
  const expanded = raw.startsWith("~/")
    ? raw.slice(1) // -> /.pi/skills/...
    : raw === "~"
      ? "/"
      : raw;
  const normalized = path.posix.normalize(expanded);
  const marker = "/.pi/skills";
  if (normalized === marker || normalized.startsWith(`${marker}/`)) return true;
  const idx = normalized.indexOf(marker);
  if (idx === -1) return false;
  const after = normalized.slice(idx + marker.length);
  return after === "" || after.startsWith("/");
}

export function remoteSkillCatalogRejectError(toolPath: string): Error {
  return new Error(
    `ssh: refusing to modify ${toolPath} under ~/.pi/skills. ` +
      `That tree is a session copy of loaded skills. ` +
      `Change skill text with skill_edit or skill_file_edit; load it with skill_view / skill_file_view.`,
  );
}

/**
 * Map a local workspace path to the matching remote path.
 * This does not copy files. Share the tree with NFS so both sides see
 * the same data. Empty localWorkspace in json means the repo workspace/.
 */
function relInsideRoot(root: string, candidate: string): string | undefined {
  const rel = path.relative(root, candidate);
  if (rel === "") return "";
  if (rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
  return rel;
}

export function toRemotePath(
  localWorkspace: string,
  remoteWorkspace: string,
  localPath: string,
): string {
  const localRoot = path.resolve(localWorkspace);
  // Pi may pass the json string `./workspace` as cwd. Resolve against
  // process.cwd() first so that does not become remote `/workspace/workspace`.
  const fromCwd = path.resolve(localPath);
  const fromRoot = path.isAbsolute(localPath)
    ? path.resolve(localPath)
    : path.resolve(localRoot, localPath);
  const relCwd = relInsideRoot(localRoot, fromCwd);
  const relRoot = relInsideRoot(localRoot, fromRoot);
  const rel = relCwd !== undefined ? relCwd : relRoot;
  if (rel === undefined) {
    throw new Error(`ssh: path escapes workspace: ${localPath}`);
  }
  if (rel === "") return remoteWorkspace;
  const posixRel = rel.split(path.sep).join(path.posix.sep);
  const remote = path.posix.join(remoteWorkspace, posixRel);
  if (!isSafeRemotePath(remote)) {
    throw new Error(`ssh: path escapes workspace: ${localPath}`);
  }
  return remote;
}

/**
 * Map a tool path to the path used on the remote host.
 *
 * Two forms are accepted because read/write/edit run remotely:
 * - local form: absolute inside localWorkspace, or workspace-relative
 *   (relative paths resolve under the workspace root). Mapped to the
 *   matching path under remoteWorkspace.
 * - remote form: any other safe absolute path (the paths the system prompt
 *   advertises). Used as-is, so `~/workspace/...` (resolved absolute) works
 *   from any cwd and a bash `cd /etc` can be followed by read("os-release").
 *
 * Unsafe paths (relative escapes, `..`, NUL, newlines) keep the escape
 * error. A local absolute path wins the ambiguity because workspace
 * containment is checked first.
 */
export function remoteToolPath(
  localWorkspace: string,
  remoteWorkspace: string,
  localPath: string,
): string {
  const localRoot = path.resolve(localWorkspace);
  const asLocal = path.isAbsolute(localPath)
    ? path.resolve(localPath)
    : path.resolve(localRoot, localPath);
  if (relInsideRoot(localRoot, asLocal) !== undefined) {
    return toRemotePath(localWorkspace, remoteWorkspace, localPath);
  }
  if (isSafeRemotePath(localPath)) return localPath;
  throw new Error(`ssh: path escapes workspace: ${localPath}`);
}

/**
 * Resolve a raw read/write/edit `path` argument against the session's last
 * bash cwd, so the file tools agree with bash. Call this with the model's
 * raw argument, before pi's inner tool resolves it against the session cwd.
 *
 * A relative path becomes `<lastCwd>/<path>`, or `<remoteWorkspace>/<path>`
 * when bash has not run yet in this session. Absolute paths and `~` are left
 * for the ops layer (`remoteToolPath`). An unsafe join returns the raw
 * argument unchanged, so a failure still names a path.
 */
export function resolveToolPath(
  rawPath: string,
  lastRemoteCwd: string | undefined,
  remoteWorkspace: string,
): string {
  if (!rawPath || rawPath.startsWith("~") || path.posix.isAbsolute(rawPath)) {
    return rawPath;
  }
  const base =
    lastRemoteCwd && isSafeRemotePath(lastRemoteCwd)
      ? lastRemoteCwd
      : remoteWorkspace;
  const joined = path.posix.normalize(path.posix.join(base, rawPath));
  return isSafeRemotePath(joined) ? joined : rawPath;
}

export function resolveIdentityFile(
  configured: string | undefined,
  opts: {
    homeDir?: string;
    identityExists?: (file: string) => boolean;
  } = {},
): string {
  const homeDir = opts.homeDir ?? os.homedir();
  const exists =
    opts.identityExists ?? ((file: string) => fs.existsSync(file));
  const trimmed = configured?.trim() || undefined;
  const candidates = trimmed ? [trimmed] : [...DEFAULT_IDENTITY_CANDIDATES];
  for (const raw of candidates) {
    const expanded = expandHome(raw, homeDir);
    if (exists(expanded)) return expanded;
  }
  if (trimmed) {
    throw new Error(
      `ssh: identity file not found: ${expandHome(trimmed, homeDir)}`,
    );
  }
  throw new Error(
    "ssh: no default key found under ~/.ssh (tried id_ed25519, id_ed25519_sk, id_ecdsa, id_rsa). Set identityFile in .pi/ssh.json or PI_AIDE_SSH_IDENTITY_FILE",
  );
}

export function controlSocketPath(opts: {
  host: string;
  user?: string;
  port?: number;
  pid: number;
  cacheDir: string;
}): string {
  const key = `${opts.user ?? ""}@${opts.host}:${opts.port ?? 22}`;
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 16);
  return path.join(opts.cacheDir, `cm-${hash}-${opts.pid}`);
}

export function muxExecArgs(controlPath: string): string[] {
  return [
    "-o",
    "ControlMaster=auto",
    "-o",
    `ControlPath=${controlPath}`,
    "-o",
    // Bounded, not `yes`: a pi process killed before its exit hook leaves
    // the master running forever (reparented to init), holding a TCP
    // connection and answering auth failures from mux state the host
    // never sees again. 600s idle lets such orphans self-terminate.
    "ControlPersist=600",
  ];
}

export function muxCtlArgs(controlPath: string): string[] {
  return ["-o", `ControlPath=${controlPath}`];
}

export function sshAuthArgs(target: EnabledSshTarget): string[] {
  const args = [
    "-o",
    "BatchMode=yes",
    "-o",
    "PasswordAuthentication=no",
    "-o",
    "KbdInteractiveAuthentication=no",
    "-o",
    "PreferredAuthentications=publickey",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "RequestTTY=no",
    "-o",
    `StrictHostKeyChecking=${target.strictHostKeyChecking}`,
    "-o",
    `ConnectTimeout=${target.connectTimeout}`,
    "-o",
    "ServerAliveInterval=30",
    "-o",
    "ServerAliveCountMax=3",
  ];
  if (target.knownHostsFile) {
    args.push("-o", `UserKnownHostsFile=${target.knownHostsFile}`);
  }
  if (target.port) args.push("-p", String(target.port));
  args.push("-i", target.identityFile);
  if (target.extraSshArgs) args.push(...target.extraSshArgs);
  return args;
}

export function buildMuxCtlArgv(
  target: EnabledSshTarget,
  op: "check" | "exit",
): string[] {
  if (!target.controlPath) {
    throw new Error("ssh: ControlMaster check/exit needs controlPath");
  }
  return [
    "ssh",
    ...sshAuthArgs(target),
    ...muxCtlArgs(target.controlPath),
    "-O",
    op,
    sshDestination(target),
  ];
}

export function buildBootstrapArgv(
  target: EnabledSshTarget,
): string[] {
  // One tiny exclusive connection that exists only to start the
  // ControlMaster. Concurrent callers wait on the in-process bootstrap
  // lock instead of racing to open their own TCP connections — a burst
  // of unauthenticated connections trips sshd MaxStartups and (on
  // OpenSSH 10+) PerSourcePenalties, which then rejects valid keys.
  const mux = target.mux !== false && target.controlPath
    ? muxExecArgs(target.controlPath)
    : [];
  return [
    "ssh",
    ...sshAuthArgs(target),
    ...mux,
    sshDestination(target),
    "true",
  ];
}

export function buildSshArgv(
  target: EnabledSshTarget,
  remoteCommand: string,
): string[] {
  const mux = target.mux !== false && target.controlPath
    ? muxExecArgs(target.controlPath)
    : [];
  // OpenSSH joins every argv after the destination with spaces. Splitting
  // `bash`, `-lc`, and the script makes the remote shell run `bash -lc set -eu`
  // which is `set` with no operands — a full env dump to stdout. Use bash so
  // the inline cwd/history wrap can run `history -r`.
  return [
    "ssh",
    ...sshAuthArgs(target),
    ...mux,
    sshDestination(target),
    `bash -lc ${quoteShell(remoteCommand)}`,
  ];
}

/**
 * Env keys the remote shell must own. Host values leak the wrong machine:
 * `HOME`/`USER`/`LOGNAME`/`SHELL` name the wrong account, and `PWD`/`OLDPWD`
 * are host directories — the local `OLDPWD` makes `cd -` in a remote command
 * jump to a path that does not exist on the remote host.
 */
const HOST_OWNED_ENV_KEYS = new Set([
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "PWD",
  "OLDPWD",
]);

export function sanitizeRemoteEnv(
  env?: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!env) return out;
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string") continue;
    if (HOST_OWNED_ENV_KEYS.has(key)) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    out[key] = value;
  }
  return out;
}

export function buildRemoteScript(opts: {
  argv?: string[];
  /** Inline bash body (cwd/history wrap). Do not exec a nested `bash -lc`. */
  script?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
}): string {
  const inline = opts.script !== undefined;
  if (!inline && (!opts.argv || opts.argv.length === 0)) {
    throw new Error("ssh: remote argv is empty");
  }
  const lines: string[] = [];
  if (!inline) {
    lines.push("set -eu");
  }
  if (opts.cwd) {
    if (!isSafeRemotePath(opts.cwd)) {
      throw new Error(`ssh: unsafe remote cwd: ${opts.cwd}`);
    }
    const quoted = quoteShell(opts.cwd);
    if (inline) {
      lines.push(`if [ -d ${quoted} ]; then cd -- ${quoted}; fi`);
    } else {
      lines.push(`cd -- ${quoted}`);
    }
  }
  const env = sanitizeRemoteEnv(opts.env);
  for (const [key, value] of Object.entries(env)) {
    lines.push(`export ${key}=${quoteShell(value)}`);
  }
  if (inline) {
    lines.push(opts.script!);
  } else {
    lines.push(`exec ${opts.argv!.map(quoteShell).join(" ")}`);
  }
  return lines.join("\n");
}

export function classifySshFailure(
  exitCode: number | null,
  stderr: string,
): "transport" | "remote" {
  if (exitCode === 255) return "transport";
  // The ssh client itself prefixes transport-level auth refusals with
  // `ssh: `. Remote stderr (docker, sh, …) can legitimately contain
  // `permission denied` — e.g. `sh: can't create /m/b.txt: Permission
  // denied` from a bind-mounted volume — and must stay a remote failure.
  // Scoping the match to client-issued lines keeps that out.
  if (
    /(^|\n)ssh:\s/i.test(stderr) &&
    /permission denied|connection refused|could not resolve|name or service not known|host key verification failed|connection timed out|no matching (host )?key|identity file .* not accessible|broken pipe|connection reset|connection closed by remote host|session open refused by peer|mux_client_request_session/i.test(
      stderr,
    )
  ) {
    return "transport";
  }
  return "remote";
}

export function formatTransportError(
  target: EnabledSshTarget,
  exitCode: number | null,
  stderr: string,
): string {
  const dest = sshDestination(target);
  const detail = stderr.trim();
  if (/session open refused by peer|mux_client_request_session/i.test(detail)) {
    return (
      `ssh: mux session refused by ${dest} — too many concurrent channels ` +
      `on the master connection (sshd MaxSessions). ${detail}`
    );
  }
  if (/(^|\n)ssh:\s/i.test(detail) && /permission denied/i.test(detail)) {
    return (
      `ssh: publickey auth refused for ${dest} ` +
      `(identity ${target.identityFile}). Password prompts are disabled. ` +
      `If the key is valid, the host may be rate-limiting this source IP ` +
      `(OpenSSH PerSourcePenalties, default-on since 10.0) after a ` +
      `connection burst — wait ~2 minutes and retry.`
    );
  }
  if (
    /connection (reset|closed)|kex_exchange_identification/i.test(detail)
  ) {
    return (
      `ssh: connection to ${dest} dropped before the session started ` +
      `(possible sshd MaxStartups drop or per-source rate limit under a ` +
      `connection burst). ${detail}`
    );
  }
  if (/host key verification failed/i.test(detail)) {
    return (
      `ssh: host key check failed for ${dest}. ` +
      `Set knownHostsFile or run ssh-keyscan for this host.`
    );
  }
  const extra = detail ? `: ${detail}` : "";
  return `ssh: transport to ${dest} failed (exit ${exitCode ?? "null"})${extra}`;
}

export function formatSpawnError(err: unknown): string {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ENOENT") return "ssh: ssh binary not found on PATH";
  const msg = err instanceof Error ? err.message : String(err);
  return `ssh: failed to spawn ssh (${msg})`;
}

export function resolveSshTarget(
  config: SshJsonConfig,
  env: EnvMap,
  opts: ResolveSshOptions,
): SshTarget {
  const envEnabled = parseEnableFlag(envString(env, SSH_ENABLE_ENV));
  const enabled = envEnabled ?? Boolean(config.enabled);
  if (!enabled) return { enabled: false };

  const host = envString(env, SSH_HOST_ENV) ?? config.host?.trim();
  if (!host) {
    throw new Error(
      "ssh: enabled, but host is empty. Set host in .pi/ssh.json or PI_AIDE_SSH_HOST. No auto-discovery.",
    );
  }

  const extraSshArgs = config.extraSshArgs;
  if (extraSshArgs && extraSshArgs.some((a) => typeof a !== "string")) {
    throw new Error("ssh: extraSshArgs must be an array of strings");
  }

  const port = envPort(env, SSH_PORT_ENV) ??
    (config.port !== undefined ? parsePort(config.port, "port") : undefined);
  const homeDir = opts.homeDir ?? os.homedir();
  const identityFile = resolveIdentityFile(
    envString(env, SSH_IDENTITY_ENV) ?? config.identityFile,
    { homeDir, identityExists: opts.identityExists },
  );

  const user = envString(env, SSH_USER_ENV) ?? config.user?.trim();

  const remoteWorkspaceRaw =
    envString(env, SSH_REMOTE_WORKSPACE_ENV) ??
    config.remoteWorkspace?.trim() ??
    DEFAULT_REMOTE_WORKSPACE;
  const remoteWorkspace = expandRemoteWorkspace(remoteWorkspaceRaw, user);
  if (!isSafeRemotePath(remoteWorkspace)) {
    throw new Error(
      `ssh: remoteWorkspace must be an absolute path (or ~/... with user set) without .., got ${JSON.stringify(remoteWorkspaceRaw)}`,
    );
  }

  const localRaw =
    envString(env, SSH_LOCAL_WORKSPACE_ENV) ??
    config.localWorkspace?.trim() ??
    "";
  const localWorkspace = path.resolve(
    localRaw ? expandHome(localRaw, homeDir) : opts.defaultLocalWorkspace,
  );

  const knownRaw =
    envString(env, SSH_KNOWN_HOSTS_ENV) ?? config.knownHostsFile?.trim();
  const timeoutRaw =
    envString(env, SSH_CONNECT_TIMEOUT_ENV) ?? config.connectTimeout;

  const target: EnabledSshTarget = {
    enabled: true,
    host,
    identityFile,
    remoteWorkspace,
    localWorkspace,
    strictHostKeyChecking: parseStrictHostKey(
      envString(env, SSH_STRICT_ENV) ?? config.strictHostKeyChecking,
    ),
    connectTimeout:
      timeoutRaw === undefined || timeoutRaw === ""
        ? DEFAULT_CONNECT_TIMEOUT
        : parseTimeout(timeoutRaw, "connectTimeout"),
    mux: parseMuxFlag(envString(env, SSH_MUX_ENV), config.mux),
  };
  const maxConcurrentRaw =
    envString(env, SSH_MAX_CONCURRENT_ENV) ?? config.maxConcurrent;
  if (maxConcurrentRaw !== undefined) {
    target.maxConcurrent = parseMaxConcurrent(maxConcurrentRaw, "maxConcurrent");
  }
  if (user) target.user = user;
  if (port !== undefined) target.port = port;
  if (extraSshArgs && extraSshArgs.length > 0) target.extraSshArgs = extraSshArgs;
  if (knownRaw) target.knownHostsFile = expandHome(knownRaw, homeDir);
  return target;
}

export function loadSshJson(file: string): SshJsonConfig {
  if (!fs.existsSync(file)) return {};
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    throw new Error(`ssh: cannot read ${file}: ${msg(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (err) {
    throw new Error(`ssh: ${file} is not valid JSON: ${msg(err)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`ssh: ${file} must be a JSON object`);
  }
  return parsed as SshJsonConfig;
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function sshStatusLabel(target: EnabledSshTarget): string {
  return sshDestination(target);
}

/**
 * Historical layout: the extension lived at `<repo>/.pi/extensions/ssh/`.
 * Two `..` from that dir is `.pi`, not the repo. That produced
 * `.pi/.pi/ssh.json`, an empty config, and silent local tools.
 * The installed copy lives outside the project, so the factory uses
 * `process.cwd()` instead of this helper.
 */
export function repoRootFromSshExtensionDir(extensionDir: string): string {
  return path.resolve(extensionDir, "..", "..", "..");
}

/**
 * Register only when Aide set PI_AIDE_SSH=1 and this file is the copy
 * that should load. A project file at `<cwd>/.pi/extensions/ssh/index.ts`
 * wins over the global copy. Decided on each call so /reload cannot
 * stick a process-wide skip. Does not read ~/.pi/agent/ssh.json.
 */
export function shouldRegisterSsh(
  extensionFile: string,
  cwd: string,
  env: EnvMap,
  exists: (file: string) => boolean = fs.existsSync,
): boolean {
  if (!sshWasRequested(env)) return false;
  const project = path.resolve(cwd, ".pi", "extensions", "ssh", "index.ts");
  if (exists(project) && path.resolve(extensionFile) !== project) return false;
  return true;
}

export function sshJsonPath(repoRoot: string): string {
  return path.join(repoRoot, ".pi", "ssh.json");
}

/** PI_AIDE_SSH_CONFIG when set; otherwise `<cwd>/.pi/ssh.json`. Never ~/.pi/agent. */
export function resolveSshConfigFile(
  repoRoot: string,
  env: EnvMap = {},
): string {
  const override = envString(env, SSH_CONFIG_ENV);
  if (override) {
    return path.isAbsolute(override)
      ? override
      : path.join(repoRoot, override);
  }
  return sshJsonPath(repoRoot);
}

export function sshWasRequested(env: EnvMap): boolean {
  return parseEnableFlag(envString(env, SSH_ENABLE_ENV)) === true;
}

/** PI_AIDE_SSH=1 or json enabled:true, unless PI_AIDE_SSH=0. */
export function sshIntended(env: EnvMap, config: SshJsonConfig): boolean {
  const envEnabled = parseEnableFlag(envString(env, SSH_ENABLE_ENV));
  if (envEnabled === false) return false;
  return envEnabled === true || Boolean(config.enabled);
}

/** Local builtins stay only when SSH is not intended. */
export function allowLocalToolFallback(
  env: EnvMap,
  config: SshJsonConfig = {},
): boolean {
  return !sshIntended(env, config);
}

export function sshRuntimeMarker(target: EnabledSshTarget): string {
  return (
    `[ssh-runtime] Tools run on SSH host ${sshStatusLabel(target)}. ` +
    `This is not the Gondolin VM. Paths under the local workspace map to ${target.remoteWorkspace}. ` +
    `Scripts from loaded skills are at ~/.pi/skills/<path>/ on that host. ` +
    `Load skill text with skill_view / skill_file_view. ` +
    `Change skill text with skill_edit / skill_file_edit — write and edit refuse ~/.pi/skills.`
  );
}

export function sshFailMarker(reason: string): string {
  return (
    `[ssh-runtime] FAIL: ${reason} ` +
    `Tools will not run on this machine. Fix host in .pi/ssh.json or PI_AIDE_SSH_HOST.`
  );
}

export function sshRefuseLocalError(reason: string): Error {
  return new Error(
    `ssh: refusing local tool execution. ${reason} ` +
      `Tools must run on the SSH host. No host-direct fallback.`,
  );
}

