/**
 * Per-session bash cwd + HISTFILE for the SSH tool backend.
 *
 * Same layout as Gondolin: `{workspace}/.pi/shell-state/<session-id>/{cwd,history}`.
 * SSH adds an `oldpwd` file so `cd -` keeps persistent-shell meaning across
 * calls; the remote wrapper writes it alongside `cwd`.
 * Gondolin writes those files on the VM mount (host and guest are one tree).
 * SSH bash runs on the remote host, so the wrapper writes HISTFILE and cwd
 * there. After each exec, this module mirrors both files onto localWorkspace
 * so `/fork`, `--continue`, and the system prompt still work when the trees
 * are not NFS-shared. Format stays Gondolin-compatible.
 *
 * This is not a Gondolin import. Env prefix for the backend is PI_AIDE_SSH*.
 */

import fs from "node:fs";
import path from "node:path";

import { isSafeRemotePath, quoteShell } from "./lib.ts";

export type CatRemote = (remotePath: string) => Promise<string | undefined>;

export function sanitizeSessionId(id: string): string {
  const s = id.replace(/[^A-Za-z0-9._-]/g, "") || "unknown";
  if (s === "." || s === "..") return "unknown";
  return s;
}

export function hostShellStateDir(
  localWorkspace: string,
  sessionId: string,
): string {
  return path.join(
    localWorkspace,
    ".pi",
    "shell-state",
    sanitizeSessionId(sessionId),
  );
}

export function remoteShellStateDir(
  remoteWorkspace: string,
  sessionId: string,
): string {
  return path.posix.join(
    remoteWorkspace,
    ".pi",
    "shell-state",
    sanitizeSessionId(sessionId),
  );
}

export function normalizeHistoryLine(command: string): string {
  return command.replace(/[ \t]+$/gm, "").replace(/\s+$/, "");
}

export function cwdFromCatOutput(stdout: string): string | undefined {
  const line = stdout.split("\n")[0]?.trim() ?? "";
  return isSafeRemotePath(line) ? line : undefined;
}

export function readPersistedCwd(
  localWorkspace: string,
  sessionId: string,
): string | undefined {
  try {
    const raw = fs.readFileSync(
      path.join(hostShellStateDir(localWorkspace, sessionId), "cwd"),
      "utf8",
    );
    return cwdFromCatOutput(raw);
  } catch {
    return undefined;
  }
}

export function persistCwd(
  localWorkspace: string,
  sessionId: string,
  cwd: string,
): void {
  if (!isSafeRemotePath(cwd)) return;
  const dir = hostShellStateDir(localWorkspace, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "cwd"), `${cwd}\n`);
}

export function persistHistory(
  localWorkspace: string,
  sessionId: string,
  content: string,
): void {
  const dir = hostShellStateDir(localWorkspace, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "history"), content);
}

/** Gondolin-compatible local HISTFILE append. Tests use this; bash ops pull. */
export function appendShellHistory(
  localWorkspace: string,
  sessionId: string,
  command: string,
): void {
  const dir = hostShellStateDir(localWorkspace, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(
    path.join(dir, "history"),
    normalizeHistoryLine(command) + "\n",
  );
}

export function copyShellState(
  localWorkspace: string,
  fromId: string,
  toId: string,
): void {
  if (!fromId || !toId || fromId === toId) return;
  const src = hostShellStateDir(localWorkspace, fromId);
  const dst = hostShellStateDir(localWorkspace, toId);
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dst, { recursive: true });
  for (const name of ["cwd", "history"] as const) {
    const from = path.join(src, name);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(dst, name));
  }
}

export function remoteCopyShellStateScript(
  remoteWorkspace: string,
  fromId: string,
  toId: string,
): string | undefined {
  if (!fromId || !toId || fromId === toId) return undefined;
  const src = remoteShellStateDir(remoteWorkspace, fromId);
  const dst = remoteShellStateDir(remoteWorkspace, toId);
  const srcCwd = path.posix.join(src, "cwd");
  const srcHist = path.posix.join(src, "history");
  const srcOldpwd = path.posix.join(src, "oldpwd");
  const dstCwd = path.posix.join(dst, "cwd");
  const dstHist = path.posix.join(dst, "history");
  const dstOldpwd = path.posix.join(dst, "oldpwd");
  return [
    `if [ -d ${quoteShell(src)} ]; then`,
    `  mkdir -p ${quoteShell(dst)}`,
    `  if [ -f ${quoteShell(srcCwd)} ]; then cp -f ${quoteShell(srcCwd)} ${quoteShell(dstCwd)}; fi`,
    `  if [ -f ${quoteShell(srcHist)} ]; then cp -f ${quoteShell(srcHist)} ${quoteShell(dstHist)}; fi`,
    `  if [ -f ${quoteShell(srcOldpwd)} ]; then cp -f ${quoteShell(srcOldpwd)} ${quoteShell(dstOldpwd)}; fi`,
    `fi`,
  ].join("\n");
}

export function sessionIdFromSessionFile(
  file: string | undefined,
): string | undefined {
  if (!file) return undefined;
  try {
    const first = fs.readFileSync(file, "utf8").split("\n")[0] ?? "";
    const header = JSON.parse(first) as { id?: unknown };
    if (typeof header.id === "string" && header.id) return header.id;
  } catch {
    // fall through to the filename
  }
  const base = path.basename(file, ".jsonl");
  const i = base.indexOf("_");
  return i >= 0 ? base.slice(i + 1) : undefined;
}

/**
 * Restore last cwd, append the user command to HISTFILE, then `history -r`.
 * History stays off (`bash -lc` default) so wrapper lines are not recorded.
 * Gondolin appends HISTFILE from Node on the shared mount. SSH appends inside
 * this wrapper so the remote HISTFILE is correct without a file copy tool.
 *
 * OLDPWD is restored from its own sidecar so `cd -` keeps persistent-shell
 * meaning across calls. Without it, and because pi exports the host
 * environment, `cd -` used to jump to the host's directory (see
 * sanitizeRemoteEnv, which now drops PWD/OLDPWD).
 */
export function wrapBashWithSessionCwd(
  command: string,
  remoteWorkspace: string,
  sessionId: string,
): string {
  const dir = remoteShellStateDir(remoteWorkspace, sessionId);
  const cwdFile = path.posix.join(dir, "cwd");
  const oldpwdFile = path.posix.join(dir, "oldpwd");
  const histFile = path.posix.join(dir, "history");
  const line = normalizeHistoryLine(command);
  return [
    `mkdir -p ${quoteShell(dir)}`,
    `printf '%s\\n' ${quoteShell(line)} >> ${quoteShell(histFile)}`,
    `export HISTFILE=${quoteShell(histFile)}`,
    `export HISTSIZE=5000 HISTFILESIZE=5000`,
    `history -r ${quoteShell(histFile)} 2>/dev/null || true`,
    `if [ -s ${quoteShell(cwdFile)} ]; then`,
    `  IFS= read -r __pi_last < ${quoteShell(cwdFile)} || true`,
    `  if [ -n "$__pi_last" ] && [ -d "$__pi_last" ]; then`,
    `    cd -- "$__pi_last" || true`,
    `  fi`,
    `  unset __pi_last`,
    `fi`,
    // Restore after the cd above, which overwrites OLDPWD.
    `if [ -s ${quoteShell(oldpwdFile)} ]; then`,
    `  IFS= read -r __pi_prev < ${quoteShell(oldpwdFile)} || true`,
    `  if [ -n "$__pi_prev" ]; then`,
    `    export OLDPWD=$__pi_prev`,
    `  fi`,
    `  unset __pi_prev`,
    `fi`,
    `__pi_save_cwd() { pwd > ${quoteShell(cwdFile)} 2>/dev/null || true; printf '%s\\n' "\${OLDPWD-}" > ${quoteShell(oldpwdFile)} 2>/dev/null || true; }`,
    `trap __pi_save_cwd EXIT`,
    command,
  ].join("\n");
}

export async function pullRemoteSidecars(
  localWorkspace: string,
  sessionId: string,
  remoteWorkspace: string,
  catRemote: CatRemote,
): Promise<{ cwd?: string }> {
  const remoteDir = remoteShellStateDir(remoteWorkspace, sessionId);
  const cwdRaw = await catRemote(path.posix.join(remoteDir, "cwd"));
  const cwd = cwdRaw !== undefined ? cwdFromCatOutput(cwdRaw) : undefined;
  if (cwd) persistCwd(localWorkspace, sessionId, cwd);
  const hist = await catRemote(path.posix.join(remoteDir, "history"));
  if (hist !== undefined) persistHistory(localWorkspace, sessionId, hist);
  return { cwd };
}
