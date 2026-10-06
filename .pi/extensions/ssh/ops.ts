/**
 * SSH-backed operations for Pi's host filesystem tools (ls / find / grep).
 *
 * read/write/edit/bash are already remoted in index.ts. These three still
 * default to the local machine (fd, rg, fs). When the SSH backend is active
 * we override them through the same sshExecBuffered transport.
 *
 * find/ls use Pi's pluggable Operations interfaces. grep's GrepOperations
 * only remotes isDirectory/readFile for context lines — rg still spawns
 * locally — so grep is a full execute replacement (same approach as the
 * official gondolin example).
 *
 * Truncation helpers are inlined (not imported from pi-coding-agent) so
 * unit tests under this directory resolve without a local node_modules.
 * Shapes match Pi's FindOperations / LsOperations / GrepTool* types.
 */

import path from "node:path";

import {
  sshExecBuffered,
  SshTransportError,
  type ExecResult,
} from "./exec.ts";
import {
  quoteShell,
  remoteToolPath,
  type EnabledSshTarget,
} from "./lib.ts";

export type TransportReporter = (err: unknown) => void;

export type SshExecBufferedFn = (
  target: EnabledSshTarget,
  opts: { argv: string[]; cwd?: string; env?: Record<string, string> },
) => Promise<ExecResult>;

/** Subset of Pi FindOperations used by createFindTool. */
export type FindOperations = {
  exists: (absolutePath: string) => Promise<boolean> | boolean;
  glob: (
    pattern: string,
    cwd: string,
    options: { ignore: string[]; limit: number },
  ) => Promise<string[]> | string[];
};

/** Subset of Pi LsOperations used by createLsTool. */
export type LsOperations = {
  exists: (absolutePath: string) => Promise<boolean> | boolean;
  stat: (
    absolutePath: string,
  ) =>
    | Promise<{ isDirectory: () => boolean }>
    | { isDirectory: () => boolean };
  readdir: (absolutePath: string) => Promise<string[]> | string[];
};

/** Subset of Pi GrepToolInput. */
export type GrepToolInput = {
  pattern: string;
  path?: string;
  glob?: string;
  ignoreCase?: boolean;
  literal?: boolean;
  context?: number;
  limit?: number;
};

export type GrepToolDetails = {
  truncation?: { truncated: boolean; content: string };
  matchLimitReached?: number;
  linesTruncated?: boolean;
};

const DEFAULT_MAX_BYTES = 50 * 1024;
const GREP_MAX_LINE_LENGTH = 500;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function truncateLine(
  line: string,
  maxChars = GREP_MAX_LINE_LENGTH,
): { text: string; wasTruncated: boolean } {
  if (line.length <= maxChars) return { text: line, wasTruncated: false };
  return { text: `${line.slice(0, maxChars)}...`, wasTruncated: true };
}

function truncateHead(
  content: string,
  options: { maxLines?: number; maxBytes?: number } = {},
): { truncated: boolean; content: string } {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxLines = options.maxLines ?? Number.MAX_SAFE_INTEGER;
  const lines = content.split("\n");
  let out = "";
  let truncated = false;
  for (let i = 0; i < lines.length; i++) {
    if (i >= maxLines) {
      truncated = true;
      break;
    }
    const next = i === 0 ? lines[i]! : `${out}\n${lines[i]!}`;
    if (Buffer.byteLength(next, "utf8") > maxBytes) {
      truncated = true;
      break;
    }
    out = next;
  }
  return { truncated, content: out };
}

function rethrowTransport(err: unknown, onTransport: TransportReporter): never {
  if (err instanceof SshTransportError) onTransport(err);
  throw err;
}

function mapPath(target: EnabledSshTarget, localOrRemote: string): string {
  return remoteToolPath(
    target.localWorkspace,
    target.remoteWorkspace,
    localOrRemote,
  );
}

async function runMapped(
  target: EnabledSshTarget,
  onTransport: TransportReporter,
  exec: SshExecBufferedFn,
  argv: string[],
): Promise<ExecResult> {
  try {
    return await exec(target, { argv });
  } catch (err) {
    rethrowTransport(err, onTransport);
  }
}

/** Pluggable ls ops: exists / stat / readdir over SSH. */
export function createSshLsOps(
  target: EnabledSshTarget,
  onTransport: TransportReporter,
  exec: SshExecBufferedFn = sshExecBuffered,
): LsOperations {
  return {
    exists: async (absolutePath) => {
      const remotePath = mapPath(target, absolutePath);
      const r = await runMapped(target, onTransport, exec, [
        "/bin/sh",
        "-lc",
        `test -e ${quoteShell(remotePath)}`,
      ]);
      return r.ok;
    },
    stat: async (absolutePath) => {
      const remotePath = mapPath(target, absolutePath);
      const r = await runMapped(target, onTransport, exec, [
        "/bin/sh",
        "-lc",
        `test -e ${quoteShell(remotePath)} && if test -d ${quoteShell(remotePath)}; then echo dir; else echo file; fi`,
      ]);
      if (!r.ok) {
        throw new Error(`ENOENT: ${remotePath}`);
      }
      const isDir = r.stdout.trim() === "dir";
      return { isDirectory: () => isDir };
    },
    readdir: async (absolutePath) => {
      const remotePath = mapPath(target, absolutePath);
      const r = await runMapped(target, onTransport, exec, [
        "/bin/sh",
        "-lc",
        `find ${quoteShell(remotePath)} -mindepth 1 -maxdepth 1 -printf '%f\\n'`,
      ]);
      if (!r.ok) {
        throw new Error(
          `Cannot read directory: ${r.stderr.trim() || `exit ${r.exitCode}`}`,
        );
      }
      return r.stdout
        .split("\n")
        .map((line) => line.replace(/\r$/, ""))
        .filter((line) => line.length > 0);
    },
  };
}

/**
 * Build the remote fd/fdfind argv body for a glob search.
 * Mirrors pi's default find tool: --glob, hidden, --full-path and a
 * leading double-star slash prefix for path-containing patterns.
 */
export function buildRemoteFdScript(
  pattern: string,
  remoteCwd: string,
  limit: number,
): string {
  let effectivePattern = pattern;
  const fullPath = pattern.includes("/");
  if (
    fullPath &&
    !pattern.startsWith("/") &&
    !pattern.startsWith("**/") &&
    pattern !== "**"
  ) {
    effectivePattern = `**/${pattern}`;
  }
  const fdArgs = [
    "--glob",
    "--color=never",
    "--hidden",
    "--no-require-git",
    "-E",
    "node_modules",
    "-E",
    ".git",
    "--max-results",
    String(Math.max(1, limit)),
  ];
  if (fullPath) fdArgs.push("--full-path");
  fdArgs.push("--", effectivePattern, remoteCwd);

  const fdCmd = fdArgs.map(quoteShell).join(" ");
  return [
    `set -eu`,
    `if command -v fd >/dev/null 2>&1; then`,
    `  exec fd ${fdCmd}`,
    `elif command -v fdfind >/dev/null 2>&1; then`,
    `  exec fdfind ${fdCmd}`,
    `else`,
    `  echo 'fd is not available on the SSH host (tried fd, fdfind)' >&2`,
    `  exit 127`,
    `fi`,
  ].join("\n");
}

/** Pluggable find ops: exists + glob via remote fd. */
export function createSshFindOps(
  target: EnabledSshTarget,
  onTransport: TransportReporter,
  exec: SshExecBufferedFn = sshExecBuffered,
): FindOperations {
  return {
    exists: async (absolutePath) => {
      const remotePath = mapPath(target, absolutePath);
      const r = await runMapped(target, onTransport, exec, [
        "/bin/sh",
        "-lc",
        `test -e ${quoteShell(remotePath)}`,
      ]);
      return r.ok;
    },
    glob: async (pattern, cwd, options) => {
      const remoteCwd = mapPath(target, cwd);
      const script = buildRemoteFdScript(pattern, remoteCwd, options.limit);
      const r = await runMapped(target, onTransport, exec, [
        "/bin/sh",
        "-lc",
        script,
      ]);
      if (!r.ok && r.exitCode !== 1) {
        throw new Error(
          r.stderr.trim() || `fd failed on SSH host (exit ${r.exitCode})`,
        );
      }
      return r.stdout
        .split("\n")
        .map((line) => line.replace(/\r$/, "").trim())
        .filter((line) => line.length > 0);
    },
  };
}

const DEFAULT_GREP_LIMIT = 100;

export type SshGrepResult = {
  content: [{ type: "text"; text: string }];
  details: GrepToolDetails | undefined;
};

/**
 * Full grep execute replacement: run ripgrep on the SSH host and format
 * like Pi's built-in grep tool. GrepOperations cannot remote the search.
 */
export async function executeSshGrep(
  target: EnabledSshTarget,
  params: GrepToolInput,
  opts: {
    onTransport: TransportReporter;
    signal?: AbortSignal;
    searchPath: string;
    exec?: SshExecBufferedFn;
  },
): Promise<SshGrepResult> {
  if (opts.signal?.aborted) throw new Error("Operation aborted");
  const exec = opts.exec ?? sshExecBuffered;
  const remotePath = mapPath(target, opts.searchPath);
  const contextValue =
    params.context && params.context > 0 ? params.context : 0;
  const effectiveLimit = Math.max(1, params.limit ?? DEFAULT_GREP_LIMIT);

  const rgArgs: string[] = [
    "--json",
    "--line-number",
    "--color=never",
    "--hidden",
  ];
  if (params.ignoreCase) rgArgs.push("--ignore-case");
  if (params.literal) rgArgs.push("--fixed-strings");
  if (params.glob) rgArgs.push("--glob", params.glob);
  rgArgs.push("--", params.pattern, remotePath);

  const script = [
    `set -eu`,
    `if command -v rg >/dev/null 2>&1; then`,
    `  exec rg ${rgArgs.map(quoteShell).join(" ")}`,
    `else`,
    `  echo 'ripgrep (rg) is not available on the SSH host' >&2`,
    `  exit 127`,
    `fi`,
  ].join("\n");

  let r: ExecResult;
  try {
    r = await exec(target, { argv: ["/bin/sh", "-lc", script] });
  } catch (err) {
    rethrowTransport(err, opts.onTransport);
  }
  if (opts.signal?.aborted) throw new Error("Operation aborted");

  if (!r.ok && r.exitCode !== 1 && !r.stdout.trim()) {
    throw new Error(
      r.stderr.trim() || `ripgrep failed on SSH host (exit ${r.exitCode})`,
    );
  }

  type Match = { filePath: string; lineNumber: number; lineText?: string };
  const matches: Match[] = [];
  let matchLimitReached = false;
  for (const line of r.stdout.split("\n")) {
    if (!line.trim()) continue;
    let event: {
      type?: string;
      data?: {
        path?: { text?: string };
        line_number?: number;
        lines?: { text?: string };
      };
    };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type !== "match") continue;
    const filePath = event.data?.path?.text;
    const lineNumber = event.data?.line_number;
    if (!filePath || typeof lineNumber !== "number") continue;
    matches.push({
      filePath,
      lineNumber,
      lineText: event.data?.lines?.text,
    });
    if (matches.length >= effectiveLimit) {
      matchLimitReached = true;
      break;
    }
  }

  if (matches.length === 0) {
    return {
      content: [{ type: "text", text: "No matches found" }],
      details: undefined,
    };
  }

  let rootIsDirectory = true;
  try {
    const st = await runMapped(target, opts.onTransport, exec, [
      "/bin/sh",
      "-lc",
      `if test -d ${quoteShell(remotePath)}; then echo dir; else echo file; fi`,
    ]);
    rootIsDirectory = st.stdout.trim() === "dir";
  } catch {
    rootIsDirectory = true;
  }

  const formatPath = (filePath: string): string => {
    if (rootIsDirectory) {
      const relative = path.posix.relative(remotePath, filePath);
      if (relative && !relative.startsWith("..")) return relative;
    }
    return path.posix.basename(filePath);
  };

  const fileCache = new Map<string, string[]>();
  const getFileLines = async (filePath: string): Promise<string[]> => {
    let lines = fileCache.get(filePath);
    if (lines) return lines;
    try {
      const got = await runMapped(target, opts.onTransport, exec, [
        "/bin/cat",
        filePath,
      ]);
      if (!got.ok) {
        lines = [];
      } else {
        lines = got.stdout
          .replace(/\r\n/g, "\n")
          .replace(/\r/g, "\n")
          .split("\n");
      }
    } catch {
      lines = [];
    }
    fileCache.set(filePath, lines);
    return lines;
  };

  const outputLines: string[] = [];
  let linesTruncated = false;
  for (const match of matches) {
    if (opts.signal?.aborted) throw new Error("Operation aborted");
    const relativePath = formatPath(match.filePath);
    if (contextValue === 0 && match.lineText !== undefined) {
      const sanitized = match.lineText
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "")
        .replace(/\n$/, "");
      const { text: truncatedText, wasTruncated } = truncateLine(sanitized);
      if (wasTruncated) linesTruncated = true;
      outputLines.push(`${relativePath}:${match.lineNumber}: ${truncatedText}`);
      continue;
    }
    const lines = await getFileLines(match.filePath);
    if (!lines.length) {
      outputLines.push(
        `${relativePath}:${match.lineNumber}: (unable to read file)`,
      );
      continue;
    }
    const start =
      contextValue > 0
        ? Math.max(1, match.lineNumber - contextValue)
        : match.lineNumber;
    const end =
      contextValue > 0
        ? Math.min(lines.length, match.lineNumber + contextValue)
        : match.lineNumber;
    for (let current = start; current <= end; current++) {
      const lineText = lines[current - 1] ?? "";
      const sanitized = lineText.replace(/\r/g, "");
      const { text: truncatedText, wasTruncated } = truncateLine(sanitized);
      if (wasTruncated) linesTruncated = true;
      const sep = current === match.lineNumber ? ":" : "-";
      outputLines.push(
        `${relativePath}${sep}${current}${sep} ${truncatedText}`,
      );
    }
  }

  const rawOutput = outputLines.join("\n");
  const truncation = truncateHead(rawOutput, {
    maxLines: Number.MAX_SAFE_INTEGER,
  });
  let output = truncation.content;
  const details: GrepToolDetails = {};
  const notices: string[] = [];
  if (matchLimitReached) {
    details.matchLimitReached = effectiveLimit;
    notices.push(
      `${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
    );
  }
  if (truncation.truncated) {
    details.truncation = truncation;
    notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
  }
  if (linesTruncated) {
    details.linesTruncated = true;
    notices.push(
      "Some lines truncated to 500 chars. Use read tool to see full lines",
    );
  }
  if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;

  return {
    content: [{ type: "text", text: output }],
    details: Object.keys(details).length > 0 ? details : undefined,
  };
}
