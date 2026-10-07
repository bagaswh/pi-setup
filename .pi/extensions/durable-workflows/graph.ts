/**
 * graph.ts — graph validation, canonicalization, and hashing for
 * durable-workflows (Task 1). Pure logic: no fs, no Pi imports, stdlib
 * crypto only. A graph is the object embedded in a `thread_meta` log
 * entry (see SPEC-durable-workflows.md): nodes with dependency edges,
 * named reducers over state keys, and initial state.
 *
 * Note: package.json's test script lists all future test files
 * (log/fold/lease/store); node:test on Node 22 tolerates missing files,
 * so `npm test` stays green at every task boundary. Later tasks append
 * their *.test.ts to the directory without editing the script.
 */

import { createHash } from "node:crypto";

export type NodeType = "subagent" | "shell";

export type NodeSpec = {
  id: string;
  type: NodeType;
  /** Node ids this node depends on; empty array when none. */
  needs: string[];
  /** Required, non-empty, for subagent nodes. */
  prompt?: string;
  /** Required, non-empty, for shell nodes. */
  command?: string;
  /** Optional subagent name override. */
  agent?: string;
};

/** The five builtin reducers; adding one is an ask-first spec change. */
export type ReducerName = "set" | "append" | "merge" | "sum" | "max";

export type Graph = {
  nodes: NodeSpec[];
  /** State key → reducer applied when a node commits output for it. */
  reducers: Record<string, ReducerName>;
  /** Initial value for every reducer key (extra keys are allowed). */
  initial: Record<string, unknown>;
};

export type ValidateResult =
  | { ok: true; graph: Graph }
  | { ok: false; error: string };

const NODE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const REDUCER_NAMES: readonly ReducerName[] = ["set", "append", "merge", "sum", "max"];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Detect a cycle in the `needs` edges and return the node-id cycle as a
 * path like ["a","b","c","a"], or null when the graph is acyclic.
 */
function findNeedsCycle(nodes: NodeSpec[]): string[] | null {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const n of nodes) color.set(n.id, WHITE);

  const path: string[] = [];

  const visit = (id: string): string[] | null => {
    color.set(id, GRAY);
    path.push(id);
    for (const dep of byId.get(id)!.needs) {
      if (color.get(dep) === GRAY) {
        // Close the cycle: slice from the first occurrence of dep.
        return [...path.slice(path.indexOf(dep)), dep];
      }
      if (color.get(dep) === WHITE) {
        const sub = visit(dep);
        if (sub) return sub;
      }
    }
    path.pop();
    color.set(id, BLACK);
    return null;
  };

  for (const n of nodes) {
    if (color.get(n.id) === WHITE) {
      const cycle = visit(n.id);
      if (cycle) return cycle;
    }
  }
  return null;
}

/** Validate an unknown value as a Graph; total, no throwing. */
export function validateGraph(input: unknown): ValidateResult {
  if (!isPlainObject(input)) {
    return { ok: false, error: "graph must be a JSON object" };
  }

  const { nodes, reducers, initial } = input as Record<string, unknown>;

  if (!Array.isArray(nodes) || nodes.length === 0) {
    return { ok: false, error: "graph.nodes must be a non-empty array" };
  }

  const seen = new Set<string>();
  const specs: NodeSpec[] = [];
  for (const raw of nodes) {
    if (!isPlainObject(raw)) {
      return { ok: false, error: "each node must be an object" };
    }
    const id = raw.id;
    if (!nonEmptyString(id)) {
      return { ok: false, error: "each node must have a non-empty string id" };
    }
    if (!NODE_ID_RE.test(id)) {
      return {
        ok: false,
        error: `node id ${JSON.stringify(id)} must match ^[a-z0-9][a-z0-9_-]{0,63}$`,
      };
    }
    if (seen.has(id)) {
      return { ok: false, error: `duplicate node id: ${id}` };
    }
    seen.add(id);

    if (raw.type !== "subagent" && raw.type !== "shell") {
      return {
        ok: false,
        error: `node ${id}: type must be "subagent" or "shell"`,
      };
    }
    if (raw.type === "subagent" && !nonEmptyString(raw.prompt)) {
      return { ok: false, error: `subagent node ${id} requires a non-empty prompt` };
    }
    if (raw.type === "shell" && !nonEmptyString(raw.command)) {
      return { ok: false, error: `shell node ${id} requires a non-empty command` };
    }
    if (raw.needs !== undefined && !Array.isArray(raw.needs)) {
      return { ok: false, error: `node ${id}: needs must be an array of node ids` };
    }
    const needs: string[] = raw.needs ?? [];
    for (const dep of needs) {
      if (typeof dep !== "string") {
        return { ok: false, error: `node ${id}: needs must contain only strings` };
      }
      if (dep === id) {
        return { ok: false, error: `node ${id} needs itself` };
      }
    }
    const spec: NodeSpec = { id, type: raw.type, needs };
    if (raw.type === "subagent") spec.prompt = raw.prompt;
    if (raw.type === "shell") spec.command = raw.command;
    if (raw.agent !== undefined) {
      if (!nonEmptyString(raw.agent)) {
        return { ok: false, error: `node ${id}: agent must be a non-empty string` };
      }
      spec.agent = raw.agent;
    }
    specs.push(spec);
  }

  // needs references must name known nodes (checked after all ids are seen,
  // so forward references work).
  for (const spec of specs) {
    for (const dep of spec.needs) {
      if (!seen.has(dep)) {
        return {
          ok: false,
          error: `node ${spec.id} needs unknown node ${JSON.stringify(dep)}`,
        };
      }
    }
  }

  const cycle = findNeedsCycle(specs);
  if (cycle) {
    return { ok: false, error: `needs cycle detected: ${cycle.join(" -> ")}` };
  }

  if (!isPlainObject(reducers)) {
    return { ok: false, error: "graph.reducers must be an object" };
  }
  for (const [key, name] of Object.entries(reducers)) {
    if (!REDUCER_NAMES.includes(name as ReducerName)) {
      return {
        ok: false,
        error: `reducers[${JSON.stringify(key)}]: unknown reducer ${JSON.stringify(name)} (expected one of ${REDUCER_NAMES.join(", ")})`,
      };
    }
  }

  if (!isPlainObject(initial)) {
    return { ok: false, error: "graph.initial must be a plain object" };
  }
  for (const key of Object.keys(reducers)) {
    if (!(key in initial)) {
      return {
        ok: false,
        error: `reducer key ${JSON.stringify(key)} has no initial value (every reducer key must be present in initial)`,
      };
    }
  }

  return { ok: true, graph: { nodes: specs, reducers: reducers as Record<string, ReducerName>, initial } };
}

/**
 * Stable JSON serialization: object keys recursively sorted, arrays kept
 * in order, no insignificant whitespace. Matches JSON.stringify
 * semantics for undefined: dropped from objects, null inside arrays.
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) as string;
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const parts = Object.keys(record)
    .sort()
    .filter((k) => record[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`);
  return `{${parts.join(",")}}`;
}

/** `sha256:` + hex digest of the graph's canonical JSON. */
export function hashGraph(graph: Graph): string {
  return `sha256:${createHash("sha256").update(canonicalJson(graph)).digest("hex")}`;
}
