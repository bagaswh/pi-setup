/**
 * readMultiple — batch file reader for the SSH target host.
 *
 * Same contract as the abandoned local coreutils tool, but every file is
 * fetched from the remote host over the ssh extension's transport, so it
 * belongs to the ssh extension instead of being a standalone extension.
 *
 * Paths behave exactly like read/write/edit: a relative `filename` resolves
 * against the session's last remote bash cwd; absolute paths and `~` are
 * mapped through remoteToolPath (workspace-relative paths map into the
 * remote workspace, safe remote-absolute paths pass through untouched).
 *
 * Semantics:
 *   - option.startEnd: global 1-based inclusive line range [start, end].
 *     Default [1, 20] (first 20 lines). start 0 / omitted → 1; end omitted
 *     or -1 → end of file. Per-file file.startEnd overrides the global
 *     range. The effective range is always shown in the header, e.g.
 *     `foo/bar.txt (from /workspace/foo/bar.txt) [lines 1-20 of 143]`
 *   - printFilenameMode controls the header path style:
 *       absolute_path           /workspace/foo/bar.txt
 *       basename                bar.txt
 *       dirname                 /workspace/foo
 *       prefix                  <printFilenamePrefix><basename>  e.g. "## bar.txt"
 *       direct_dir_and_basename foo/bar.txt (from /workspace/foo/bar.txt)  [default]
 *   - printEachFilename: false disables headers entirely.
 *   - Content lines carry their 1-based line number, usable as edit anchors.
 *   - Per-file failures (missing, directory, binary, escaping the workspace)
 *     are reported inline; the other files still return. Transport failures
 *     propagate and trigger the ssh refuse-local flow like read/write/edit.
 */

import { basename, dirname } from "node:path";

import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";

const MODES = [
  "absolute_path",
  "basename",
  "dirname",
  "prefix",
  "direct_dir_and_basename",
] as const;
type Mode = (typeof MODES)[number];

const MAX_LINES_PER_FILE = 2000;
const MAX_LINE_CHARS = 2000;

interface ResolvedRange {
  start: number; // 1-based inclusive, clamped against file length
  end: number | null; // null = EOF
}

interface FileResultEntry {
  filename: string; // absolute remote path
  header: string; // rendered header (with range), or error line
  content: string; // line-numbered content, or "" on error
  start?: number;
  end?: number;
  totalLines?: number;
  truncated?: boolean; // line cap applied
  error?: string;
}

/** Fetch one file from the target host; throws on transport/permission errors. */
export type RemoteBufferFetcher = (
  rawFilename: string,
  sessionId: string | undefined,
) => Promise<{ absPath: string; buf: Buffer }>;

/** Build a fetcher bound to one execute call (and its session/ctx). */
export type RemoteBufferFetcherFactory = (
  sessionId: string | undefined,
) => RemoteBufferFetcher;

function parseStartEnd(value: unknown, fallback: ResolvedRange): ResolvedRange {
  if (!Array.isArray(value) || value.length === 0) return fallback;
  const startRaw = typeof value[0] === "number" ? value[0] : 1;
  const endRaw =
    value.length > 1 && typeof value[1] === "number" ? value[1] : null;
  return {
    start: Math.max(1, Math.floor(startRaw) || 1),
    end: endRaw === null || endRaw < 0 ? null : Math.max(1, Math.floor(endRaw)),
  };
}

function renderHeader(absPath: string, mode: Mode, prefix: string): string {
  const base = basename(absPath);
  const dir = dirname(absPath);
  switch (mode) {
    case "absolute_path":
      return absPath;
    case "basename":
      return base;
    case "dirname":
      return dir;
    case "prefix":
      return `${prefix}${base}`;
    case "direct_dir_and_basename":
    default:
      // `foo/bar.txt (from /workspace/foo/bar.txt)`
      return `${basename(dir)}/${base} (from ${absPath})`;
  }
}

function detectBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8192).includes(0);
}

function sliceBuffer(
  absPath: string,
  buf: Buffer,
  range: ResolvedRange,
  mode: Mode,
  prefix: string,
  printHeader: boolean,
): FileResultEntry {
  const pathLabel = renderHeader(absPath, mode, prefix);
  const totalBytes = buf.length;

  if (detectBinary(buf)) {
    return {
      filename: absPath,
      header: pathLabel,
      content: "",
      error: `binary file (${totalBytes} bytes) — not shown`,
    };
  }

  const allLines = buf.toString("utf8").split("\n");
  // A trailing newline produces a final empty element; it is not a line.
  if (allLines.length > 0 && allLines[allLines.length - 1] === "") allLines.pop();
  const totalLines = allLines.length;

  const start = Math.min(range.start, Math.max(totalLines, 1));
  const end = range.end === null ? totalLines : Math.min(range.end, totalLines);
  const empty = start > end || totalLines === 0;

  // Header always states the effective range so the agent knows exactly
  // which slice of the file this content came from.
  let header = "";
  if (printHeader) {
    if (empty) {
      header = `${pathLabel} [lines ${start}-${range.end ?? start} requested — file has ${totalLines} lines, nothing shown]`;
    } else {
      header = `${pathLabel} [lines ${start}-${end} of ${totalLines}]`;
    }
  }

  let body = "";
  let truncated = false;
  if (!empty) {
    const width = String(end).length;
    for (let n = start; n <= end; n++) {
      if (n - start >= MAX_LINES_PER_FILE) {
        truncated = true;
        break;
      }
      let line = allLines[n - 1];
      if (line.length > MAX_LINE_CHARS) {
        line = `${line.slice(0, MAX_LINE_CHARS)}… [line truncated at ${MAX_LINE_CHARS} chars]`;
      }
      body += `${String(n).padStart(width)}\t${line}\n`;
    }
  }

  const entry: FileResultEntry = { filename: absPath, header, content: body, truncated };
  if (!empty) {
    entry.start = start;
    entry.end = end;
    entry.totalLines = totalLines;
  }
  return entry;
}

export function createReadMultipleTool(makeFetcher: RemoteBufferFetcherFactory) {
  return {
    name: "readMultiple",
    label: "Read Multiple (remote)",
    description: [
      "Read multiple files from the SSH target host in one call; each file is preceded by a filename header that includes the exact line range returned, e.g. `foo/bar.txt (from /workspace/foo/bar.txt) [lines 1-20 of 143]`.",
      "Paths behave like the read tool: relative filenames resolve against the session's remote bash cwd; absolute paths are read as-is on the host.",
      "Every content line is prefixed with its 1-based line number.",
      "Default range is the first 20 lines per file — pass startEnd ([start, end] inclusive, -1 end = EOF) globally via option.startEnd or per file to read more; per-file startEnd overrides the global option.",
      "Missing/binary/directory files are reported inline; other files still return.",
    ].join(" "),
    promptSnippet: "Read multiple files on the SSH host in a single call with per-file line ranges",
    promptGuidelines: [
      "Use readMultiple when you need to inspect several files on the SSH host at once; each output block is labeled with its file and the exact line range it contains.",
    ],
    parameters: Type.Object({
      files: Type.Array(
        Type.Object({
          filename: Type.String({
            description:
              "File path on the SSH host (relative to the remote bash cwd, absolute, ~/..., or @-prefixed)",
          }),
          startEnd: Type.Optional(
            Type.Array(Type.Number(), {
              description:
                "Optional 1-based inclusive [start, end] line range for THIS file; overrides option.startEnd. [n] or [n, -1] reads from line n to EOF. 0 for start means 1.",
            }),
          ),
        }),
        { description: "Files to read, in order" },
      ),
      option: Type.Optional(
        Type.Object({
          printEachFilename: Type.Optional(
            Type.Boolean({
              description: "Print a filename header before each file (default true)",
            }),
          ),
          printFilenameMode: Type.Optional(
            StringEnum(MODES, {
              description:
                "Header path style (default direct_dir_and_basename, e.g. 'foo/bar.txt (from /workspace/foo/bar.txt)'). 'prefix' renders '<printFilenamePrefix><basename>'.",
            }),
          ),
          printFilenamePrefix: Type.Optional(
            Type.String({
              description: "Prefix used only by the 'prefix' mode, e.g. '## '",
            }),
          ),
          startEnd: Type.Optional(
            Type.Array(Type.Number(), {
              description:
                "Global 1-based inclusive [start, end] line range, default [1, 20] (first 20 lines). [n] or [n, -1] reads from line n to EOF. Per-file startEnd overrides this.",
            }),
          ),
        }),
      ),
    }),

    async execute(
      _toolCallId: string,
      params: {
        files?: Array<{ filename?: string; startEnd?: number[] }>;
        option?: {
          printEachFilename?: boolean;
          printFilenameMode?: Mode;
          printFilenamePrefix?: string;
          startEnd?: number[];
        };
      },
      signal: AbortSignal | undefined,
      onUpdate: ((u: { content: Array<{ type: string; text: string }>; details: Record<string, unknown> }) => void) | undefined,
      ctx: { sessionManager: { getSessionId(): string | undefined } },
    ) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Cancelled" }], details: {} };
      }

      const files = params?.files ?? [];
      if (files.length === 0) {
        throw new Error("readMultiple: files[] is empty");
      }
      const sessionId = ctx.sessionManager.getSessionId();
      const fetch = makeFetcher(sessionId);

      const opt = params.option ?? {};
      const printHeader = opt.printEachFilename !== false;
      const mode: Mode = opt.printFilenameMode ?? "direct_dir_and_basename";
      const prefix = typeof opt.printFilenamePrefix === "string" ? opt.printFilenamePrefix : "";
      const globalRange = parseStartEnd(opt.startEnd, { start: 1, end: 20 });

      const entries: FileResultEntry[] = [];
      for (let i = 0; i < files.length; i++) {
        const raw = files[i].filename ?? "";
        const range = parseStartEnd(files[i].startEnd, globalRange);
        let entry: FileResultEntry;
        try {
          const { absPath, buf } = await fetch(raw, sessionId);
          entry = sliceBuffer(absPath, buf, range, mode, prefix, printHeader);
        } catch (err) {
          entry = {
            filename: raw,
            header: renderHeader(raw, mode, prefix),
            content: "",
            error: err instanceof Error ? err.message : String(err),
          };
        }
        entries.push(entry);
        onUpdate?.({
          content: [{ type: "text", text: `readMultiple: ${i + 1}/${files.length} files` }],
          details: { progress: Math.round(((i + 1) / files.length) * 100) },
        });
      }

      const blocks: string[] = [];
      for (const e of entries) {
        if (e.error) {
          blocks.push(`${e.header} [ERROR] ${e.error}`);
          continue;
        }
        const body = e.content === "" ? "(empty range)" : e.content.replace(/\n$/, "");
        const truncNote = e.truncated
          ? ` [truncated at ${MAX_LINES_PER_FILE} lines — request a narrower/later startEnd to continue]`
          : "";
        blocks.push(`${e.header}${truncNote}\n${body}`);
      }

      const errors = entries.filter((e) => e.error).length;
      const summary = `\n[${entries.length} file(s): ${entries.length - errors} ok, ${errors} error(s)]`;

      return {
        content: [{ type: "text", text: blocks.join("\n\n") + summary }],
        details: {
          files: entries.map((e) => ({
            filename: e.filename,
            start: e.start,
            end: e.end,
            totalLines: e.totalLines,
            truncated: e.truncated ?? false,
            error: e.error,
          })),
          errors,
        },
      };
    },

    renderCall(args: { files?: Array<{ filename?: string }>; option?: { printFilenameMode?: string; startEnd?: number[] } }, theme: { fg(t: string, s: string): string; bold(s: string): string }) {
      const files = Array.isArray(args?.files) ? args.files : [];
      const label = files.length === 1 ? files[0]?.filename ?? "?" : `${files.length} files`;
      let text = theme.fg("toolTitle", theme.bold("readMultiple "));
      text += theme.fg("accent", String(label));
      const opt = args?.option;
      const parts: string[] = [];
      if (opt?.printFilenameMode) parts.push(`mode=${opt.printFilenameMode}`);
      if (opt?.startEnd) parts.push(`lines=[${opt.startEnd.join(",")}]`);
      if (parts.length > 0) text += theme.fg("dim", ` (${parts.join(", ")})`);
      return new Text(text, 0, 0);
    },

    renderResult(
      result: {
        details?: {
          files?: Array<{
            filename: string;
            error?: string;
            start?: number;
            end?: number;
            totalLines?: number;
            truncated?: boolean;
          }>;
        };
      },
      { isPartial }: { isPartial: boolean },
      theme: { fg(t: string, s: string): string },
    ) {
      if (isPartial) return new Text(theme.fg("warning", "Reading files..."), 0, 0);
      const files = result.details?.files ?? [];
      if (files.length === 0) {
        return new Text(theme.fg("error", "No content"), 0, 0);
      }
      const lines: string[] = [];
      for (const f of files) {
        if (f.error) {
          lines.push(theme.fg("error", `${basename(f.filename)}: ${f.error}`));
        } else {
          let text = theme.fg("success", `${basename(f.filename)}`);
          if (f.start !== undefined && f.end !== undefined) {
            text += theme.fg("dim", ` [${f.start}-${f.end} of ${f.totalLines}]`);
          }
          if (f.truncated) text += theme.fg("warning", " (truncated)");
          lines.push(text);
        }
      }
      return new Text(lines.join("\n"), 0, 0);
    },
  };
}
