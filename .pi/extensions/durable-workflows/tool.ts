/**
 * tool.ts — the `wf` action dispatch + input validation for
 * durable-workflows (Task 5). Implements the nine actions from
 * SPEC-durable-workflows.md "Tool surface" as pure log operations: the
 * extension records and folds, it never executes nodes. Every action
 * that touches a specific thread runs inside `withLease` on that
 * thread's directory (create/fork lease the NEW thread dir; the
 * status listing needs no lease). Action-level errors never throw:
 * `dispatch` returns an ActionResult whose `error` carries the message.
 *
 * Commit atomicity: an `ok` commit with output is dry-run through
 * foldEntries BEFORE any append, so a reducer violation leaves the log
 * untouched. Fork asserts the source log is byte-identical (sha256)
 * across the copy. index.ts (Task 6) is the only intended caller.
 */

import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { hashGraph, validateGraph, type Graph } from "./graph.ts";
import {
  appendEntry,
  nowIso,
  readLog,
  validateEntry,
  type Launch,
  type LogEntry,
  type StepResult,
  type ThreadMeta,
} from "./log.ts";
import { foldEntries, unmetNeeds, type Fold } from "./fold.ts";
import {
  listThreads,
  resolveStoreDir,
  sanitizeThreadId,
  threadDir,
  THREAD_ID_RE,
} from "./store.ts";
import { withLease } from "./lease.ts";

/** Resolved tool context: storeRoot comes from settings (project wins
 *  over global — index.ts resolves layering; the tool receives the
 *  resolved value, null/undefined meaning the cwd default). */
export type ToolCtx = { storeRoot?: string | null; cwd: string };

/** Action-level result: errors are values, never thrown. */
export type ActionResult =
  | { ok: true; result: unknown }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Internal helpers (exported for tests)
// ---------------------------------------------------------------------------

type LoadedThread =
  | {
      ok: true;
      dir: string;
      entries: LogEntry[];
      truncatedTail: boolean;
      graph: Graph;
      meta: ThreadMeta;
    }
  | { ok: false; error: string };

/** Resolve a thread dir under the ctx store, read its log. A missing,
 *  empty, or unreadable log → error ("thread <id> not found" for the
 *  missing/empty cases). The first entry must be the thread_meta. */
export function loadThread(ctx: ToolCtx, threadId: string): LoadedThread {
  const dir = threadDir(resolveStoreDir(ctx.storeRoot, ctx.cwd), threadId);
  const read = readLog(dir);
  if (!read.ok) return { ok: false, error: read.error };
  const first = read.entries[0];
  if (read.entries.length === 0 || first.t !== "thread_meta") {
    return { ok: false, error: `thread ${threadId} not found` };
  }
  return {
    ok: true,
    dir,
    entries: read.entries,
    truncatedTail: read.truncatedTail,
    graph: first.graph,
    meta: first,
  };
}

export type FoldedThread =
  | { ok: true; dir: string; graph: Graph; fold: Fold; entries: LogEntry[] }
  | { ok: false; error: string };

/** loadThread + foldEntries (truncatedTail passed through). */
export function foldThread(ctx: ToolCtx, threadId: string): FoldedThread {
  const loaded = loadThread(ctx, threadId);
  if (!loaded.ok) return loaded;
  const fold = foldEntries(loaded.entries, loaded.graph, loaded.truncatedTail);
  return {
    ok: true,
    dir: loaded.dir,
    graph: loaded.graph,
    fold,
    entries: loaded.entries,
  };
}

/** Fold plus the per-blocked-node unmet-need detail (the shape `next`
 *  and `status <id>` return). */
export function foldWithDetail(
  graph: Graph,
  fold: Fold,
): Fold & { blocked_detail: Record<string, string[]> } {
  const detail: Record<string, string[]> = {};
  for (const node of fold.blocked) detail[node] = unmetNeeds(node, graph, fold);
  return { ...fold, blocked_detail: detail };
}

/** Validate then append in one step: an invalid entry must never reach
 *  the log (appendEntry itself does not validate). */
function appendValidated(dir: string, entry: LogEntry): string | null {
  const checked = validateEntry(entry);
  if (!checked.ok) return checked.error;
  const appended = appendEntry(dir, checked.entry);
  return appended.ok ? null : appended.error;
}

/** Some model providers serialize nested-object tool arguments as JSON
 *  strings (evidence: session log .../wf-demo--/2026-10-06T15-54-27-...jsonl,
 *  cited in SPEC "Tool surface"). Coerce defensively at the three
 *  nested-object read sites (create.graph, step_start.launch,
 *  commit.output): a string that parses to a plain object is unwrapped;
 *  everything else — arrays, numbers, invalid JSON — is returned
 *  UNCHANGED so the existing validation produces its normal
 *  "must be an object" error instead of a JSON.parse exception. */
export function coerceObject(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // Not JSON — hand the original string to validation.
  }
  return value;
}

function fail(message: string): never {
  throw new Error(message);
}

function reqString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.length === 0) {
    fail(`${key} must be a non-empty string`);
  }
  return value;
}

function optString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") fail(`${key} must be a string when present`);
  return value;
}

function parseLaunch(value: unknown): Launch {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("launch must be an object");
  }
  const raw = value as Record<string, unknown>;
  if (raw.kind !== "subagent" && raw.kind !== "shell") {
    fail(`launch.kind must be "subagent" or "shell"`);
  }
  if (typeof raw.ref !== "string" || raw.ref.length === 0) {
    fail("launch.ref must be a non-empty string");
  }
  return { kind: raw.kind, ref: raw.ref };
}

/** Title → thread-id slug: lowercase, [^a-z0-9-] → "-", trim dashes.
 *  Null when nothing slugable remains (caller refuses). */
function slugify(title: string): string | null {
  const slug = title.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
  return THREAD_ID_RE.test(slug) ? slug : null;
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Run `fn` while holding the lease of an existing thread's dir. */
async function withThreadLease<T>(
  ctx: ToolCtx,
  threadId: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  const dir = threadDir(resolveStoreDir(ctx.storeRoot, ctx.cwd), threadId);
  return withLease(dir, async () => fn());
}

/** True when the dir's log.jsonl is missing or empty (the "create/fork
 *  target is fresh" check); an existing EMPTY file is fine. */
function assertFreshTarget(dir: string, threadId: string): void {
  const existing = readLog(dir);
  if (!existing.ok) fail(existing.error);
  if (existing.entries.length > 0) fail(`thread ${threadId} already exists`);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function actionCreate(input: Record<string, unknown>, ctx: ToolCtx) {
  const title = optString(input, "title");

  let threadId: string;
  if (input.thread_id !== undefined) {
    if (typeof input.thread_id !== "string") fail("thread_id must be a string");
    const sanitized = sanitizeThreadId(input.thread_id);
    if (!sanitized.ok) fail(sanitized.error);
    threadId = sanitized.id;
  } else if (title !== undefined) {
    const slug = slugify(title);
    if (slug === null) {
      fail(`cannot derive a thread id from title ${JSON.stringify(title)}; pass thread_id explicitly`);
    }
    threadId = slug;
  } else {
    fail("create requires thread_id or title");
  }

  const validated = validateGraph(coerceObject(input.graph));
  if (!validated.ok) fail(`invalid graph: ${validated.error}`);
  const graph = validated.graph;
  const graphHash = hashGraph(graph); // THE NORMALIZED GRAPH, never the raw input

  const dir = threadDir(resolveStoreDir(ctx.storeRoot, ctx.cwd), threadId);
  return withLease(dir, async () => {
    assertFreshTarget(dir, threadId);
    const meta: ThreadMeta = {
      t: "thread_meta",
      v: 1,
      thread_id: threadId,
      graph,
      graph_hash: graphHash,
      ts: nowIso(),
    };
    if (title !== undefined) meta.title = title;
    const error = appendValidated(dir, meta);
    if (error !== null) fail(error);
    return { thread_id: threadId, graph_hash: graphHash };
  });
}

function actionNext(input: Record<string, unknown>, ctx: ToolCtx) {
  const threadId = reqString(input, "thread_id");
  return withThreadLease(ctx, threadId, () => {
    const folded = foldThread(ctx, threadId);
    if (!folded.ok) fail(folded.error);
    return foldWithDetail(folded.graph, folded.fold);
  });
}

function actionStepStart(input: Record<string, unknown>, ctx: ToolCtx) {
  const threadId = reqString(input, "thread_id");
  const node = reqString(input, "node");
  const launch = parseLaunch(coerceObject(input.launch));
  return withThreadLease(ctx, threadId, () => {
    const folded = foldThread(ctx, threadId);
    if (!folded.ok) fail(folded.error);
    const { dir, graph, fold } = folded;
    if (!graph.nodes.some((n) => n.id === node)) fail(`unknown node ${node}`);
    // Ready = fresh launch. Orphan = in-flight rerun path (re-launch of a
    // node whose step_start is unconsumed). When the awaiting gate is on,
    // ready is gated empty, so step_start is naturally refused.
    const inOrphans = fold.orphans.some((o) => o.node === node);
    if (!fold.ready.includes(node) && !inOrphans) {
      const gate = fold.awaiting ? " — thread is awaiting a resume" : "";
      fail(`node ${node} is not ready (done/blocked/awaiting gate)${gate}`);
    }
    const entry: LogEntry = {
      t: "step_start",
      node,
      launch: { kind: launch.kind, ref: launch.ref },
      ts: nowIso(),
    };
    const error = appendValidated(dir, entry);
    if (error !== null) fail(error);
    return { started: node, launch };
  });
}

function actionCommit(input: Record<string, unknown>, ctx: ToolCtx) {
  const threadId = reqString(input, "thread_id");
  const node = reqString(input, "node");
  if (input.status !== undefined && input.status !== "ok" && input.status !== "error") {
    fail(`status must be "ok" or "error"`);
  }
  const status = (input.status === undefined ? "ok" : input.status) as "ok" | "error";
  if (input.origin !== undefined && input.origin !== "run" && input.origin !== "rerun") {
    fail(`origin must be "run" or "rerun"`);
  }
  const origin = (input.origin === undefined ? "run" : input.origin) as "run" | "rerun";
  const summary = optString(input, "summary");
  let artifacts: string[] | undefined;
  if (input.artifacts !== undefined) {
    if (
      !Array.isArray(input.artifacts) ||
      !input.artifacts.every((a) => typeof a === "string")
    ) {
      fail("artifacts must be an array of strings when present");
    }
    artifacts = input.artifacts as string[];
  }

  return withThreadLease(ctx, threadId, () => {
    const folded = foldThread(ctx, threadId);
    if (!folded.ok) fail(folded.error);
    const { dir, graph, fold, entries, truncatedTail } = folded;
    if (!fold.orphans.some((o) => o.node === node)) {
      fail(`no step_start to commit for ${node} (start it first)`);
    }

    const entry: StepResult = { t: "step_result", node, status, ts: nowIso() };
    entry.origin = origin;
    if (input.output !== undefined) entry.output = coerceObject(input.output);
    if (artifacts !== undefined) entry.artifacts = artifacts;
    if (summary !== undefined) entry.summary = summary;

    // Atomicity: an ok commit that would violate a reducer must fail
    // BEFORE the append — dry-run the synthetic entry through the fold.
    if (status === "ok" && entry.output !== undefined) {
      try {
        foldEntries(entries.concat([entry]), graph, truncatedTail);
      } catch (err) {
        fail(`commit refused (would violate fold): ${(err as Error).message}`);
      }
    }

    const error = appendValidated(dir, entry);
    if (error !== null) fail(error);
    return { committed: node, status, origin };
  });
}

function actionInterrupt(input: Record<string, unknown>, ctx: ToolCtx) {
  const threadId = reqString(input, "thread_id");
  const question = reqString(input, "question");
  let options: string[] | undefined;
  if (input.options !== undefined) {
    if (!Array.isArray(input.options) || !input.options.every((o) => typeof o === "string")) {
      fail("options must be an array of strings when present");
    }
    options = input.options as string[];
  }
  return withThreadLease(ctx, threadId, () => {
    const folded = foldThread(ctx, threadId);
    if (!folded.ok) fail(folded.error);
    const entry: LogEntry = { t: "interrupt", question, ts: nowIso() };
    if (options !== undefined) entry.options = options;
    const error = appendValidated(folded.dir, entry);
    if (error !== null) fail(error);
    const result: { interrupted: true; question: string; options?: string[] } = {
      interrupted: true,
      question,
    };
    if (options !== undefined) result.options = options;
    return result;
  });
}

function actionResume(input: Record<string, unknown>, ctx: ToolCtx) {
  const threadId = reqString(input, "thread_id");
  const answer = reqString(input, "answer");
  return withThreadLease(ctx, threadId, () => {
    const folded = foldThread(ctx, threadId);
    if (!folded.ok) fail(folded.error);
    if (!folded.fold.awaiting) fail("no interrupt to resume");
    const entry: LogEntry = { t: "resume", answer, ts: nowIso() };
    const error = appendValidated(folded.dir, entry);
    if (error !== null) fail(error);
    // Re-fold after the append to report what is now ready.
    const after = foldEntries(
      folded.entries.concat([entry]),
      folded.graph,
      folded.truncatedTail,
    );
    return { resumed: true, answer, ready: after.ready };
  });
}

type ThreadPhase = "awaiting" | "ready" | "blocked" | "done" | "empty" | "in-flight";

function derivePhase(graph: Graph, fold: Fold): ThreadPhase {
  if (fold.awaiting) return "awaiting";
  if (fold.ready.length > 0) return "ready";
  if (fold.blocked.length > 0) return "blocked";
  if (fold.done.length === graph.nodes.length) return "done";
  // Nodes currently executing (orphans) are neither ready, blocked, done,
  // nor an empty thread — the run is mid-flight with nothing schedulable.
  if (fold.orphans.length > 0) return "in-flight";
  return "empty";
}

function actionStatus(input: Record<string, unknown>, ctx: ToolCtx) {
  // Without id: read-only listing across thread dirs — NO lease.
  if (input.thread_id === undefined) {
    const storeDir = resolveStoreDir(ctx.storeRoot, ctx.cwd);
    const list = listThreads(storeDir);
    const threads: Array<{
      thread_id: string;
      title?: string;
      phase: ThreadPhase;
      updated: string;
      awaiting: boolean;
      ready_count: number;
      truncatedTail: boolean;
    }> = [];
    for (const id of list.threads) {
      const loaded = loadThread(ctx, id);
      if (!loaded.ok) continue; // unreadable thread: skip, listing stays useful
      const fold = foldEntries(loaded.entries, loaded.graph, loaded.truncatedTail);
      const row = {
        thread_id: id,
        phase: derivePhase(loaded.graph, fold),
        updated: loaded.entries[loaded.entries.length - 1].ts,
        awaiting: fold.awaiting,
        ready_count: fold.ready.length,
        truncatedTail: fold.truncatedTail,
      };
      if (loaded.meta.title !== undefined) {
        threads.push({ ...row, title: loaded.meta.title });
      } else {
        threads.push(row);
      }
    }
    return Promise.resolve(list.warn ? { threads, warn: list.warn } : { threads });
  }
  // With id: same fold shape as `next`.
  return Promise.resolve(actionNext(input, ctx));
}

function actionInspect(input: Record<string, unknown>, ctx: ToolCtx) {
  const threadId = reqString(input, "thread_id");
  return withThreadLease(ctx, threadId, () => {
    const folded = foldThread(ctx, threadId);
    if (!folded.ok) fail(folded.error);
    const to = input.to;
    if (
      typeof to !== "number" ||
      !Number.isInteger(to) ||
      to < 0 ||
      to >= folded.entries.length
    ) {
      fail(
        `inspect: to must be an integer in [0, ${folded.entries.length - 1}] (log has ${folded.entries.length} entries)`,
      );
    }
    // Read-only fold of the prefix: recorded outputs only, no re-execution.
    const prefixFold = foldEntries(
      folded.entries.slice(0, to + 1),
      folded.graph,
      to + 1 === folded.entries.length ? folded.fold.truncatedTail : false,
    );
    return { ...prefixFold, up_to: to };
  });
}

function actionFork(input: Record<string, unknown>, ctx: ToolCtx) {
  const sourceId = reqString(input, "thread_id");
  const storeDir = resolveStoreDir(ctx.storeRoot, ctx.cwd);
  const sourceDir = threadDir(storeDir, sourceId);
  const loaded = loadThread(ctx, sourceId);
  if (!loaded.ok) fail(loaded.error);

  const entries = loaded.entries;
  const to =
    input.to === undefined
      ? entries.length - 1 // whole prefix by default
      : input.to;
  if (typeof to !== "number" || !Number.isInteger(to) || to < 0 || to >= entries.length) {
    fail(`fork: to must be an integer in [0, ${entries.length - 1}] (log has ${entries.length} entries)`);
  }

  let newId: string;
  if (input.new_thread_id !== undefined) {
    if (typeof input.new_thread_id !== "string") fail("new_thread_id must be a string");
    const sanitized = sanitizeThreadId(input.new_thread_id);
    if (!sanitized.ok) fail(sanitized.error);
    newId = sanitized.id;
  } else {
    // "<source>-fork-<8hex random>"; source truncated to 50 chars so
    // the total (50 + 6 + 8) fits the 64-char slug limit.
    const hex = randomBytes(4).toString("hex");
    newId = `${sourceId.slice(0, 50)}-fork-${hex}`;
  }

  const targetDir = threadDir(storeDir, newId);
  const sourcePath = join(sourceDir, "log.jsonl");
  const sourceHashBefore = sha256File(sourcePath);

  return withLease(targetDir, async () => {
    assertFreshTarget(targetDir, newId);
    const prefix = entries.slice(0, to + 1);
    for (const entry of prefix) {
      // The thread_meta is rewritten to carry the NEW thread_id; every
      // other field (graph, graph_hash, title) is copied as-is, so it
      // re-validates cleanly on append. Downstream entries are the
      // readLog-normalized entries and re-validate verbatim.
      const copy: LogEntry =
        entry.t === "thread_meta" ? { ...entry, thread_id: newId } : entry;
      const error = appendValidated(targetDir, copy);
      if (error !== null) fail(error);
    }
    // Internal sanity: the source log MUST remain untouched.
    if (sha256File(sourcePath) !== sourceHashBefore) {
      fail("internal error: source log changed during fork");
    }
    return { thread_id: newId, copied: prefix.length, source_untouched: true };
  });
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/** Dispatch one `wf` action. Never throws: every failure path — bad
 *  input, refused transition, lease contention, fs error — comes back
 *  as {ok:false, error}. */
export async function dispatch(
  action: string,
  input: Record<string, unknown>,
  ctx: ToolCtx,
): Promise<ActionResult> {
  const safeInput: Record<string, unknown> =
    typeof input === "object" && input !== null && !Array.isArray(input) ? input : {};
  try {
    let result: unknown;
    switch (action) {
      case "create":
        result = await actionCreate(safeInput, ctx);
        break;
      case "next":
        result = await actionNext(safeInput, ctx);
        break;
      case "step_start":
        result = await actionStepStart(safeInput, ctx);
        break;
      case "commit":
        result = await actionCommit(safeInput, ctx);
        break;
      case "interrupt":
        result = await actionInterrupt(safeInput, ctx);
        break;
      case "resume":
        result = await actionResume(safeInput, ctx);
        break;
      case "status":
        result = await actionStatus(safeInput, ctx);
        break;
      case "inspect":
        result = await actionInspect(safeInput, ctx);
        break;
      case "fork":
        result = await actionFork(safeInput, ctx);
        break;
      default:
        return { ok: false, error: `unknown action ${action}` };
    }
    return { ok: true, result };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
