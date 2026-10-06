import fs, { type Dirent } from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

import {
  applyDocumentEdits,
  compareStrings,
  filesUnderPath,
  formatDirChild,
  formatFileMtime,
  formatFileSize,
  formatIndexedFile,
  immediateChildren,
  rejectOptionalListPath,
  rejectPath,
  shapeHit,
  sliceBrowsePage,
  sliceReadWindow,
  type IndexedFile,
  type KbHit,
  type TextEdit,
} from "./contract.ts";

export type QmdMode = "semantic" | "keyword" | "hybrid";

export type QmdCliResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type QmdCliRunner = (argv: string[]) => Promise<QmdCliResult>;

export type QmdInspectResult =
  | { ok: true; rootDir: string; updateCommand: string }
  | { ok: false; error: string };

export type QmdCollectionInspector = (collection: string) => Promise<QmdInspectResult>;

export type QmdRefreshRunner = (collection: string) => Promise<void>;

export type QmdCollectionRecord = {
  name: string;
  path: string;
  updateCommand: string;
};

/** One entry found on disk under a collection root; `documentPath` is relative to that root. */
export type DiskWalkEntry =
  | { kind: "file"; documentPath: string; sizeBytes: number; mtimeMs: number }
  | { kind: "dir"; documentPath: string };

export type DiskWalk = { entries: DiskWalkEntry[]; truncated: boolean };

export type DiskWalker = (rootDir: string) => Promise<DiskWalk>;

/** Directories a disk walk never descends into. A cloned corpus carries a full `.git` tree. */
export const SKIP_WALK_DIRS = new Set([".git", ".hg", ".svn"]);

/** Safety caps so a pathological tree cannot make one listing unbounded. */
export const MAX_WALK_ENTRIES = 5000;
export const MAX_WALK_DEPTH = 16;

export type QmdPackageResolution =
  | { ok: true; packageRoot: string; moduleResolveCwd: string }
  | { ok: false; error: string };

export type QmdPackageResolver = () => QmdPackageResolution;

export type QmdAdapterDeps = {
  allowlistedCollections: string[];
  runCli: QmdCliRunner;
  inspectCollection: QmdCollectionInspector;
  refreshCollection: QmdRefreshRunner;
  /** When set, called after a unique match is ready and before any write. */
  ensureRefreshReady?: () => QmdPackageResolution | { ok: true } | { ok: false; error: string };
  readFile?: (filePath: string) => Promise<string>;
  writeFile?: (filePath: string, content: string) => Promise<void>;
  /** Parent directory of a newly created document. Defaults to a recursive mkdir. */
  mkdir?: (dirPath: string) => Promise<void>;
  /**
   * Recursive on-disk listing of a collection root. `qmd ls` only reports indexed
   * files, so the walk is what makes a file the backend never indexed discoverable.
   */
  walkCollection?: DiskWalker;
};

export type QmdAdapter = {
  search(args: {
    mode: QmdMode;
    searchTerm: string;
    collection: string;
    limit?: number;
  }): Promise<{ ok: true; hits: KbHit[] } | { ok: false; error: string }>;
  read(args: {
    collection: string;
    documentPath: string;
    start?: number;
    end?: number;
  }): Promise<{ ok: true; text: string } | { ok: false; error: string }>;
  edit(args: {
    collection: string;
    documentPath: string;
    edits: TextEdit[];
  }): Promise<{ ok: true; documentPath: string; line: number } | { ok: false; error: string }>;
  create(args: {
    collection: string;
    documentPath: string;
    content: string;
  }): Promise<{ ok: true; documentPath: string } | { ok: false; error: string }>;
  listCollections(): Promise<{ ok: true; collections: Array<{ name: string; path: string }> } | { ok: false; error: string }>;
  listDocs(args: {
    collection: string;
    path?: string;
    start?: number;
    limit?: number;
  }): Promise<{ ok: true; text: string } | { ok: false; error: string }>;
  listTree(args: {
    collection: string;
    path?: string;
    start?: number;
    limit?: number;
  }): Promise<{ ok: true; text: string } | { ok: false; error: string }>;
};

function badInput(message: string) {
  return { ok: false as const, error: message };
}

/** A value `JSON.parse` can return. Parsing happens only at this boundary. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

type JsonParse = { ok: true; value: JsonValue } | { ok: false; error: string };

function parseJson(stdout: string): JsonParse {
  try {
    return { ok: true, value: JSON.parse(stdout) as JsonValue };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.results)) return record.results;
    if (Array.isArray(record.hits)) return record.hits;
    if (Array.isArray(record.items)) return record.items;
    if (Array.isArray(record.collections)) return record.collections;
  }
  return [];
}

function parseHitPath(raw: unknown, collectionRoot: string): string | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  if (raw.startsWith("qmd://")) {
    const withoutScheme = raw.slice("qmd://".length);
    const slash = withoutScheme.indexOf("/");
    if (slash === -1 || slash === withoutScheme.length - 1) return undefined;
    return withoutScheme.slice(slash + 1).replace(/\\/g, "/");
  }
  const absolute = path.resolve(raw);
  const root = path.resolve(collectionRoot);
  const rel = path.relative(root, absolute);
  if (!rel.startsWith("..") && !path.isAbsolute(rel)) return rel.replace(/\\/g, "/");
  return raw.replace(/\\/g, "/");
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

/** Convert a qmd-reported 1-based line to the contract's 0-based index. */
function qmdLineToZeroBased(value: unknown): number | undefined {
  const raw = asNumber(value);
  if (raw === undefined) return undefined;
  if (!Number.isInteger(raw) || raw < 1) return undefined;
  return raw - 1;
}

function parseSearchHits(stdout: string, collection: string, collectionRoot: string): KbHit[] {
  const parsed = parseJson(stdout);
  if (!parsed.ok) return [];
  const rows = asArray(parsed.value);
  const out: KbHit[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const hit = row as Record<string, unknown>;
    const relPath = parseHitPath(
      hit.documentPath ?? hit.path ?? hit.file ?? hit.uri,
      collectionRoot,
    );
    if (!relPath) continue;
    const rawSnippet = hit.snippet ?? hit.text ?? hit.content ?? "";
    if (typeof rawSnippet !== "string") continue;
    out.push(
      shapeHit({
        collection,
        documentPath: relPath,
        snippet: rawSnippet,
        line: qmdLineToZeroBased(hit.line ?? hit.start_line),
        score: asNumber(hit.score),
        context: typeof hit.context === "string" ? hit.context : undefined,
      }),
    );
  }
  return out;
}

/** Parse one `qmd ls` line into size, mtime, and collection-relative documentPath. Paths may contain spaces. */
export function parseQmdLsLine(
  line: string,
  collection: string,
): IndexedFile | undefined {
  const text = stripAnsi(line).trimEnd();
  if (text.trim().length === 0) return undefined;
  const match = text.match(
    /^\s*(\d+(?:\.\d+)?\s+[A-Za-z]+)\s+(\w{3}\s+\d{1,2}\s+\d{2}:\d{2})\s+(qmd:\/\/.+)$/,
  );
  if (!match) return undefined;
  const [, size, mtime, uriRaw] = match;
  const uri = uriRaw.trimEnd();
  const prefix = `qmd://${collection}/`;
  if (!uri.startsWith(prefix)) return undefined;
  const documentPath = uri.slice(prefix.length).replace(/\\/g, "/");
  if (documentPath.length === 0) return undefined;
  return { size: size.trim(), mtime: mtime.trim(), documentPath };
}

export function parseQmdLsStdout(stdout: string, collection: string): IndexedFile[] {
  const entries: IndexedFile[] = [];
  for (const line of stripAnsi(stdout).split(/\r?\n/)) {
    const entry = parseQmdLsLine(line, collection);
    if (entry) entries.push(entry);
  }
  return entries;
}

function limitOrError(limit: number | undefined): { ok: true; limit: number } | { ok: false; error: string } {
  const value = limit ?? 10;
  if (!Number.isInteger(value) || value < 1 || value > 20) {
    return badInput("limit must be an integer from 1 to 20");
  }
  return { ok: true, limit: value };
}

function listLimitOrError(
  limit: number | undefined,
): { ok: true; limit: number } | { ok: false; error: string } {
  const value = limit ?? 50;
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    return badInput("limit must be an integer from 1 to 100");
  }
  return { ok: true, limit: value };
}

function listStartOrError(
  start: number | undefined,
): { ok: true; start: number } | { ok: false; error: string } {
  const value = start ?? 0;
  if (!Number.isInteger(value) || value < 0) {
    return badInput("start must be an integer >= 0");
  }
  return { ok: true, start: value };
}

function trimmedNonEmpty(value: string, field: string): { ok: true; value: string } | { ok: false; error: string } {
  if (value.trim().length === 0) return badInput(`${field} must be non-empty`);
  return { ok: true, value };
}

function modeCommand(mode: QmdMode): "vsearch" | "search" | "query" {
  if (mode === "semantic") return "vsearch";
  if (mode === "keyword") return "search";
  return "query";
}

function byDocumentPath(a: { documentPath: string }, b: { documentPath: string }): number {
  return compareStrings(a.documentPath, b.documentPath);
}

/**
 * Recursive on-disk listing of a collection root. Symlinks are skipped (they can escape the
 * root or form a loop), the skip-list directories are never entered, and both a depth and an
 * entry cap bound the walk. A read error on one directory skips that directory, not the walk.
 */
export function createDefaultDiskWalker(): DiskWalker {
  return async (rootDir: string) => {
    const entries: DiskWalkEntry[] = [];
    let truncated = false;

    const visit = async (relativeDir: string, depth: number): Promise<void> => {
      if (truncated || depth > MAX_WALK_DEPTH) return;
      const absoluteDir = relativeDir.length === 0 ? rootDir : path.join(rootDir, relativeDir);
      let dirents: Dirent[];
      try {
        dirents = await fsPromises.readdir(absoluteDir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const dirent of dirents) {
        if (entries.length >= MAX_WALK_ENTRIES) {
          truncated = true;
          return;
        }
        if (dirent.isSymbolicLink()) continue;
        const childRelative =
          relativeDir.length === 0 ? dirent.name : `${relativeDir}/${dirent.name}`;
        if (dirent.isDirectory()) {
          if (SKIP_WALK_DIRS.has(dirent.name)) continue;
          entries.push({ kind: "dir", documentPath: childRelative });
          await visit(childRelative, depth + 1);
          continue;
        }
        if (!dirent.isFile()) continue;
        try {
          const stats = await fsPromises.stat(path.join(rootDir, childRelative));
          entries.push({
            kind: "file",
            documentPath: childRelative,
            sizeBytes: stats.size,
            mtimeMs: stats.mtimeMs,
          });
        } catch {
          // A file that vanished mid-walk is left out of the listing.
        }
      }
    };

    await visit("", 0);
    entries.sort(byDocumentPath);
    return { entries, truncated };
  };
}

export type MergedListing = {
  /** Every indexed file plus every on-disk file, sorted by documentPath. On-disk size and mtime win. */
  files: IndexedFile[];
  /** Directories found on disk, including ones holding no indexed file. */
  dirs: string[];
  /** documentPaths the backend index actually contains. Anything else is unindexed. */
  indexedPaths: Set<string>;
  truncated: boolean;
};

/** Union the index listing with the on-disk listing, so files the backend never indexed are visible. */
export function mergeIndexedWithDisk(indexed: IndexedFile[], walk: DiskWalk): MergedListing {
  const byPath = new Map<string, IndexedFile>();
  for (const file of indexed) byPath.set(file.documentPath, file);
  const indexedPaths = new Set(byPath.keys());

  const dirs: string[] = [];
  for (const entry of walk.entries) {
    if (entry.kind === "dir") {
      dirs.push(entry.documentPath);
      continue;
    }
    byPath.set(entry.documentPath, {
      size: formatFileSize(entry.sizeBytes),
      mtime: formatFileMtime(new Date(entry.mtimeMs)),
      documentPath: entry.documentPath,
    });
  }

  return {
    files: [...byPath.values()].sort(byDocumentPath),
    dirs: dirs.sort(compareStrings),
    indexedPaths,
    truncated: walk.truncated,
  };
}

/** True when `subPath` is the collection root, a listed directory, or a prefix of a listed path. */
function listingHasPath(listing: MergedListing, subPath: string): boolean {
  if (subPath.length === 0) return true;
  const prefix = `${subPath}/`;
  const contains = (candidate: string) =>
    candidate === subPath || candidate.startsWith(prefix);
  return listing.files.some((file) => contains(file.documentPath)) || listing.dirs.some(contains);
}

function withTruncationNote(text: string, truncated: boolean): string {
  if (!truncated) return text;
  return `${text}\n# The on-disk listing stopped at ${MAX_WALK_ENTRIES} entries; files past that are not listed.`;
}

export function createQmdAdapter(
  deps: QmdAdapterDeps,
): QmdAdapter {
  const allowlistedCollections = new Set(deps.allowlistedCollections);
  const walkCollection = deps.walkCollection ?? createDefaultDiskWalker();
  const readFile = deps.readFile ?? ((filePath: string) => fsPromises.readFile(filePath, "utf8"));
  const writeFile =
    deps.writeFile ??
    ((filePath: string, content: string) => fsPromises.writeFile(filePath, content, "utf8"));
  const mkdir =
    deps.mkdir ??
    (async (dirPath: string) => {
      await fsPromises.mkdir(dirPath, { recursive: true });
    });

  function ensureAllowlisted(collection: string): { ok: true; collection: string } | { ok: false; error: string } {
    if (!allowlistedCollections.has(collection)) {
      return badInput(`collection is not allowlisted: ${collection}`);
    }
    return { ok: true, collection };
  }

  type ListingSource =
    | { ok: true; indexed: IndexedFile[]; walk: DiskWalk }
    | { ok: false; error: string };

  /**
   * One `qmd ls` plus one on-disk walk for the collection. A walk failure degrades to the
   * indexed listing alone: a listing must not fail because the filesystem was unreadable.
   */
  async function collectListing(collection: string): Promise<ListingSource> {
    const inspected = await deps.inspectCollection(collection);
    if (!inspected.ok) return badInput(inspected.error);

    const result = await deps.runCli(["qmd", "ls", collection]);
    if (!result.ok) return badInput(`qmd ls failed: ${result.stderr || result.stdout}`);

    const indexed = parseQmdLsStdout(result.stdout, collection);
    let walk: DiskWalk;
    try {
      walk = await walkCollection(inspected.rootDir);
    } catch {
      walk = { entries: [], truncated: false };
    }
    return { ok: true, indexed, walk };
  }

  async function search(args: {
    mode: QmdMode;
    searchTerm: string;
    collection: string;
    limit?: number;
  }) {
    const allowlisted = ensureAllowlisted(args.collection);
    if (!allowlisted.ok) return allowlisted;

    const query = trimmedNonEmpty(args.searchTerm, "searchTerm");
    if (!query.ok) return query;
    const limit = limitOrError(args.limit);
    if (!limit.ok) return limit;

    const inspected = await deps.inspectCollection(allowlisted.collection);
    if (!inspected.ok) return badInput(inspected.error);

    const argv = [
      "qmd",
      modeCommand(args.mode),
      "-c",
      allowlisted.collection,
      "--json",
      "-n",
      String(limit.limit),
      query.value,
    ];
    const result = await deps.runCli(argv);
    if (!result.ok) return badInput(`qmd ${argv[1]} failed: ${result.stderr || result.stdout}`);

    return {
      ok: true as const,
      hits: parseSearchHits(result.stdout, allowlisted.collection, inspected.rootDir),
    };
  }

  async function read(args: { collection: string; documentPath: string; start?: number; end?: number }) {
    const allowlisted = ensureAllowlisted(args.collection);
    if (!allowlisted.ok) return allowlisted;

    const checkedPath = rejectPath(args.documentPath);
    if (!checkedPath.ok) return checkedPath;

    const inspected = await deps.inspectCollection(allowlisted.collection);
    if (!inspected.ok) return badInput(inspected.error);

    const absPath = path.resolve(inspected.rootDir, checkedPath.normalized);
    const rel = path.relative(path.resolve(inspected.rootDir), absPath);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      return badInput("documentPath resolves outside the qmd collection root");
    }

    let documentText: string;
    try {
      documentText = await readFile(absPath);
    } catch {
      return badInput(`document not found: ${checkedPath.normalized}`);
    }

    const window = sliceReadWindow(
      documentText.replace(/\r\n/g, "\n").replace(/\n$/, ""),
      args.start,
      args.end,
      { collection: allowlisted.collection, documentPath: checkedPath.normalized },
    );
    if (!window.ok) return window;
    return { ok: true as const, text: window.text };
  }

  async function edit(args: {
    collection: string;
    documentPath: string;
    edits: TextEdit[];
  }) {
    const allowlisted = ensureAllowlisted(args.collection);
    if (!allowlisted.ok) return allowlisted;

    const checkedPath = rejectPath(args.documentPath);
    if (!checkedPath.ok) return checkedPath;

    const firstInspect = await deps.inspectCollection(allowlisted.collection);
    if (!firstInspect.ok) return badInput(firstInspect.error);

    const absPath = path.resolve(firstInspect.rootDir, checkedPath.normalized);
    const rel = path.relative(path.resolve(firstInspect.rootDir), absPath);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      return badInput("documentPath resolves outside the qmd collection root");
    }

    let before: string;
    try {
      before = await readFile(absPath);
    } catch {
      return badInput(`document not found: ${checkedPath.normalized}`);
    }

    const applied = applyDocumentEdits(before, args.edits, checkedPath.normalized);
    if (!applied.ok) {
      return badInput(applied.error);
    }

    const secondInspect = await deps.inspectCollection(allowlisted.collection);
    if (!secondInspect.ok) return badInput(secondInspect.error);
    if (secondInspect.updateCommand.trim().length > 0) {
      return badInput("refusing write because qmd collection update command is set");
    }

    if (deps.ensureRefreshReady) {
      const ready = deps.ensureRefreshReady();
      if (!ready.ok) return badInput(ready.error);
    }

    await writeFile(absPath, applied.updatedText);
    await deps.refreshCollection(allowlisted.collection);
    await deps.runCli(["qmd", "embed", "-c", allowlisted.collection]);

    return { ok: true as const, documentPath: checkedPath.normalized, line: applied.line };
  }

  async function create(args: { collection: string; documentPath: string; content: string }) {
    const allowlisted = ensureAllowlisted(args.collection);
    if (!allowlisted.ok) return allowlisted;

    const checkedPath = rejectPath(args.documentPath);
    if (!checkedPath.ok) return checkedPath;

    const firstInspect = await deps.inspectCollection(allowlisted.collection);
    if (!firstInspect.ok) return badInput(firstInspect.error);

    const absPath = path.resolve(firstInspect.rootDir, checkedPath.normalized);
    const rel = path.relative(path.resolve(firstInspect.rootDir), absPath);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      return badInput("documentPath resolves outside the qmd collection root");
    }

    try {
      await readFile(absPath);
      return badInput(`document already exists: ${checkedPath.normalized}`);
    } catch {
      // Missing file is the create case.
    }

    const secondInspect = await deps.inspectCollection(allowlisted.collection);
    if (!secondInspect.ok) return badInput(secondInspect.error);
    if (secondInspect.updateCommand.trim().length > 0) {
      return badInput("refusing write because qmd collection update command is set");
    }

    if (deps.ensureRefreshReady) {
      const ready = deps.ensureRefreshReady();
      if (!ready.ok) return badInput(ready.error);
    }

    await mkdir(path.dirname(absPath));
    await writeFile(absPath, args.content);
    await deps.refreshCollection(allowlisted.collection);
    await deps.runCli(["qmd", "embed", "-c", allowlisted.collection]);

    return { ok: true as const, documentPath: checkedPath.normalized };
  }

  async function listCollections() {
    const collections: Array<{ name: string; path: string }> = [];
    for (const name of deps.allowlistedCollections) {
      const inspected = await deps.inspectCollection(name);
      if (!inspected.ok) {
        return badInput(inspected.error);
      }
      collections.push({ name, path: inspected.rootDir });
    }
    return { ok: true as const, collections };
  }

  async function listDocs(args: {
    collection: string;
    path?: string;
    start?: number;
    limit?: number;
  }) {
    const allowlisted = ensureAllowlisted(args.collection);
    if (!allowlisted.ok) return allowlisted;

    const checkedPath = rejectOptionalListPath(args.path);
    if (!checkedPath.ok) return checkedPath;

    const start = listStartOrError(args.start);
    if (!start.ok) return start;
    const limit = listLimitOrError(args.limit);
    if (!limit.ok) return limit;

    const listing = await collectListing(allowlisted.collection);
    if (!listing.ok) return listing;
    const merged = mergeIndexedWithDisk(listing.indexed, listing.walk);

    if (!listingHasPath(merged, checkedPath.normalized)) {
      return badInput(`path not found under collection ${allowlisted.collection}: ${checkedPath.normalized}`);
    }

    const children = immediateChildren(merged.files, checkedPath.normalized, merged.dirs);
    if (children.length === 0) {
      return badInput(
        checkedPath.normalized.length > 0
          ? `directory has no entries: ${checkedPath.normalized}`
          : `collection has no files: ${allowlisted.collection}`,
      );
    }

    const page = sliceBrowsePage(
      children.map((child) =>
        formatDirChild(
          child,
          child.kind === "file" && !merged.indexedPaths.has(child.documentPath),
        ),
      ),
      start.start,
      limit.limit,
      {
        tool: "kbDocList",
        collection: allowlisted.collection,
        path: checkedPath.normalized,
      },
    );
    if (!page.ok) return page;
    return { ok: true as const, text: withTruncationNote(page.text, merged.truncated) };
  }

  async function listTree(args: {
    collection: string;
    path?: string;
    start?: number;
    limit?: number;
  }) {
    const allowlisted = ensureAllowlisted(args.collection);
    if (!allowlisted.ok) return allowlisted;

    const checkedPath = rejectOptionalListPath(args.path);
    if (!checkedPath.ok) return checkedPath;

    const start = listStartOrError(args.start);
    if (!start.ok) return start;
    const limit = listLimitOrError(args.limit);
    if (!limit.ok) return limit;

    const listing = await collectListing(allowlisted.collection);
    if (!listing.ok) return listing;
    const merged = mergeIndexedWithDisk(listing.indexed, listing.walk);

    if (!listingHasPath(merged, checkedPath.normalized)) {
      return badInput(`path not found under collection ${allowlisted.collection}: ${checkedPath.normalized}`);
    }

    const files = filesUnderPath(merged.files, checkedPath.normalized);
    if (files.length === 0) {
      return badInput(
        checkedPath.normalized.length > 0
          ? `no files under path: ${checkedPath.normalized}`
          : `collection has no files: ${allowlisted.collection}`,
      );
    }

    const page = sliceBrowsePage(
      files.map((file) => formatIndexedFile(file, !merged.indexedPaths.has(file.documentPath))),
      start.start,
      limit.limit,
      {
        tool: "kbDocTree",
        collection: allowlisted.collection,
        path: checkedPath.normalized,
      },
    );
    if (!page.ok) return page;
    return { ok: true as const, text: withTruncationNote(page.text, merged.truncated) };
  }

  return { search, read, edit, create, listCollections, listDocs, listTree };
}

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

function looksLikeJson(stdout: string): boolean {
  const trimmed = stdout.trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

function parseCollectionListRowsFromJson(
  stdout: string,
): { ok: true; rows: QmdCollectionRecord[] } | { ok: false; error: string } {
  const parsed = parseJson(stdout);
  if (!parsed.ok) {
    return { ok: false, error: `qmd collection list returned invalid JSON: ${parsed.error}` };
  }
  const rows = asArray(parsed.value);
  const out: QmdCollectionRecord[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    const name = rec.name ?? rec.collection ?? rec.id;
    const rootDir = rec.path ?? rec.root ?? rec.directory ?? rec.dir;
    if (typeof name !== "string" || name.trim().length === 0) continue;
    if (typeof rootDir !== "string" || rootDir.trim().length === 0) continue;
    const updateCommand =
      typeof rec.update === "string"
        ? rec.update
        : typeof rec.updateCommand === "string"
          ? rec.updateCommand
          : typeof rec.update_cmd === "string"
            ? rec.update_cmd
            : "";
    out.push({
      name,
      path: rootDir,
      updateCommand,
    });
  }
  return { ok: true, rows: out };
}

/** Parse `qmd collection list` human stdout into collection names (no filesystem paths in that output). */
export function parseQmdCollectionListNames(
  stdout: string,
): { ok: true; names: string[] } | { ok: false; error: string } {
  const text = stripAnsi(stdout);
  if (/No collections found/i.test(text)) {
    return { ok: true, names: [] };
  }
  const names: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^(\S+)\s+\(qmd:\/\//);
    if (match) names.push(match[1]);
  }
  if (names.length > 0) return { ok: true, names };
  if (text.trim().length === 0) return { ok: true, names: [] };
  return { ok: false, error: "qmd collection list returned unrecognized output" };
}

/** Parse `qmd collection show <name>` human stdout for Path and optional Update. */
export function parseQmdCollectionShow(
  stdout: string,
): { ok: true; path: string; updateCommand: string } | { ok: false; error: string } {
  const text = stripAnsi(stdout);
  const pathMatch = text.match(/^\s*Path:\s*(.+)$/m);
  if (!pathMatch || pathMatch[1].trim().length === 0) {
    return { ok: false, error: "qmd collection show returned no Path" };
  }
  const updateMatch = text.match(/^\s*Update:\s*(.+)$/m);
  return {
    ok: true,
    path: pathMatch[1].trim(),
    updateCommand: updateMatch ? updateMatch[1].trim() : "",
  };
}

function execQmdCollectionShowSync(
  collection: string,
): { ok: true; path: string; updateCommand: string } | { ok: false; error: string } {
  try {
    const stdout = execFileSync("qmd", ["collection", "show", collection], {
      encoding: "utf8",
    });
    return parseQmdCollectionShow(stdout);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
}

export function createCollectionInspector(runCli: QmdCliRunner): QmdCollectionInspector {
  return async (collection: string) => {
    const got = await runCli(["qmd", "collection", "show", collection]);
    if (!got.ok) {
      if (/not found/i.test(got.stderr) || /not found/i.test(got.stdout)) {
        return { ok: false, error: `qmd collection not found: ${collection}` };
      }
      return { ok: false, error: `failed to read qmd collection show: ${got.stderr || got.stdout}` };
    }
    const shown = parseQmdCollectionShow(got.stdout);
    if (!shown.ok) return shown;
    return { ok: true, rootDir: shown.path, updateCommand: shown.updateCommand };
  };
}

export function createDefaultCliRunner(): QmdCliRunner {
  return async (argv: string[]) =>
    new Promise<QmdCliResult>((resolve) => {
      const proc = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (chunk) => {
        stdout += chunk.toString("utf8");
      });
      proc.stderr.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
      });
      proc.on("error", (error) => {
        resolve({ ok: false, stdout, stderr: error.message, exitCode: -1 });
      });
      proc.on("close", (exitCode) => {
        const code = exitCode ?? -1;
        resolve({ ok: code === 0, stdout, stderr, exitCode: code });
      });
    });
}

export function createLookupQmdUpdateCommandSync(): (collection: string) => { ok: true; command: string } | { ok: false; error: string } {
  return (collection: string) => {
    const shown = execQmdCollectionShowSync(collection);
    if (!shown.ok) return shown;
    return { ok: true, command: shown.updateCommand };
  };
}

export function createLookupQmdCollectionsSync(): () => { ok: true; collections: Array<{ name: string; path: string }> } | { ok: false; error: string } {
  return () => {
    try {
      // qmd collection list has no --json / --format json mode; it prints a human table.
      // Paths live on `qmd collection show <name>`.
      const stdout = execFileSync("qmd", ["collection", "list"], {
        encoding: "utf8",
      });
      if (looksLikeJson(stdout)) {
        const parsed = parseCollectionListRowsFromJson(stdout);
        if (!parsed.ok) return parsed;
        return {
          ok: true,
          collections: parsed.rows.map((row) => ({ name: row.name, path: row.path })),
        };
      }
      const listed = parseQmdCollectionListNames(stdout);
      if (!listed.ok) return listed;
      const collections: Array<{ name: string; path: string }> = [];
      for (const name of listed.names) {
        const shown = execQmdCollectionShowSync(name);
        if (!shown.ok) {
          return { ok: false, error: `could not read qmd collection show for ${name}: ${shown.error}` };
        }
        collections.push({ name, path: shown.path });
      }
      return { ok: true, collections };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message };
    }
  };
}

function findQmdBinaryOnPath(): { ok: true; binPath: string } | { ok: false; error: string } {
  try {
    const located = execFileSync("which", ["qmd"], { encoding: "utf8" }).trim();
    if (!located) return { ok: false, error: "qmd CLI not found on PATH" };
    return { ok: true, binPath: located };
  } catch {
    return { ok: false, error: "qmd CLI not found on PATH" };
  }
}

function packageRootFromQmdBinary(binPath: string): { ok: true; packageRoot: string } | { ok: false; error: string } {
  let resolved: string;
  try {
    resolved = fs.realpathSync(binPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `could not resolve qmd binary path: ${message}` };
  }

  let dir = path.dirname(resolved);
  for (;;) {
    const packageJsonPath = path.join(dir, "package.json");
    if (fs.existsSync(packageJsonPath)) {
      try {
        const raw = fs.readFileSync(packageJsonPath, "utf8");
        const parsed = JSON.parse(raw) as { name?: unknown };
        if (parsed.name === "@tobilu/qmd") {
          return { ok: true, packageRoot: dir };
        }
      } catch {
        // keep walking
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return {
    ok: false,
    error: `could not find @tobilu/qmd package root from qmd binary at ${resolved}`,
  };
}

function moduleResolveCwdFromPackageRoot(
  packageRoot: string,
): { ok: true; moduleResolveCwd: string } | { ok: false; error: string } {
  let dir = packageRoot;
  for (;;) {
    if (path.basename(dir) === "node_modules") {
      return { ok: true, moduleResolveCwd: path.dirname(dir) };
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return {
    ok: false,
    error: `could not locate node_modules parent for @tobilu/qmd at ${packageRoot}`,
  };
}

/** Resolve the globally installed `@tobilu/qmd` package from the `qmd` binary on PATH. */
export function resolveQmdPackageFromCli(): QmdPackageResolution {
  const binary = findQmdBinaryOnPath();
  if (!binary.ok) return binary;
  const packageRoot = packageRootFromQmdBinary(binary.binPath);
  if (!packageRoot.ok) return packageRoot;
  const moduleResolveCwd = moduleResolveCwdFromPackageRoot(packageRoot.packageRoot);
  if (!moduleResolveCwd.ok) return moduleResolveCwd;
  const entry = path.join(packageRoot.packageRoot, "dist", "index.js");
  if (!fs.existsSync(entry)) {
    return {
      ok: false,
      error: `@tobilu/qmd package at ${packageRoot.packageRoot} is missing dist/index.js`,
    };
  }
  return {
    ok: true,
    packageRoot: packageRoot.packageRoot,
    moduleResolveCwd: moduleResolveCwd.moduleResolveCwd,
  };
}

/** Index DB path the qmd CLI would use for the given working directory (honors INDEX_PATH and project-local `.qmd`). */
export function resolveQmdIndexDbPath(cwd: string = process.cwd()): string {
  if (process.env.INDEX_PATH && process.env.INDEX_PATH.trim().length > 0) {
    return process.env.INDEX_PATH;
  }
  let dir = path.resolve(cwd);
  for (;;) {
    const qmdDir = path.join(dir, ".qmd");
    for (const name of ["index.yaml", "index.yml"] as const) {
      if (fs.existsSync(path.join(qmdDir, name))) {
        return path.join(qmdDir, "index.sqlite");
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const cacheDir = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  return path.join(cacheDir, "qmd", "index.sqlite");
}

export type SdkRefreshSpawn = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcess;

export type SdkCollectionScanRefreshDeps = {
  resolvePackage?: QmdPackageResolver;
  resolveIndexPath?: (cwd?: string) => string;
  spawnChild?: SdkRefreshSpawn;
  workingDirectory?: string;
};

/**
 * Hook-free single-collection reindex via the `@tobilu/qmd` SDK.
 * Checked against `qmd update --help`: only `qmd update [--pull]` exists (no collection-scoped hook-free CLI flag),
 * so refresh spawns a child that imports `@tobilu/qmd` from the global install (resolved via the `qmd` binary),
 * not from the repo, and calls `createStore(...).update({ collections: [name] })`.
 */
export function createSdkCollectionScanRefresh(
  deps: SdkCollectionScanRefreshDeps = {},
): QmdRefreshRunner {
  const resolvePackage = deps.resolvePackage ?? resolveQmdPackageFromCli;
  const resolveIndexPath = deps.resolveIndexPath ?? resolveQmdIndexDbPath;
  const spawnChild = deps.spawnChild ?? spawn;
  const workingDirectory = deps.workingDirectory ?? process.cwd();

  return async (collection: string) => {
    const resolved = resolvePackage();
    if (!resolved.ok) throw new Error(resolved.error);

    const indexPath = resolveIndexPath(workingDirectory);
    const script = [
      "import { createStore } from '@tobilu/qmd';",
      "const store = await createStore({ dbPath: process.env.INDEX_PATH });",
      "try {",
      "  await store.update({ collections: [process.argv[1]] });",
      "} finally {",
      "  await store.close();",
      "}",
    ].join("\n");

    await new Promise<void>((resolve, reject) => {
      const proc = spawnChild(process.execPath, ["--input-type=module", "-e", script, collection], {
        cwd: resolved.moduleResolveCwd,
        env: { ...process.env, INDEX_PATH: indexPath },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      proc.stderr?.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
      });
      proc.on("error", (error) => reject(error));
      proc.on("close", (exitCode) => {
        if (exitCode === 0) {
          resolve();
        } else {
          reject(new Error(stderr || `qmd SDK refresh failed with exit code ${exitCode ?? -1}`));
        }
      });
    });
  };
}

export const sdkCollectionScanRefresh = createSdkCollectionScanRefresh();
