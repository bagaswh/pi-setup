/**
 * fold.ts — the pure transition function for durable-workflows (Task 3).
 * Folds an in-memory LogEntry[] over a validated Graph into a Fold:
 * state, ready/done/blocked/failed node sets, awaiting gate, orphans,
 * truncatedTail passthrough, and the last rerun node. PURE: no fs, no
 * network, no Pi imports; reducers never mutate their inputs — values
 * entering state are cloned (structuredClone) so log entries and
 * graph.initial are never aliased.
 *
 * Last-wins bookkeeping semantics (exact): a later step_result REPLACES
 * the node's done/failed classification (an error result after an ok
 * result moves the node from done to failed), but the state keys the
 * earlier ok result wrote are NOT rolled back — the fold is a one-pass
 * event stream, so contributions stay written; only the node's status
 * view is last-wins.
 */

import type { Graph, ReducerName } from "./graph.ts";
import type { LogEntry } from "./log.ts";

/** A step_start with no later step_result, carrying the launch ref for
 *  the driver's orphan check. */
export type Orphan = {
  node: string;
  launch: { kind: "subagent" | "shell"; ref: string };
};

export type Fold = {
  state: Record<string, unknown>;
  ready: string[];
  done: string[];
  blocked: string[];
  failed: string[];
  awaiting: boolean;
  orphans: Orphan[];
  truncatedTail: boolean;
  /** Node of the most recent step_result with origin === "rerun". */
  lastRerunNode?: string;
};

export type ReducerResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Apply one of the five builtin reducers. Total (returns a Result, never
 * throws) and non-mutating: returned arrays/objects are newly constructed
 * or reference the caller's `next` value, which foldEntries clones before
 * it enters state.
 *
 * - set: replace with next.
 * - append: current.concat(next); both must be arrays. Missing current on
 *   first write: next must be an array and becomes the value.
 * - merge: shallow-merge plain objects, next wins per key. Missing current
 *   on first write: next must be a plain object. Non-object next is an
 *   error.
 * - sum: Number(current ?? 0) + Number(next); a non-finite result is an
 *   error.
 * - max: Math.max(current === undefined ? -Infinity : current, next).
 */
export function applyReducer(
  name: ReducerName,
  current: unknown,
  next: unknown,
): ReducerResult {
  switch (name) {
    case "set":
      return { ok: true, value: next };
    case "append": {
      if (current === undefined) {
        if (Array.isArray(next)) return { ok: true, value: next };
        return {
          ok: false,
          error: "append with no current value requires next to be an array",
        };
      }
      if (Array.isArray(current) && Array.isArray(next)) {
        return { ok: true, value: current.concat(next) };
      }
      return { ok: false, error: "append requires both current and next to be arrays" };
    }
    case "merge": {
      if (current === undefined) {
        if (isPlainObject(next)) return { ok: true, value: next };
        return {
          ok: false,
          error: "merge with no current value requires next to be a plain object",
        };
      }
      if (isPlainObject(current) && isPlainObject(next)) {
        return { ok: true, value: { ...current, ...next } };
      }
      return {
        ok: false,
        error: "merge requires both current and next to be plain objects",
      };
    }
    case "sum": {
      const total = Number(current ?? 0) + Number(next);
      if (!Number.isFinite(total)) {
        return { ok: false, error: `sum produced a non-finite result (${total})` };
      }
      return { ok: true, value: total };
    }
    case "max":
      return {
        ok: true,
        value: Math.max(current === undefined ? -Infinity : Number(current), Number(next)),
      };
  }
}

/** True when every `needs` dependency of `nodeId` has an ok result. The
 *  in-flight (orphan) exclusion is the caller's concern. */
export function isReady(nodeId: string, graph: Graph, okResults: Set<string>): boolean {
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node) return false;
  return node.needs.every((dep) => okResults.has(dep));
}

/** Thin helper: needs of `nodeId` that are not done in `fold` (the unmet-
 *  need detail behind Fold.blocked). Unknown node ids yield []. */
export function unmetNeeds(nodeId: string, graph: Graph, fold: Fold): string[] {
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node) return [];
  return node.needs.filter((dep) => !fold.done.includes(dep));
}

/**
 * Fold entries over graph in ONE pass, in order. `graph` is authoritative
 * (the caller passes the graph from the thread's meta; the fold re-validates
 * only the meta-first contract cheaply). `truncatedTail` is passed through
 * from the log reader. Hard errors (thrown) indicate a corrupt log: a
 * missing/late thread_meta, a step_result without step_start, or a reducer
 * type violation — each names the offending node/key.
 */
export function foldEntries(
  entries: LogEntry[],
  graph: Graph,
  truncatedTail = false,
): Fold {
  if (entries.length === 0 || entries[0].t !== "thread_meta") {
    throw new Error("log must begin with thread_meta");
  }

  // See the module comment for the exact last-wins bookkeeping semantics.
  const state: Record<string, unknown> = structuredClone(graph.initial);
  const orphans = new Map<string, Orphan>();
  // Per node: status of its most recent step_result (last-wins bookkeeping).
  const lastStatus = new Map<string, "ok" | "error">();
  let awaiting = false;
  let lastRerunNode: string | undefined;

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.t === "thread_meta") {
      if (i !== 0) {
        throw new Error("log must begin with thread_meta");
      }
      continue;
    }
    if (e.t === "step_start") {
      // A re-issued step_start for a node with an unconsumed start is the
      // rerun path: the old start is superseded, no error.
      orphans.set(e.node, {
        node: e.node,
        launch: { kind: e.launch.kind, ref: e.launch.ref },
      });
      continue;
    }
    if (e.t === "step_result") {
      if (!orphans.has(e.node)) {
        throw new Error(`step_result for ${e.node} without step_start`);
      }
      orphans.delete(e.node);
      if (e.status === "ok" && isPlainObject(e.output)) {
        for (const [key, value] of Object.entries(e.output)) {
          const reducer = graph.reducers[key];
          if (reducer === undefined) continue; // non-reducer keys: ignored
          const applied = applyReducer(reducer, state[key], value);
          if (!applied.ok) {
            throw new Error(
              `reducer ${reducer} failed for key ${JSON.stringify(key)} in node ${e.node}: ${applied.error}`,
            );
          }
          state[key] = structuredClone(applied.value);
        }
      }
      lastStatus.set(e.node, e.status);
      if (e.origin === "rerun") lastRerunNode = e.node;
      continue;
    }
    if (e.t === "interrupt") {
      awaiting = true;
      continue;
    }
    if (e.t === "resume") {
      awaiting = false;
      continue;
    }
  }

  const okResults = new Set(
    graph.nodes.filter((n) => lastStatus.get(n.id) === "ok").map((n) => n.id),
  );

  const done: string[] = [];
  const failed: string[] = [];
  const ready: string[] = [];
  const blocked: string[] = [];
  for (const n of graph.nodes) {
    const status = lastStatus.get(n.id);
    if (status === "ok") done.push(n.id);
    if (status === "error") failed.push(n.id);
    // A node with an ok result is not eligible for ready; an unconsumed
    // step_start (orphan) means the node is in flight, not ready.
    if (status !== "ok" && !orphans.has(n.id)) {
      if (isReady(n.id, graph, okResults)) ready.push(n.id);
      else blocked.push(n.id);
    }
  }

  // Awaiting gate: an unresolved interrupt yields no ready set (commit
  // stays allowed at the tool layer, which is unaffected here).
  const fold: Fold = {
    state,
    ready: awaiting ? [] : ready,
    done,
    blocked,
    failed,
    awaiting,
    orphans: [...orphans.values()],
    truncatedTail,
  };
  if (lastRerunNode !== undefined) fold.lastRerunNode = lastRerunNode;
  return fold;
}
