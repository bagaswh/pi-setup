/**
 * Pi extension: run read/write/edit/bash/ls/find/grep and bg_run /
 * bg_status / bg_logs / bg_kill on a remote host over SSH.
 *
 * Peer of Gondolin, not a child of it. No VM, no gondolin.json, no
 * Gondolin imports. Registers only when `PI_AIDE_SSH=1` (Aide sets
 * that for this project). Config is `PI_AIDE_SSH_CONFIG` or
 * `<cwd>/.pi/ssh.json`. A missing file, or any other value of
 * `PI_AIDE_SSH`, registers nothing and prints nothing.
 * `~/.pi/agent/ssh.json` is not read. Empty host or transport failure
 * refuses local tools. Restart pi after config changes.
 *
 * Bash cwd + command log are keyed by pi session id, same files as
 * Gondolin: `{workspace}/.pi/shell-state/<id>/{cwd,history}`. The
 * wrapper writes them on the remote host. After each exec they are
 * mirrored under localWorkspace.
 *
 * read/write/edit/ls/find/grep keep no cwd of their own. They read the
 * last bash cwd (that same sidecar) and resolve a relative `path`
 * against it, so the tools agree on one working directory. Failures
 * print the absolute remote path that was attempted.
 *
 * bg_* start a detached remote process (setsid when available) under
 * `{remoteWorkspace}/.pi/ssh-bg/<sessionId>/<taskId>/`. Same names as
 * pi-background-tasks. Pi hard-fails when a second extension registers the
 * same tool name, so Aide's `.pi/settings.json` disables that package's
 * `background-tasks.js` while SSH is on (see syncPackageFilters in the Go
 * launcher). Not registered on refuse-local / SSH-off — Gondolin
 * launches drop the filter so the package host tools remain. Completion does
 * not wake a follow-up turn — callers use bg_status / bg_logs.
 *
 * Host-only tools that cannot be remoted (pi-fff's native index, TTY
 * pickers, etc.) are left alone — see ops.ts.
 *
 * Session start copies the skills this process loaded (`--skill`) to
 * `$HOME/.pi/skills/<path>/` on the SSH host, companion files included.
 * The remote directory is replaced so it matches this session.
 * write and edit refuse paths under that tree — change skill text with
 * skill_edit / skill_file_edit on the host.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  type BashOperations,
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  type EditOperations,
  type ReadOperations,
  type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { GrepToolInput } from "./ops.ts";

import {
  formatSize,
  MAX_LOG_BYTES,
  sshBgKill,
  sshBgLogs,
  sshBgRun,
  sshBgStatus,
} from "./bg.ts";
import { sshExec, sshExecBuffered, SshTransportError } from "./exec.ts";
import {
  isRemoteSkillCatalogPath,
  isSafeRemotePath,
  loadSshJson,
  quoteShell,
  remoteSkillCatalogRejectError,
  remoteToolPath,
  resolveSshConfigFile,
  resolveSshTarget,
  resolveToolPath,
  shouldRegisterSsh,
  sshFailMarker,
  sshIntended,
  sshRefuseLocalError,
  sshRuntimeMarker,
  sshStatusLabel,
  toRemotePath,
  type EnabledSshTarget,
} from "./lib.ts";
import {
  createSshFindOps,
  createSshLsOps,
  executeSshGrep,
} from "./ops.ts";
import { createReadMultipleTool } from "./read-multiple.ts";
import {
  attachControlPath,
  closeControlMasterSync,
  installMuxExitHook,
} from "./mux.ts";
import {
  copyShellState,
  pullRemoteSidecars,
  readPersistedCwd,
  remoteCopyShellStateScript,
  sessionIdFromSessionFile,
  wrapBashWithSessionCwd,
} from "./shell-state.ts";
import { skillDirsFromArgv, syncSkillsToRemoteHome } from "./sync-skills.ts";

function projectRoot(): string {
  return process.cwd();
}

function sshConfigPath(): string {
  return resolveSshConfigFile(projectRoot(), process.env);
}

async function catRemoteFile(
  target: EnabledSshTarget,
  remoteFile: string,
): Promise<string | undefined> {
  const got = await sshExecBuffered(target, {
    argv: ["/bin/cat", remoteFile],
  });
  if (!got.ok) return undefined;
  return got.stdout;
}

type TransportReporter = (err: unknown) => void;

function rethrowTransport(err: unknown, onTransport: TransportReporter): never {
  if (err instanceof SshTransportError) onTransport(err);
  throw err;
}

/**
 * Resolve a raw read/write/edit `path` argument against the session's last
 * bash cwd, so the file tools agree with bash. The registered-tool wrapper
 * sees the model's raw argument, before pi's inner tool resolves it against
 * the session cwd. Failures print the absolute remote path in the ops layer.
 */
function resolveToolPathParam(
  target: EnabledSshTarget,
  sessionId: string | undefined,
  rawPath: string,
): string {
  const lastCwd = sessionId
    ? readPersistedCwd(target.localWorkspace, sessionId)
    : undefined;
  return resolveToolPath(rawPath, lastCwd, target.remoteWorkspace);
}

type PathToolParams = { path: string } & Record<string, unknown>;

/**
 * Remote absolute path the model can act on, even when the inner pi tool
 * throws before the ops layer maps anything.
 */
function reportedRemotePath(
  target: EnabledSshTarget,
  resolvedPath: string,
): string {
  try {
    return remoteToolPath(
      target.localWorkspace,
      target.remoteWorkspace,
      resolvedPath,
    );
  } catch {
    return resolvedPath;
  }
}

/**
 * Every read/write/edit failure must name the absolute remote path.
 * Ops errors already carry it; pi's own errors (edit mismatch, read offset)
 * carry the raw argument or nothing. Appending is idempotent.
 */
function withAbsolutePath(err: unknown, absolutePath: string): Error {
  const message = err instanceof Error ? err.message : String(err);
  if (!absolutePath || message.includes(absolutePath)) {
    return err instanceof Error ? err : new Error(message);
  }
  return new Error(`${message} (absolute path: ${absolutePath})`);
}

/** Resolve the raw path against the bash cwd, run the tool, name the path on failure. */
async function runWithPathContext<T>(
  target: EnabledSshTarget,
  sessionId: string | undefined,
  rawPath: string,
  run: (resolvedPath: string) => Promise<T>,
): Promise<T> {
  const resolvedPath = resolveToolPathParam(target, sessionId, rawPath);
  try {
    return await run(resolvedPath);
  } catch (err) {
    throw withAbsolutePath(err, reportedRemotePath(target, resolvedPath));
  }
}

/**
 * Like runWithPathContext, but refuses write/edit under the remote
 * ~/.pi/skills tree (session copy of loaded skills).
 */
async function runMutatingPathContext<T>(
  target: EnabledSshTarget,
  sessionId: string | undefined,
  rawPath: string,
  run: (resolvedPath: string) => Promise<T>,
): Promise<T> {
  const resolvedPath = resolveToolPathParam(target, sessionId, rawPath);
  let remotePath: string;
  try {
    remotePath = reportedRemotePath(target, resolvedPath);
  } catch {
    remotePath = resolvedPath;
  }
  if (
    isRemoteSkillCatalogPath(rawPath) ||
    isRemoteSkillCatalogPath(resolvedPath) ||
    isRemoteSkillCatalogPath(remotePath)
  ) {
    throw remoteSkillCatalogRejectError(remotePath || rawPath);
  }
  try {
    return await run(resolvedPath);
  } catch (err) {
    throw withAbsolutePath(err, remotePath);
  }
}

function createSshReadOps(
  target: EnabledSshTarget,
  onTransport: TransportReporter,
): ReadOperations {
  const map = (p: string) =>
    remoteToolPath(target.localWorkspace, target.remoteWorkspace, p);
  return {
    readFile: async (p) => {
      const remotePath = map(p);
      let r;
      try {
        r = await sshExecBuffered(target, {
          argv: ["/bin/cat", remotePath],
        });
      } catch (err) {
        rethrowTransport(err, onTransport);
      }
      if (!r!.ok) {
        throw new Error(
          `read failed for ${remotePath} (exit ${r!.exitCode}): ${r!.stderr}`,
        );
      }
      return r!.stdoutBuffer;
    },
    access: async (p) => {
      const remotePath = map(p);
      let r;
      try {
        r = await sshExecBuffered(target, {
          argv: ["/bin/sh", "-lc", `test -r ${quoteShell(remotePath)}`],
        });
      } catch (err) {
        rethrowTransport(err, onTransport);
      }
      if (!r!.ok) {
        throw new Error(`not readable: ${remotePath}`);
      }
    },
    detectImageMimeType: async (p) => {
      const remotePath = map(p);
      try {
        const r = await sshExecBuffered(target, {
          argv: [
            "/bin/sh",
            "-lc",
            `file --mime-type -b ${quoteShell(remotePath)}`,
          ],
        });
        if (!r.ok) return null;
        const m = r.stdout.trim();
        return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(m)
          ? m
          : null;
      } catch (err) {
        if (err instanceof SshTransportError) onTransport(err);
        return null;
      }
    },
  };
}

function createSshWriteOps(
  target: EnabledSshTarget,
  onTransport: TransportReporter,
): WriteOperations {
  const map = (p: string) =>
    remoteToolPath(target.localWorkspace, target.remoteWorkspace, p);
  return {
    writeFile: async (p, content) => {
      const remotePath = map(p);
      const dir = path.posix.dirname(remotePath);
      const b64 = Buffer.from(content, "utf8").toString("base64");
      const script = [
        `set -eu`,
        `mkdir -p ${quoteShell(dir)}`,
        `echo ${quoteShell(b64)} | base64 -d > ${quoteShell(remotePath)}`,
      ].join("\n");
      let r;
      try {
        r = await sshExecBuffered(target, {
          argv: ["/bin/sh", "-lc", script],
        });
      } catch (err) {
        rethrowTransport(err, onTransport);
      }
      if (!r!.ok) {
        throw new Error(
          `write failed for ${remotePath} (exit ${r!.exitCode}): ${r!.stderr}`,
        );
      }
    },
    mkdir: async (dir) => {
      const remoteDir = map(dir);
      let r;
      try {
        r = await sshExecBuffered(target, {
          argv: ["/bin/mkdir", "-p", remoteDir],
        });
      } catch (err) {
        rethrowTransport(err, onTransport);
      }
      if (!r!.ok) {
        throw new Error(
          `mkdir failed for ${remoteDir} (exit ${r!.exitCode}): ${r!.stderr}`,
        );
      }
    },
  };
}

function createSshEditOps(
  target: EnabledSshTarget,
  onTransport: TransportReporter,
): EditOperations {
  const r = createSshReadOps(target, onTransport);
  const w = createSshWriteOps(target, onTransport);
  return { readFile: r.readFile, access: r.access, writeFile: w.writeFile };
}

function createSshBashOps(
  target: EnabledSshTarget,
  onTransport: TransportReporter,
  sessionId?: string,
): BashOperations {
  return {
    exec: async (command, cwd, { onData, signal, timeout, env }) => {
      const remoteCwd = toRemotePath(
        target.localWorkspace,
        target.remoteWorkspace,
        cwd,
      );
      const sid = sessionId || env?.PI_SESSION_ID;
      const wrapped =
        sid && sid.length > 0
          ? wrapBashWithSessionCwd(command, target.remoteWorkspace, sid)
          : command;

      const ac = new AbortController();
      const onAbort = () => ac.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      let timedOut = false;
      const timer =
        timeout && timeout > 0
          ? setTimeout(() => {
            timedOut = true;
            ac.abort();
          }, timeout * 1000)
          : undefined;

      try {
        const proc = sshExec(target, {
          script: wrapped,
          cwd: remoteCwd,
          env,
          signal: ac.signal,
        });
        for await (const chunk of proc.output()) {
          onData(chunk.data);
        }
        const r = await proc;
        if (sid) {
          try {
            await pullRemoteSidecars(
              target.localWorkspace,
              sid,
              target.remoteWorkspace,
              (remoteFile) => catRemoteFile(target, remoteFile),
            );
          } catch {
            // sidecar is best-effort
          }
        }
        return { exitCode: r.exitCode };
      } catch (err) {
        if (err instanceof SshTransportError) {
          onTransport(err);
          throw sshRefuseLocalError(err.message);
        }
        if (signal?.aborted) throw new Error("aborted");
        if (timedOut) throw new Error(`timeout:${timeout}`);
        throw err;
      } finally {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

function refuseLocalExecute(reason: string) {
  return async () => {
    throw sshRefuseLocalError(reason);
  };
}

function installRefuseLocalTools(pi: ExtensionAPI, reason: string): void {
  const localCwd = process.cwd();
  const fail = refuseLocalExecute(reason);
  pi.registerTool({ ...createReadTool(localCwd), execute: fail });
  pi.registerTool({ ...createWriteTool(localCwd), execute: fail });
  pi.registerTool({ ...createEditTool(localCwd), execute: fail });
  pi.registerTool({ ...createBashTool(localCwd), execute: fail });
  pi.registerTool({ ...createLsTool(localCwd), execute: fail });
  pi.registerTool({ ...createFindTool(localCwd), execute: fail });
  pi.registerTool({ ...createGrepTool(localCwd), execute: fail });
  pi.on("user_bash", () => ({
    operations: {
      exec: async () => {
        throw sshRefuseLocalError(reason);
      },
    },
  }));
  pi.on("before_agent_start", (event) => {
    let systemPrompt = event.systemPrompt;
    const marker = sshFailMarker(reason);
    if (!systemPrompt.includes("[ssh-runtime]")) {
      systemPrompt = `${marker}\n\n${systemPrompt}`;
    }
    return { systemPrompt };
  });
  pi.on("session_start", (_e, ctx) => {
    ctx.ui.setStatus("ssh", ctx.ui.theme.fg("error", "SSH: FAIL (refusing local)"));
    ctx.ui.notify(`ssh: ${reason}`, "error");
  });
}

export default function (pi: ExtensionAPI) {
  const root = projectRoot();
  if (
    !shouldRegisterSsh(fileURLToPath(import.meta.url), root, process.env)
  ) {
    return;
  }
  const configPath = sshConfigPath();
  if (!fs.existsSync(configPath)) return;

  const config = (() => {
    try {
      return loadSshJson(configPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (sshIntended(process.env, {})) {
        installRefuseLocalTools(pi, msg);
      } else {
        pi.on("session_start", (_e, ctx) => {
          ctx.ui.notify(`ssh extension: ${msg}`, "error");
        });
      }
      return undefined;
    }
  })();
  if (config === undefined) return;

  const intended = sshIntended(process.env, config);
  let resolved;
  try {
    resolved = resolveSshTarget(config, process.env, {
      defaultLocalWorkspace: path.join(root, "workspace"),
      homeDir: os.homedir(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (intended) {
      installRefuseLocalTools(pi, msg);
    } else {
      pi.on("session_start", (_e, ctx) => {
        ctx.ui.notify(`ssh extension: ${msg}`, "error");
      });
    }
    return;
  }
  if (!resolved.enabled) {
    if (intended) {
      installRefuseLocalTools(
        pi,
        "ssh: intended, but the target resolved disabled",
      );
    }
    return;
  }

  const active = attachControlPath(resolved);
  installMuxExitHook(active);
  const localCwd = process.cwd();
  const localRead = createReadTool(localCwd);
  const localWrite = createWriteTool(localCwd);
  const localEdit = createEditTool(localCwd);
  const localBash = createBashTool(localCwd);
  const localLs = createLsTool(localCwd);
  const localFind = createFindTool(localCwd);
  const localGrep = createGrepTool(localCwd);

  function transportFailure(ctx: ExtensionContext | undefined, err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    ctx?.ui.setStatus(
      "ssh",
      ctx.ui.theme.fg("error", "SSH: FAIL (refusing local)"),
    );
    ctx?.ui.notify(
      `ssh: transport failed — refusing local tools. (${msg})`,
      "error",
    );
  }

  pi.on("session_start", async (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    if (event.reason === "fork") {
      const parentId = sessionIdFromSessionFile(
        ctx.sessionManager.getHeader()?.parentSession ??
        event.previousSessionFile,
      );
      if (parentId) {
        copyShellState(active.localWorkspace, parentId, sessionId);
        const script = remoteCopyShellStateScript(
          active.remoteWorkspace,
          parentId,
          sessionId,
        );
        if (script) {
          try {
            await sshExecBuffered(active, {
              argv: ["/bin/sh", "-lc", script],
            });
          } catch {
            // fork sidecar copy is best-effort
          }
        }
      }
    }
    try {
      const skills = skillDirsFromArgv(process.argv, process.cwd());
      if (skills.length > 0) {
        await syncSkillsToRemoteHome(active, skills);
        ctx.ui.notify(
          `Copied ${skills.length} skills to ~/.pi/skills on ${sshStatusLabel(active)}.`,
          "info",
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(`ssh: skill copy to ~/.pi/skills failed: ${msg}`, "error");
    }
    ctx.ui.setStatus(
      "ssh",
      ctx.ui.theme.fg(
        "accent",
        `SSH: ${sshStatusLabel(active)} (${active.localWorkspace} -> ${active.remoteWorkspace})`,
      ),
    );
    ctx.ui.notify(
      `SSH tools on ${sshStatusLabel(active)}. Local ${active.localWorkspace} maps to ${active.remoteWorkspace}.`,
      "info",
    );
  });

  pi.on("session_shutdown", () => {
    closeControlMasterSync(active);
  });

  pi.registerTool({
    ...localRead,
    async execute(id, params, signal, onUpdate, ctx) {
      return runWithPathContext(
        active,
        ctx.sessionManager.getSessionId(),
        (params as PathToolParams).path,
        (resolvedPath) => {
          const tool = createReadTool(active.localWorkspace, {
            operations: createSshReadOps(active, (err) => transportFailure(ctx, err)),
          });
          return tool.execute(
            id,
            { ...params, path: resolvedPath },
            signal,
            onUpdate,
          );
        },
      );
    },
  });

  pi.registerTool({
    ...localWrite,
    async execute(id, params, signal, onUpdate, ctx) {
      return runMutatingPathContext(
        active,
        ctx.sessionManager.getSessionId(),
        (params as PathToolParams).path,
        (resolvedPath) => {
          const tool = createWriteTool(active.localWorkspace, {
            operations: createSshWriteOps(active, (err) => transportFailure(ctx, err)),
          });
          return tool.execute(
            id,
            { ...params, path: resolvedPath },
            signal,
            onUpdate,
          );
        },
      );
    },
  });

  pi.registerTool({
    ...localEdit,
    async execute(id, params, signal, onUpdate, ctx) {
      return runMutatingPathContext(
        active,
        ctx.sessionManager.getSessionId(),
        (params as PathToolParams).path,
        (resolvedPath) => {
          const tool = createEditTool(active.localWorkspace, {
            operations: createSshEditOps(active, (err) => transportFailure(ctx, err)),
          });
          return tool.execute(
            id,
            { ...params, path: resolvedPath },
            signal,
            onUpdate,
          );
        },
      );
    },
  });

  pi.registerTool({
    ...localBash,
    async execute(id, params, signal, onUpdate, ctx) {
      const sessionId = ctx.sessionManager.getSessionId();
      const tool = createBashTool(active.localWorkspace, {
        operations: createSshBashOps(
          active,
          (err) => transportFailure(ctx, err),
          sessionId,
        ),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  // ls / find / grep: same class of host filesystem tools as read. Path
  // args resolve against the session's last remote bash cwd. find uses
  // remote fd via FindOperations; ls via LsOperations; grep replaces
  // execute entirely (GrepOperations cannot remote ripgrep itself).
  pi.registerTool({
    ...localLs,
    async execute(id, params, signal, onUpdate, ctx) {
      const rawPath =
        (params as { path?: string }).path !== undefined
          ? (params as { path?: string }).path!
          : ".";
      return runWithPathContext(
        active,
        ctx.sessionManager.getSessionId(),
        rawPath,
        (resolvedPath) => {
          const tool = createLsTool(active.localWorkspace, {
            operations: createSshLsOps(active, (err) =>
              transportFailure(ctx, err),
            ),
          });
          return tool.execute(
            id,
            { ...params, path: resolvedPath },
            signal,
            onUpdate,
          );
        },
      );
    },
  });

  pi.registerTool({
    ...localFind,
    async execute(id, params, signal, onUpdate, ctx) {
      const rawPath =
        (params as { path?: string }).path !== undefined
          ? (params as { path?: string }).path!
          : ".";
      return runWithPathContext(
        active,
        ctx.sessionManager.getSessionId(),
        rawPath,
        (resolvedPath) => {
          const tool = createFindTool(active.localWorkspace, {
            operations: createSshFindOps(active, (err) =>
              transportFailure(ctx, err),
            ),
          });
          return tool.execute(
            id,
            { ...params, path: resolvedPath },
            signal,
            onUpdate,
          );
        },
      );
    },
  });

  pi.registerTool({
    ...localGrep,
    async execute(_id, params, signal, _onUpdate, ctx) {
      const input = params as GrepToolInput;
      const rawPath = input.path !== undefined ? input.path : ".";
      return runWithPathContext(
        active,
        ctx.sessionManager.getSessionId(),
        rawPath,
        (resolvedPath) =>
          executeSshGrep(active, input, {
            searchPath: resolvedPath,
            signal,
            onTransport: (err) => transportFailure(ctx, err),
          }),
      );
    },
  });

  // readMultiple: batch file reads on the remote host. Each file resolves
  // against the session's last remote bash cwd like read/write/edit, then is
  // fetched with a remote /bin/cat through the same transport. Per-file
  // failures are reported inline; transport failures propagate to the
  // refuse-local flow exactly like the read tool's ops.
  pi.registerTool(
    createReadMultipleTool((sessionId) => {
      return async (rawFilename, sid) => {
        const resolvedPath = resolveToolPathParam(
          active,
          sid ?? sessionId,
          rawFilename,
        );
        let remotePath;
        try {
          remotePath = remoteToolPath(
            active.localWorkspace,
            active.remoteWorkspace,
            resolvedPath,
          );
        } catch (err) {
          throw new Error(
            `${err instanceof Error ? err.message : String(err)} (absolute path: ${resolvedPath})`,
          );
        }
        let r;
        try {
          r = await sshExecBuffered(active, { argv: ["/bin/cat", remotePath] });
        } catch (err) {
          rethrowTransport(err, transportFailure);
        }
        if (!r.ok) {
          throw new Error(
            `read failed for ${remotePath} (exit ${r.exitCode}): ${r.stderr || "no stderr"}`,
          );
        }
        return { absPath: remotePath, buf: r.stdoutBuffer };
      };
    }),
  );

  // bg_*: same names as pi-background-tasks, but the process is on the SSH
  // host. The package extension that would also register these names is
  // disabled via project package filter while SSH is on.
  function remoteBgCwd(sessionId: string | undefined): string {
    const last = sessionId
      ? readPersistedCwd(active.localWorkspace, sessionId)
      : undefined;
    if (last && isSafeRemotePath(last)) return last;
    return active.remoteWorkspace;
  }

  pi.registerTool({
    name: "bg_run",
    label: "Background Run (SSH)",
    description: `Start a named long-running shell command on the SSH host and return immediately with a task ID and remote output path. The process is detached on the remote host (not on this machine). Completion does not wake a follow-up turn — use bg_status / bg_logs. Model-visible logs are bounded to ${formatSize(MAX_LOG_BYTES)}.`,
    promptSnippet:
      "Start a named long-running command on the SSH host; poll with bg_status / bg_logs (no completion wake-up)",
    promptGuidelines: [
      "Use bg_run instead of bash for commands expected to run for a long time on the SSH host (tests, builds, servers, watchers).",
      "Always set isAgent: true only when the background task launches an LLM/agent process; set isAgent: false for scripts, tests, servers, sleeps, and ordinary shell commands. Remote wrapping of child pi is not supported — isAgent is accepted for call compatibility only.",
      "Always set name to a concise 2-6 word label; do not use the raw command as the name unless it is already short.",
      "bg_run returns immediately. Completion does not deliver a notification or start a follow-up turn over SSH — call bg_status / bg_logs when you need the result.",
      "notifyOnCompletion, triggerOnCompletion, and surviveReload are accepted but have no effect over SSH.",
    ],
    parameters: Type.Object({
      command: Type.String({ description: "Shell command to start on the SSH host" }),
      name: Type.String({
        description:
          "Short human-readable task name (2-6 words). Required; not the raw command.",
      }),
      isAgent: Type.Boolean({
        description:
          "Required for call compatibility. True only for LLM/agent processes; false for ordinary shell commands. Remote pi telemetry wrapping is not performed.",
      }),
      description: Type.Optional(
        Type.String({ description: "Optional longer human-readable context" }),
      ),
      timeoutSeconds: Type.Optional(
        Type.Number({
          description:
            "Optional timeout; the remote task is failed and killed when exceeded",
        }),
      ),
      notifyOnCompletion: Type.Optional(
        Type.Boolean({
          description:
            "Accepted for compatibility; SSH bg_run does not deliver completion notifications",
        }),
      ),
      triggerOnCompletion: Type.Optional(
        Type.Boolean({
          description:
            "Accepted for compatibility; SSH bg_run does not wake a follow-up turn",
        }),
      ),
      surviveReload: Type.Optional(
        Type.Boolean({
          description:
            "Accepted for compatibility; SSH bg_run does not survive host Pi reload",
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const sessionId = ctx.sessionManager.getSessionId();
      if (!sessionId) throw new Error("bg_run requires a session id");
      const input = params as {
        command: string;
        name: string;
        isAgent: boolean;
        description?: string;
        timeoutSeconds?: number;
      };
      try {
        const got = await sshBgRun(
          active,
          {
            sessionId,
            command: input.command,
            name: input.name,
            isAgent: input.isAgent,
            description: input.description,
            timeoutSeconds: input.timeoutSeconds,
            cwd: remoteBgCwd(sessionId),
            env: process.env as Record<string, string | undefined>,
          },
          sshExecBuffered,
          (err) => transportFailure(ctx, err),
        );
        return {
          content: [{ type: "text" as const, text: got.message }],
          details: { task: got.task },
        };
      } catch (err) {
        if (err instanceof SshTransportError) {
          transportFailure(ctx, err);
          throw sshRefuseLocalError(err.message);
        }
        throw err;
      }
    },
  });

  pi.registerTool({
    name: "bg_status",
    label: "Background Status (SSH)",
    description:
      "Inspect one SSH-host background task or list recent tasks for this session. Point-in-time only — not a waiting primitive.",
    promptSnippet: "Inspect SSH-host background task status (not a wait loop)",
    promptGuidelines: [
      "Use bg_status for deliberate inspection on the SSH host, not as a sleep/poll loop.",
      "Omit taskId to list recent tasks for this session.",
    ],
    parameters: Type.Object({
      taskId: Type.Optional(
        Type.String({
          description:
            "Optional task ID or unambiguous prefix. If omitted, recent tasks for this session are listed.",
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const sessionId = ctx.sessionManager.getSessionId();
      if (!sessionId) throw new Error("bg_status requires a session id");
      const taskId = (params as { taskId?: string }).taskId;
      try {
        const got = await sshBgStatus(
          active,
          { sessionId, taskId },
          sshExecBuffered,
          (err) => transportFailure(ctx, err),
        );
        return {
          content: [{ type: "text" as const, text: got.message }],
          details: { tasks: got.tasks },
        };
      } catch (err) {
        if (err instanceof SshTransportError) {
          transportFailure(ctx, err);
          throw sshRefuseLocalError(err.message);
        }
        throw err;
      }
    },
  });

  pi.registerTool({
    name: "bg_logs",
    label: "Background Logs (SSH)",
    description: `Read bounded output from an SSH-host background task. Capped at ${formatSize(MAX_LOG_BYTES)}; points to the remote output path when truncated.`,
    promptSnippet: "Read bounded SSH-host background task output",
    promptGuidelines: [
      "Use bg_logs when output bytes are needed; do not poll it merely to wait.",
    ],
    parameters: Type.Object({
      taskId: Type.String({
        description: "Task ID or unambiguous prefix",
      }),
      maxBytes: Type.Optional(
        Type.Number({
          description: `Maximum bytes to return, capped at ${formatSize(MAX_LOG_BYTES)}. Default: ${formatSize(MAX_LOG_BYTES)}.`,
        }),
      ),
      tail: Type.Optional(
        Type.Boolean({
          description: "Read the tail when true, head when false. Default: true.",
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const sessionId = ctx.sessionManager.getSessionId();
      if (!sessionId) throw new Error("bg_logs requires a session id");
      const input = params as {
        taskId: string;
        maxBytes?: number;
        tail?: boolean;
      };
      try {
        const got = await sshBgLogs(
          active,
          {
            sessionId,
            taskId: input.taskId,
            maxBytes: input.maxBytes,
            tail: input.tail,
          },
          sshExecBuffered,
          (err) => transportFailure(ctx, err),
        );
        return {
          content: [{ type: "text" as const, text: got.message }],
          details: {
            taskId: got.taskId,
            path: got.path,
            bytesRead: got.bytesRead,
            truncated: got.truncated,
            tail: got.tail,
          },
        };
      } catch (err) {
        if (err instanceof SshTransportError) {
          transportFailure(ctx, err);
          throw sshRefuseLocalError(err.message);
        }
        throw err;
      }
    },
  });

  pi.registerTool({
    name: "bg_kill",
    label: "Background Kill (SSH)",
    description:
      "Stop a running SSH-host background task by ID. Fails if unknown or already finished.",
    promptSnippet: "Stop a running SSH-host background task",
    promptGuidelines: [
      "Use bg_kill when the user asks to stop a task or the command is no longer needed.",
    ],
    parameters: Type.Object({
      taskId: Type.String({
        description: "Task ID or unambiguous prefix to stop",
      }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const sessionId = ctx.sessionManager.getSessionId();
      if (!sessionId) throw new Error("bg_kill requires a session id");
      const taskId = (params as { taskId: string }).taskId;
      try {
        const got = await sshBgKill(
          active,
          { sessionId, taskId },
          sshExecBuffered,
          (err) => transportFailure(ctx, err),
        );
        return {
          content: [{ type: "text" as const, text: got.message }],
          details: { taskId: got.taskId, message: got.message },
        };
      } catch (err) {
        if (err instanceof SshTransportError) {
          transportFailure(ctx, err);
          throw sshRefuseLocalError(err.message);
        }
        throw err;
      }
    },
  });

  pi.on("user_bash", (_event, ctx) => {
    return {
      operations: createSshBashOps(
        active,
        () => { },
        ctx.sessionManager.getSessionId(),
      ),
    };
  });

  pi.on("before_agent_start", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const remoteCwd =
      readPersistedCwd(active.localWorkspace, sessionId) ??
      active.remoteWorkspace;
    const cwdLine = `Current working directory: ${remoteCwd} (SSH ${sshStatusLabel(active)}; local ${active.localWorkspace} maps to ${active.remoteWorkspace})`;
    const marker = sshRuntimeMarker(active);
    let systemPrompt = event.systemPrompt
      .replace(`Current working directory: ${root}`, cwdLine)
      .replace(`Current working directory: ${localCwd}`, cwdLine)
      .replace(`Current working directory: ${active.localWorkspace}`, cwdLine);
    if (!systemPrompt.includes("[ssh-runtime]")) {
      systemPrompt = `${marker}\n\n${systemPrompt}`;
    }
    return { systemPrompt };
  });
}
