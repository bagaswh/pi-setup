import fs from "node:fs";
import path from "node:path";

import type { StoredPlacement } from "./modes/registry.ts";
import type { FullPlacement, OriginalRecord } from "./serialize.ts";

export const DEFAULT_RECALL_LINES = 200;

export function originalsDir(sessionDir: string, configured?: string): string {
  return configured ?? path.join(sessionDir, "context-compress", "originals");
}

export function originalFileName(id: string, error: boolean): string | undefined {
  if (!/^[A-Za-z0-9_.:-]+$/.test(id)) return undefined;
  const base = id.replaceAll(":", ".");
  if (base.includes("..")) return undefined;
  return error ? `${base}.error.txt` : `${base}.txt`;
}

export function originalPath(dir: string, id: string, error: boolean): string | undefined {
  const name = originalFileName(id, error);
  if (!name) return undefined;
  const root = path.resolve(dir);
  const full = path.resolve(root, name);
  if (full !== root && !full.startsWith(root + path.sep)) return undefined;
  return full;
}

export function formatOriginal(record: OriginalRecord): string {
  return [
    `tool: ${record.toolName ?? "-"}`,
    `arguments: ${record.argumentsText || "-"}`,
    `kind: ${record.kind}`,
    `tokens: ${record.tokens}`,
    `action: ${record.action}`,
    "",
    record.text,
  ].join("\n");
}

export function alignFullPlacements(opts: {
  prior: readonly StoredPlacement[] | undefined;
  priorArchive: string | undefined;
  carried: string;
  piSummary: string;
  freshText: string;
  fresh: FullPlacement[];
}): FullPlacement[] {
  const aligned: FullPlacement[] = [];
  if (opts.prior && opts.priorArchive && (opts.carried === opts.priorArchive || opts.carried.startsWith(opts.priorArchive))) {
    aligned.push(...opts.prior.map((item) => ({ ...item, kind: item.kind as FullPlacement["kind"], text: undefined })));
  }
  const freshJoined = [opts.piSummary, opts.freshText].filter(Boolean).join("\n\n");
  let base = opts.carried && freshJoined ? opts.carried.length + 2 : 0;
  if (opts.piSummary && opts.freshText) base += opts.piSummary.length + 2;
  for (const item of opts.fresh) aligned.push({ ...item, start: item.start + base, end: item.end + base });
  return aligned;
}

export function hiddenFullPlacements(placements: readonly FullPlacement[], visible: Array<[number, number]>, rawToNorm?: number[]): FullPlacement[] {
  return placements.filter((item) => {
    if (item.end <= item.start) return false;
    if (!rawToNorm) return !visible.some(([from, to]) => item.start < to && item.end > from);
    for (let index = item.start; index < item.end && index < rawToNorm.length; index++) {
      const norm = rawToNorm[index] ?? -1;
      if (norm >= 0 && visible.some(([from, to]) => norm >= from && norm < to)) return false;
    }
    return true;
  });
}

export function saveHiddenFull(dir: string, archiveText: string, hidden: readonly FullPlacement[]): void {
  for (const item of hidden) {
    const record: OriginalRecord = {
      id: item.id,
      entryId: item.entryId,
      kind: item.kind,
      index: item.index,
      toolName: item.toolName,
      argumentsText: item.argumentsText ?? "",
      tokens: item.tokens,
      action: "full",
      text: item.text ?? archiveText.slice(item.start, item.end),
      error: false,
    };
    writeOriginal(dir, record);
  }
}

export function writeOriginal(dir: string, record: OriginalRecord): string | undefined {
  const full = originalPath(dir, record.id, record.error);
  if (!full) return undefined;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(full, formatOriginal(record));
  return full;
}

export type RecallResult = {
  text: string;
  isError: boolean;
};

export function recallOriginal(opts: {
  dir: string;
  id: string;
  offset?: number;
  limit?: number;
  seen: Set<string>;
  readFile?: (file: string) => string;
  exists?: (file: string) => boolean;
}): RecallResult {
  const readFile = opts.readFile ?? ((file: string) => fs.readFileSync(file, "utf8"));
  const exists = opts.exists ?? fs.existsSync;
  const errorPath = originalPath(opts.dir, opts.id, true);
  const textPath = originalPath(opts.dir, opts.id, false);
  if (!errorPath || !textPath) return { text: "Unknown original id.", isError: true };
  const file = exists(errorPath) ? errorPath : exists(textPath) ? textPath : undefined;
  if (!file) return { text: "Unknown original id.", isError: true };
  const raw = readFile(file);
  const lines = raw.split("\n");
  const offset = opts.offset && opts.offset > 0 ? Math.floor(opts.offset) : 0;
  const limit = opts.limit && opts.limit > 0 ? Math.floor(opts.limit) : DEFAULT_RECALL_LINES;
  const slice = lines.slice(offset, offset + limit);
  let text = slice.join("\n");
  if (offset + limit < lines.length) text += `\n[next offset=${offset + limit}]`;
  if (opts.seen.has(opts.id)) text += "\nNote: this id was already recalled.";
  else opts.seen.add(opts.id);
  return { text, isError: false };
}

export type ListedOriginal = {
  id: string;
  kind: string;
  tokens: string;
  action: string;
  file: string;
};

function headerValue(text: string, name: string): string {
  const line = text.split("\n").find((entry) => entry.startsWith(`${name}: `));
  return line ? line.slice(name.length + 2) : "";
}

export function listOriginals(dir: string): ListedOriginal[] {
  if (!fs.existsSync(dir)) return [];
  const listed: ListedOriginal[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".txt")) continue;
    const file = path.join(dir, name);
    if (!fs.statSync(file).isFile()) continue;
    const text = fs.readFileSync(file, "utf8");
    const id = name.replace(/\.error\.txt$/, "").replace(/\.txt$/, "").replaceAll(".", ":");
    listed.push({
      id,
      kind: headerValue(text, "kind"),
      tokens: headerValue(text, "tokens"),
      action: headerValue(text, "action"),
      file,
    });
  }
  return listed;
}

export function showOriginal(dir: string, id: string): RecallResult {
  return recallOriginal({ dir, id, limit: Number.MAX_SAFE_INTEGER, seen: new Set() });
}

export function pruneOriginals(dir: string, retention: "session" | number, now = Date.now()): string[] {
  if (retention === "session" || !fs.existsSync(dir)) return [];
  const cutoff = now - retention * 24 * 60 * 60 * 1000;
  const removed: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    const stat = fs.statSync(file);
    if (!stat.isFile()) continue;
    if (stat.mtimeMs < cutoff) {
      fs.unlinkSync(file);
      removed.push(name);
    }
  }
  return removed;
}
