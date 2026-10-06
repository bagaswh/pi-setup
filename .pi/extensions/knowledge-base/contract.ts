import path from "node:path";

export type PathCheck = { ok: true; normalized: string } | { ok: false; error: string };

export type ReadWindow =
  | {
      ok: true;
      start: number;
      end: number;
      totalLines: number;
      remaining: number;
      text: string;
    }
  | { ok: false; error: string };

/** Default page size for kbDocRead when end is omitted, and for the next-window hint. */
export const DEFAULT_READ_LINES = 200;

/** Default page size for kbDocList, and for the next-page hint. */
export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 100;

export type TextEdit = { oldText: string; newText: string };

export type ApplyEditResult =
  | { ok: true; updatedText: string; line: number }
  | { ok: false; error: string; unchangedText: string };

export type KbHit = {
  collection: string;
  documentPath: string;
  snippet: string;
  line?: number;
  score?: number;
  context?: string;
};

export function rejectPath(input: string, field = "documentPath"): PathCheck {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: `${field} must be a non-empty relative path` };
  }

  if (path.posix.isAbsolute(trimmed) || path.isAbsolute(trimmed)) {
    return { ok: false, error: `${field} must be relative, absolute paths are not allowed` };
  }

  const segments = trimmed.split(/[\\/]+/);
  if (segments.some((segment) => segment === "..")) {
    return { ok: false, error: `${field} cannot contain .. segments` };
  }

  return { ok: true, normalized: trimmed.replace(/\\/g, "/") };
}

/** Optional directory under a collection for kbDocList / kbDocTree. Empty means the collection root. */
export function rejectOptionalListPath(input: string | undefined): PathCheck {
  if (input === undefined || input.trim().length === 0) {
    return { ok: true, normalized: "" };
  }
  return rejectPath(input, "path");
}

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  return text.split("\n");
}

export type ReadWindowMeta = {
  collection?: string;
  documentPath?: string;
};

/**
 * skill_view-style progress around a numbered body. Matches
 * `(printed from line X to line Y, remaining Z lines)` and the
 * `Call … to load the next window` hint; adds `of TOTAL` and optional
 * lines-before when the window does not start at index 0.
 */
export function formatReadProgress(opts: {
  start: number;
  end: number;
  totalLines: number;
  remaining: number;
  body: string;
  collection?: string;
  documentPath?: string;
}): string {
  const before = opts.start;
  const beforeClause = before > 0 ? `, ${before} lines before` : "";
  const identity =
    opts.collection !== undefined && opts.documentPath !== undefined
      ? `  collection ${opts.collection}  documentPath ${opts.documentPath}`
      : "";
  const header = `# kbDocRead${identity}  (printed from line ${opts.start} to line ${opts.end} of ${opts.totalLines}${beforeClause}, remaining ${opts.remaining} lines)`;
  const lines = [header];
  if (opts.remaining > 0) {
    const nextStart = opts.end + 1;
    const nextEnd = Math.min(opts.end + DEFAULT_READ_LINES, opts.totalLines - 1);
    const callArgs =
      opts.collection !== undefined && opts.documentPath !== undefined
        ? `collection=${opts.collection} documentPath=${opts.documentPath} start=${nextStart} end=${nextEnd}`
        : `start=${nextStart} end=${nextEnd}`;
    lines.push(`# Call kbDocRead with ${callArgs} to load the next window.`);
  }
  lines.push("");
  lines.push(opts.body);
  return lines.join("\n");
}

/** One indexed file from `qmd ls` (collection-relative path, no qmd://). */
export type IndexedFile = {
  size: string;
  mtime: string;
  documentPath: string;
};

/** Immediate child of a directory for kbDocList. */
export type DirChild =
  | { kind: "file"; size: string; mtime: string; documentPath: string }
  | { kind: "dir"; documentPath: string };

/**
 * Appended to a listing entry that exists on disk but is not in the backend index.
 * Such a file is readable by path with kbDocRead, but kbSearch cannot find it.
 */
export const UNINDEXED_SUFFIX = "  [unindexed]";

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** `qmd ls`-style size: `N B` below 1 KiB, otherwise one decimal and a unit. */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

/** `qmd ls`-style mtime: `Mon DD HH:MM`, the only shape qmd itself prints. */
export function formatFileMtime(date: Date): string {
  if (Number.isNaN(date.getTime())) return "Jan  1 00:00";
  const month = MONTH_NAMES[date.getMonth()];
  const day = String(date.getDate()).padStart(2, " ");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${month} ${day} ${hours}:${minutes}`;
}

export type BrowseToolName = "kbDocList" | "kbDocTree";

export type BrowsePage =
  | {
      ok: true;
      start: number;
      end: number;
      total: number;
      remaining: number;
      text: string;
    }
  | { ok: false; error: string };

export type BrowsePageMeta = {
  tool: BrowseToolName;
  collection: string;
  path: string;
};

/**
 * Progress header around a kbDocList / kbDocTree page. Matches
 * `(printed entries X through Y of TOTAL, remaining Z)` and the
 * next-call hint when remaining > 0.
 */
export function formatBrowseProgress(opts: {
  tool: BrowseToolName;
  collection: string;
  path: string;
  start: number;
  end: number;
  total: number;
  remaining: number;
  body: string;
}): string {
  const pathClause = opts.path.length > 0 ? `  path ${opts.path}` : "";
  const header = `# ${opts.tool}  collection ${opts.collection}${pathClause}  (printed entries ${opts.start} through ${opts.end} of ${opts.total}, remaining ${opts.remaining})`;
  const lines = [header];
  if (opts.remaining > 0) {
    const nextStart = opts.end + 1;
    const pathArg = opts.path.length > 0 ? ` path=${opts.path}` : "";
    lines.push(
      `# Call ${opts.tool} with collection=${opts.collection}${pathArg} start=${nextStart} to load the next page.`,
    );
  }
  lines.push("");
  lines.push(opts.body);
  return lines.join("\n");
}

export function formatDirChild(entry: DirChild, unindexed = false): string {
  if (entry.kind === "dir") return `${entry.documentPath}/`;
  return `${entry.size}  ${entry.mtime}  ${entry.documentPath}${unindexed ? UNINDEXED_SUFFIX : ""}`;
}

export function formatIndexedFile(entry: IndexedFile, unindexed = false): string {
  return `${entry.size}  ${entry.mtime}  ${entry.documentPath}${unindexed ? UNINDEXED_SUFFIX : ""}`;
}

function normalizeDirPrefix(dirPath: string): string {
  if (dirPath.length === 0) return "";
  return dirPath.replace(/\/+$/, "") + "/";
}

/**
 * Immediate children of `dirPath` (empty = collection root), derived from a recursive file listing.
 * A name is a directory when any listed path has that prefix plus another segment.
 * `extraDirs` adds directories found on disk that hold no listed file, so an empty directory still shows.
 */
export function immediateChildren(
  files: IndexedFile[],
  dirPath: string,
  extraDirs: string[] = [],
): DirChild[] {
  const prefix = normalizeDirPrefix(dirPath);
  const byName = new Map<string, DirChild>();

  for (const file of files) {
    if (prefix.length > 0 && !file.documentPath.startsWith(prefix)) continue;
    const rest = file.documentPath.slice(prefix.length);
    if (rest.length === 0) continue;
    const slash = rest.indexOf("/");
    if (slash === -1) {
      const existing = byName.get(rest);
      if (existing?.kind === "dir") continue;
      byName.set(rest, {
        kind: "file",
        size: file.size,
        mtime: file.mtime,
        documentPath: file.documentPath,
      });
      continue;
    }
    const name = rest.slice(0, slash);
    if (!byName.has(name) || byName.get(name)?.kind === "file") {
      byName.set(name, { kind: "dir", documentPath: `${prefix}${name}` });
    }
  }

  for (const dirPathEntry of extraDirs) {
    if (prefix.length > 0 && !dirPathEntry.startsWith(prefix)) continue;
    const rest = dirPathEntry.slice(prefix.length);
    if (rest.length === 0 || rest.includes("/")) continue;
    if (!byName.has(rest)) {
      byName.set(rest, { kind: "dir", documentPath: dirPathEntry });
    }
  }

  return [...byName.values()].sort((a, b) => {
    const aName = a.documentPath.slice(prefix.length);
    const bName = b.documentPath.slice(prefix.length);
    return compareStrings(aName, bName);
  });
}

/** Plain code-unit string order, used wherever listings are sorted. */
export function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Files under `dirPath` (empty = whole collection), still recursive. */
export function filesUnderPath(files: IndexedFile[], dirPath: string): IndexedFile[] {
  if (dirPath.length === 0) return files;
  const prefix = normalizeDirPrefix(dirPath);
  return files.filter((file) => file.documentPath.startsWith(prefix));
}

export function sliceBrowsePage(
  lines: string[],
  start: number | undefined,
  limit: number | undefined,
  meta: BrowsePageMeta,
): BrowsePage {
  const total = lines.length;
  const effectiveStart = start ?? 0;
  const effectiveLimit = limit ?? DEFAULT_LIST_LIMIT;

  if (!Number.isInteger(effectiveStart) || effectiveStart < 0) {
    return { ok: false, error: "start must be an integer >= 0" };
  }
  if (!Number.isInteger(effectiveLimit) || effectiveLimit < 1 || effectiveLimit > MAX_LIST_LIMIT) {
    return { ok: false, error: `limit must be an integer from 1 to ${MAX_LIST_LIMIT}` };
  }

  if (effectiveStart >= total) {
    return {
      ok: false,
      error: `start ${effectiveStart} is past the end of this listing (${total} entries)`,
    };
  }

  const effectiveEnd = Math.min(effectiveStart + effectiveLimit - 1, total - 1);
  const remaining = total - effectiveEnd - 1;
  const body = lines.slice(effectiveStart, effectiveEnd + 1).join("\n");
  return {
    ok: true,
    start: effectiveStart,
    end: effectiveEnd,
    total,
    remaining,
    text: formatBrowseProgress({
      tool: meta.tool,
      collection: meta.collection,
      path: meta.path,
      start: effectiveStart,
      end: effectiveEnd,
      total,
      remaining,
      body,
    }),
  };
}

export function sliceReadWindow(
  documentText: string,
  start?: number,
  end?: number,
  meta?: ReadWindowMeta,
): ReadWindow {
  const lines = splitLines(documentText);
  const totalLines = lines.length;

  if (start !== undefined && (!Number.isInteger(start) || start < 0)) {
    return { ok: false, error: "start must be an integer >= 0" };
  }
  if (end !== undefined && (!Number.isInteger(end) || end < 0)) {
    return { ok: false, error: "end must be an integer >= 0" };
  }

  const effectiveStart = start ?? 0;
  const requestedEnd = end ?? effectiveStart + DEFAULT_READ_LINES - 1;
  if (requestedEnd < effectiveStart) {
    return { ok: false, error: "end must be >= start" };
  }

  if (effectiveStart >= totalLines) {
    return {
      ok: false,
      error: `start line ${effectiveStart} is past the end of this document (${totalLines} lines)`,
    };
  }

  const effectiveEnd = Math.min(requestedEnd, totalLines - 1);
  const remaining = totalLines - effectiveEnd - 1;
  const window = lines.slice(effectiveStart, effectiveEnd + 1);
  const body = formatNumberedLines(window, effectiveStart);
  return {
    ok: true,
    start: effectiveStart,
    end: effectiveEnd,
    totalLines,
    remaining,
    text: formatReadProgress({
      start: effectiveStart,
      end: effectiveEnd,
      totalLines,
      remaining,
      body,
      collection: meta?.collection,
      documentPath: meta?.documentPath,
    }),
  };
}

export function formatNumberedLines(lines: string[], firstLine: number): string {
  return lines.map((line, index) => `${firstLine + index}|${line}`).join("\n");
}

function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function detectLineEnding(content: string): "\n" | "\r\n" {
  const crlfIdx = content.indexOf("\r\n");
  const lfIdx = content.indexOf("\n");
  if (lfIdx === -1 || crlfIdx === -1) return "\n";
  return crlfIdx < lfIdx ? "\r\n" : "\n";
}

function restoreLineEndings(text: string, ending: "\n" | "\r\n"): string {
  return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

function splitBom(text: string): { bom: string; text: string } {
  if (text.charCodeAt(0) === 0xfeff) return { bom: "\uFEFF", text: text.slice(1) };
  return { bom: "", text };
}

/** Trailing whitespace, smart quotes, dashes, and special spaces fold to ASCII. Newlines stay. */
function normalizeForFuzzyMatch(text: string): string {
  return text
    .normalize("NFKC")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

type FuzzyMatch = {
  found: boolean;
  index: number;
  matchLength: number;
  usedFuzzyMatch: boolean;
};

function fuzzyFindText(content: string, oldText: string): FuzzyMatch {
  const exactIndex = content.indexOf(oldText);
  if (exactIndex !== -1) {
    return { found: true, index: exactIndex, matchLength: oldText.length, usedFuzzyMatch: false };
  }
  const fuzzyContent = normalizeForFuzzyMatch(content);
  const fuzzyOldText = normalizeForFuzzyMatch(oldText);
  const fuzzyIndex = fuzzyOldText.length === 0 ? -1 : fuzzyContent.indexOf(fuzzyOldText);
  if (fuzzyIndex === -1) {
    return { found: false, index: -1, matchLength: 0, usedFuzzyMatch: false };
  }
  return {
    found: true,
    index: fuzzyIndex,
    matchLength: fuzzyOldText.length,
    usedFuzzyMatch: true,
  };
}

function countOccurrences(content: string, oldText: string): number {
  const fuzzyContent = normalizeForFuzzyMatch(content);
  const fuzzyOldText = normalizeForFuzzyMatch(oldText);
  if (fuzzyOldText.length === 0) return 0;
  return fuzzyContent.split(fuzzyOldText).length - 1;
}

function fail(documentText: string, error: string): ApplyEditResult {
  return { ok: false, error, unchangedText: documentText };
}

function emptyOldTextError(label: string, editIndex: number, totalEdits: number): string {
  if (totalEdits === 1) return `oldText must not be empty in ${label}.`;
  return `edits[${editIndex}].oldText must not be empty in ${label}.`;
}

function notFoundError(label: string, editIndex: number, totalEdits: number): string {
  if (totalEdits === 1) {
    return `Could not find the exact text in ${label}. The old text must match exactly including all whitespace and newlines.`;
  }
  return `Could not find edits[${editIndex}] in ${label}. The oldText must match exactly including all whitespace and newlines.`;
}

function duplicateError(label: string, editIndex: number, totalEdits: number, occurrences: number): string {
  if (totalEdits === 1) {
    return `Found ${occurrences} occurrences of the text in ${label}. The text must be unique. Please provide more context to make it unique.`;
  }
  return `Found ${occurrences} occurrences of edits[${editIndex}] in ${label}. Each oldText must be unique. Please provide more context to make it unique.`;
}

function noChangeError(label: string, totalEdits: number): string {
  if (totalEdits === 1) {
    return `No changes made to ${label}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`;
  }
  return `No changes made to ${label}. The replacements produced identical content.`;
}

type MatchedEdit = {
  editIndex: number;
  matchIndex: number;
  matchLength: number;
  newText: string;
};

function applyReplacements(content: string, replacements: MatchedEdit[], offset = 0): string {
  let result = content;
  for (let i = replacements.length - 1; i >= 0; i--) {
    const replacement = replacements[i];
    const matchIndex = replacement.matchIndex - offset;
    result =
      result.slice(0, matchIndex) +
      replacement.newText +
      result.slice(matchIndex + replacement.matchLength);
  }
  return result;
}

function splitLinesWithEndings(content: string): string[] {
  return content.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

function lineSpans(content: string): Array<{ start: number; end: number }> {
  let offset = 0;
  return splitLinesWithEndings(content).map((line) => {
    const span = { start: offset, end: offset + line.length };
    offset = span.end;
    return span;
  });
}

function replacementLineRange(
  lines: Array<{ start: number; end: number }>,
  replacement: MatchedEdit,
): { startLine: number; endLine: number } {
  const replacementStart = replacement.matchIndex;
  const replacementEnd = replacement.matchIndex + replacement.matchLength;
  let startLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (replacementStart >= line.start && replacementStart < line.end) {
      startLine = i;
      break;
    }
  }
  if (startLine === -1) throw new Error("Replacement range is outside the base content.");
  let endLine = startLine;
  while (endLine < lines.length && lines[endLine].end < replacementEnd) endLine++;
  if (endLine >= lines.length) throw new Error("Replacement range is outside the base content.");
  return { startLine, endLine: endLine + 1 };
}

function applyReplacementsPreservingUnchangedLines(
  originalContent: string,
  baseContent: string,
  replacements: MatchedEdit[],
): string {
  const originalLines = splitLinesWithEndings(originalContent);
  const baseLines = lineSpans(baseContent);
  if (originalLines.length !== baseLines.length) {
    throw new Error("Cannot preserve unchanged lines because the base content has a different line count.");
  }
  const groups: Array<{ startLine: number; endLine: number; replacements: MatchedEdit[] }> = [];
  const sorted = [...replacements].sort((a, b) => a.matchIndex - b.matchIndex);
  for (const replacement of sorted) {
    const range = replacementLineRange(baseLines, replacement);
    const current = groups[groups.length - 1];
    if (current && range.startLine < current.endLine) {
      current.endLine = Math.max(current.endLine, range.endLine);
      current.replacements.push(replacement);
      continue;
    }
    groups.push({ ...range, replacements: [replacement] });
  }
  let originalLineIndex = 0;
  let result = "";
  for (const group of groups) {
    result += originalLines.slice(originalLineIndex, group.startLine).join("");
    const groupStartOffset = baseLines[group.startLine].start;
    const groupEndOffset = baseLines[group.endLine - 1].end;
    result += applyReplacements(
      baseContent.slice(groupStartOffset, groupEndOffset),
      group.replacements,
      groupStartOffset,
    );
    originalLineIndex = group.endLine;
  }
  result += originalLines.slice(originalLineIndex).join("");
  return result;
}

/**
 * Apply one or more exact-text replacements the way Pi's `edit` tool does.
 * Every oldText is matched against the original document. Replacements are applied
 * from the end so offsets stay valid. Fuzzy matches rewrite only the lines they touch.
 */
export function applyDocumentEdits(
  documentText: string,
  edits: TextEdit[],
  label = "document",
): ApplyEditResult {
  if (!Array.isArray(edits) || edits.length === 0) {
    return fail(documentText, "edits must contain at least one replacement.");
  }

  const { bom, text } = splitBom(documentText);
  const ending = detectLineEnding(text);
  const normalizedContent = normalizeToLF(text);
  const normalizedEdits = edits.map((edit) => ({
    oldText: normalizeToLF(edit.oldText),
    newText: normalizeToLF(edit.newText),
  }));

  for (let i = 0; i < normalizedEdits.length; i++) {
    if (normalizedEdits[i].oldText.length === 0) {
      return fail(documentText, emptyOldTextError(label, i, normalizedEdits.length));
    }
  }

  const initialMatches = normalizedEdits.map((edit) => fuzzyFindText(normalizedContent, edit.oldText));
  const usedFuzzyMatch = initialMatches.some((match) => match.usedFuzzyMatch);
  const replacementBaseContent = usedFuzzyMatch
    ? normalizeForFuzzyMatch(normalizedContent)
    : normalizedContent;

  const matchedEdits: MatchedEdit[] = [];
  for (let i = 0; i < normalizedEdits.length; i++) {
    const edit = normalizedEdits[i];
    const matchResult = fuzzyFindText(replacementBaseContent, edit.oldText);
    if (!matchResult.found) return fail(documentText, notFoundError(label, i, normalizedEdits.length));
    const occurrences = countOccurrences(replacementBaseContent, edit.oldText);
    if (occurrences > 1) {
      return fail(documentText, duplicateError(label, i, normalizedEdits.length, occurrences));
    }
    matchedEdits.push({
      editIndex: i,
      matchIndex: matchResult.index,
      matchLength: matchResult.matchLength,
      newText: edit.newText,
    });
  }

  matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex);
  for (let i = 1; i < matchedEdits.length; i++) {
    const previous = matchedEdits[i - 1];
    const current = matchedEdits[i];
    if (previous.matchIndex + previous.matchLength > current.matchIndex) {
      return fail(
        documentText,
        `edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${label}. Merge them into one edit or target disjoint regions.`,
      );
    }
  }

  let newContent: string;
  try {
    newContent = usedFuzzyMatch
      ? applyReplacementsPreservingUnchangedLines(normalizedContent, replacementBaseContent, matchedEdits)
      : applyReplacements(replacementBaseContent, matchedEdits);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(documentText, message);
  }

  if (normalizedContent === newContent) {
    return fail(documentText, noChangeError(label, normalizedEdits.length));
  }

  const line = replacementBaseContent.slice(0, matchedEdits[0].matchIndex).split("\n").length - 1;
  return { ok: true, updatedText: bom + restoreLineEndings(newContent, ending), line };
}

export function shapeHit(input: {
  collection: string;
  documentPath: string;
  snippet: string;
  line?: number;
  score?: number;
  context?: string;
}): KbHit {
  const snippet = input.snippet.length > 2000 ? input.snippet.slice(0, 2000) : input.snippet;
  return {
    collection: input.collection,
    documentPath: input.documentPath.replace(/\\/g, "/"),
    snippet,
    ...(input.line !== undefined ? { line: input.line } : {}),
    ...(input.score !== undefined ? { score: input.score } : {}),
    ...(input.context !== undefined ? { context: input.context } : {}),
  };
}
