/**
 * fold.test.ts — node:test suite for fold.ts (Task 3). All fixtures are
 * constructed in memory: no fs, no network, no Pi imports. Covers every
 * entry type, every reducer (happy + failure modes), the parallel-merge
 * case, awaiting gate, orphans, error-retry, last-wins, rerun origin,
 * and the meta-first contract.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { validateGraph, hashGraph, type Graph } from "./graph.ts";
import type { LogEntry } from "./log.ts";
import {
  applyReducer,
  foldEntries,
  isReady,
  unmetNeeds,
  type Fold,
} from "./fold.ts";

// ---------------------------------------------------------------------------
// Fixtures: the SPEC user-story graph (research → parallel review → merge →
// approve → fix → verify) with one key per reducer.
// ---------------------------------------------------------------------------

const GRAPH_INPUT = {
  nodes: [
    { id: "research", type: "subagent", needs: [], prompt: "Research the topic" },
    { id: "review_a", type: "subagent", needs: ["research"], prompt: "Review part A" },
    { id: "review_b", type: "subagent", needs: ["research"], prompt: "Review part B" },
    { id: "merge", type: "shell", needs: ["review_a", "review_b"], command: "cat parts > whole" },
    { id: "approve", type: "subagent", needs: ["merge"], prompt: "Ask the user to approve" },
    { id: "fix", type: "subagent", needs: ["approve"], prompt: "Apply the fix" },
    { id: "verify", type: "shell", needs: ["fix"], command: "npm test" },
  ],
  reducers: { findings: "append", verdict: "merge", count: "sum", best: "max" },
  initial: { findings: [], verdict: {}, count: 0, best: 0 },
} as const;

function makeGraph(): Graph {
  const validated = validateGraph(GRAPH_INPUT);
  assert.ok(validated.ok, validated.ok ? "" : validated.error);
  return validated.graph;
}

const ts = () => new Date().toISOString();

function metaEntry(graph: Graph): LogEntry {
  return {
    t: "thread_meta",
    v: 1,
    thread_id: "fix-loop-1",
    title: "Fix the flaky test",
    graph,
    graph_hash: hashGraph(graph),
    ts: ts(),
  };
}

function start(node: string, ref: string, kind: "subagent" | "shell" = "subagent"): LogEntry {
  return { t: "step_start", node, launch: { kind, ref }, ts: ts() };
}

function result(
  node: string,
  status: "ok" | "error",
  output?: unknown,
  origin?: "run" | "rerun",
): LogEntry {
  const e: Extract<LogEntry, { t: "step_result" }> = {
    t: "step_result",
    node,
    status,
    ts: ts(),
  };
  if (origin !== undefined) e.origin = origin;
  if (output !== undefined) e.output = output;
  return e;
}

function interrupt(question = "Apply the fix now?"): LogEntry {
  return { t: "interrupt", question, options: ["yes", "no"], ts: ts() };
}

function resume(answer = "yes"): LogEntry {
  return { t: "resume", answer, ts: ts() };
}

// ---------------------------------------------------------------------------
// foldEntries scenario subtests
// ---------------------------------------------------------------------------

test("foldEntries", async (t) => {
  const graph = makeGraph();

  await t.test("empty entries error: log must begin with thread_meta", () => {
    assert.throws(() => foldEntries([], graph), /log must begin with thread_meta/);
  });

  await t.test("meta-first contract: first entry must be thread_meta", () => {
    assert.throws(
      () => foldEntries([start("research", "r1")], graph),
      /log must begin with thread_meta/,
    );
    // A thread_meta NOT at index 0 is also a violation.
    assert.throws(
      () => foldEntries([start("research", "r1"), metaEntry(graph)], graph),
      /log must begin with thread_meta/,
    );
    // A valid meta at index 0 passes and establishes nothing else.
    const fold = foldEntries([metaEntry(graph)], graph);
    assert.deepEqual(fold.ready, ["research"]);
    assert.equal(fold.awaiting, false);
  });

  await t.test("happy research→reviews: ready=[review_a,review_b] after research ok", () => {
    const entries = [
      metaEntry(graph),
      start("research", "r1"),
      result("research", "ok", { findings: [{ sev: "low", note: "n1" }], count: 1, best: 3 }),
    ];
    const fold = foldEntries(entries, graph);
    assert.deepEqual(fold.ready.sort(), ["review_a", "review_b"]);
    assert.deepEqual(fold.done, ["research"]);
    assert.deepEqual(fold.blocked, ["merge", "approve", "fix", "verify"]);
    assert.deepEqual(fold.failed, []);
    assert.deepEqual(fold.state.findings, [{ sev: "low", note: "n1" }]);
    assert.equal(fold.state.count, 1);
    assert.equal(fold.state.best, 3);
    assert.equal(fold.awaiting, false);
    assert.deepEqual(fold.orphans, []);
  });

  await t.test("append-merge from two nodes into findings (both present, log order)", () => {
    const entries = [
      metaEntry(graph),
      start("research", "r1"),
      result("research", "ok"),
      start("review_a", "a1"),
      result("review_a", "ok", { findings: [{ sev: "high", note: "from A" }] }),
      start("review_b", "b1"),
      result("review_b", "ok", { findings: [{ sev: "med", note: "from B" }] }),
    ];
    const fold = foldEntries(entries, graph);
    assert.deepEqual(fold.state.findings, [
      { sev: "high", note: "from A" },
      { sev: "med", note: "from B" },
    ]);
    assert.deepEqual(fold.ready, ["merge"]);
    assert.deepEqual(fold.done.sort(), ["research", "review_a", "review_b"]);
  });

  await t.test("merge-reducer next-wins on verdict", () => {
    const entries = [
      metaEntry(graph),
      start("review_a", "a1"),
      result("review_a", "ok", { verdict: { reviewer: "a", ok: true, stale: "x" } }),
      start("review_b", "b1"),
      result("review_b", "ok", { verdict: { reviewer: "b", ok: false, stale: "y" } }),
    ];
    const fold = foldEntries(entries, graph);
    // Different keys merge; for shared keys next (later entry) wins.
    assert.deepEqual(fold.state.verdict, {
      reviewer: "b",
      ok: false,
      stale: "y",
    });
  });

  await t.test("sum and max reducers", () => {
    const entries = [
      metaEntry(graph),
      start("research", "r1"),
      result("research", "ok", { count: 2, best: 5 }),
      start("review_a", "a1"),
      result("review_a", "ok", { count: 3, best: 4 }),
      start("review_b", "b1"),
      result("review_b", "ok", { count: 10, best: 9 }),
    ];
    const fold = foldEntries(entries, graph);
    assert.equal(fold.state.count, 15);
    assert.equal(fold.state.best, 9);
  });

  await t.test("error result → failed + does not satisfy dependents (merge stays blocked)", () => {
    const entries = [
      metaEntry(graph),
      start("research", "r1"),
      result("research", "ok"),
      start("review_a", "a1"),
      result("review_a", "error", undefined, "run"),
      start("review_b", "b1"),
      result("review_b", "ok", { findings: [] }),
    ];
    const fold = foldEntries(entries, graph);
    assert.deepEqual(fold.failed, ["review_a"]);
    assert.ok(!fold.done.includes("review_a"));
    // review_a is retryable: its own needs are satisfied → back to ready.
    assert.deepEqual(fold.ready, ["review_a"]);
    // merge needs review_a AND review_b; an errored need does not satisfy.
    assert.deepEqual(fold.blocked, ["merge", "approve", "fix", "verify"]);
    assert.deepEqual(unmetNeeds("merge", graph, fold), ["review_a"]);
  });

  await t.test("error-then-ok retry (research fails once, then ok) → done, dependents satisfied", () => {
    const entries = [
      metaEntry(graph),
      start("research", "r1"),
      result("research", "error"),
      start("research", "r2"),
      result("research", "ok", { count: 1 }),
    ];
    const fold = foldEntries(entries, graph);
    assert.deepEqual(fold.done, ["research"]);
    assert.deepEqual(fold.failed, []);
    assert.deepEqual(fold.ready.sort(), ["review_a", "review_b"]);
    assert.equal(fold.state.count, 1);
  });

  await t.test("last-wins: ok then error on same node → failed, state contributions remain", () => {
    const entries = [
      metaEntry(graph),
      start("research", "r1"),
      result("research", "ok", { findings: [{ sev: "low", note: "kept" }], count: 7 }),
      start("research", "r2", "subagent"),
      result("research", "error"),
    ];
    const fold = foldEntries(entries, graph);
    // Bookkeeping is last-wins: the node's LAST result is error.
    assert.deepEqual(fold.failed, ["research"]);
    assert.ok(!fold.done.includes("research"));
    // State keys the earlier ok result wrote are NOT rolled back.
    assert.deepEqual(fold.state.findings, [{ sev: "low", note: "kept" }]);
    assert.equal(fold.state.count, 7);
  });

  await t.test("orphan in flight → node not ready (review_a started, not finished)", () => {
    const entries = [
      metaEntry(graph),
      start("research", "r1"),
      result("research", "ok"),
      start("review_a", "a1"),
    ];
    const fold = foldEntries(entries, graph);
    assert.deepEqual(fold.ready, ["review_b"]);
    assert.deepEqual(fold.orphans, [
      { node: "review_a", launch: { kind: "subagent", ref: "a1" } },
    ]);
    assert.ok(!fold.ready.includes("review_a"));
  });

  await t.test("re-issued step_start supersedes old orphan (single orphan, latest launch ref)", () => {
    const entries = [
      metaEntry(graph),
      start("review_a", "a-old"),
      start("review_a", "a-new"),
    ];
    const fold = foldEntries(entries, graph);
    assert.equal(fold.orphans.length, 1);
    assert.deepEqual(fold.orphans[0], {
      node: "review_a",
      launch: { kind: "subagent", ref: "a-new" },
    });
    assert.ok(!fold.ready.includes("review_a"));
  });

  await t.test("step_result without step_start throws", () => {
    const entries = [metaEntry(graph), result("research", "ok")];
    assert.throws(
      () => foldEntries(entries, graph),
      /step_result for research without step_start/,
    );
  });

  await t.test("reducer type violation (append with non-array on existing array) throws naming node+key", () => {
    const entries = [
      metaEntry(graph),
      start("research", "r1"),
      result("research", "ok", { findings: "not an array" }),
    ];
    assert.throws(
      () => foldEntries(entries, graph),
      (err: Error) =>
        /findings/.test(err.message) &&
        /research/.test(err.message) &&
        /append/.test(err.message),
    );
  });

  await t.test("awaiting gate: interrupt → ready=[]", () => {
    const entries = [
      metaEntry(graph),
      start("research", "r1"),
      result("research", "ok"),
      interrupt(),
    ];
    const fold = foldEntries(entries, graph);
    assert.equal(fold.awaiting, true);
    assert.deepEqual(fold.ready, []);
    // Non-ready sets are still visible while awaiting.
    assert.deepEqual(fold.done, ["research"]);
  });

  await t.test("resume clears awaiting → ready returns", () => {
    const entries = [
      metaEntry(graph),
      start("research", "r1"),
      result("research", "ok"),
      interrupt(),
      resume("yes"),
    ];
    const fold = foldEntries(entries, graph);
    assert.equal(fold.awaiting, false);
    assert.deepEqual(fold.ready.sort(), ["review_a", "review_b"]);
  });

  await t.test("unknown output keys ignored (non-reducer keys do not error)", () => {
    const entries = [
      metaEntry(graph),
      start("research", "r1"),
      result("research", "ok", { findings: [], mystery_key: { any: "thing" } }),
    ];
    const fold = foldEntries(entries, graph);
    assert.equal(fold.done[0], "research");
    assert.deepEqual(fold.state.findings, []);
    assert.ok(!("mystery_key" in fold.state));
  });

  await t.test("truncatedTail passthrough", () => {
    const entries = [metaEntry(graph)];
    assert.equal(foldEntries(entries, graph, true).truncatedTail, true);
    assert.equal(foldEntries(entries, graph, false).truncatedTail, false);
    assert.equal(foldEntries(entries, graph).truncatedTail, false);
  });

  await t.test("rerun origin recorded in lastRerunNode", () => {
    const entries = [
      metaEntry(graph),
      start("research", "r1"),
      result("research", "ok", { count: 1 }),
      start("review_a", "a1"),
      result("review_a", "error"),
      start("review_a", "a2"),
      result("review_a", "ok", undefined, "rerun"),
    ];
    const fold = foldEntries(entries, graph);
    assert.equal(fold.lastRerunNode, "review_a");
    // The most recent rerun result wins.
    const entries2 = [
      metaEntry(graph),
      start("research", "r1"),
      result("research", "ok", undefined, "rerun"),
      start("review_a", "a1"),
      result("review_a", "error", undefined, "rerun"),
    ];
    assert.equal(foldEntries(entries2, graph).lastRerunNode, "review_a");
    // No rerun → field absent.
    const plain = foldEntries([metaEntry(graph)], graph);
    assert.equal(plain.lastRerunNode, undefined);
  });

  await t.test("no mutation of inputs: graph.initial and entries are not aliased", () => {
    const graph = makeGraph();
    const initialCopy = structuredClone(graph.initial);
    const entries: LogEntry[] = [
      metaEntry(graph),
      start("research", "r1"),
      result("research", "ok", { findings: [{ sev: "low", note: "n" }], verdict: { a: 1 } }),
    ];
    const fold = foldEntries(entries, graph);
    assert.deepEqual(graph.initial, initialCopy);
    fold.state.findings.push({ sev: "high", note: "mutated after fold" });
    fold.state.verdict.extra = true;
    assert.deepEqual(graph.initial, initialCopy);
  });
});

// ---------------------------------------------------------------------------
// isReady / unmetNeeds helpers
// ---------------------------------------------------------------------------

test("isReady helper", () => {
  const graph = makeGraph();
  const ok = new Set(["research"]);
  assert.equal(isReady("research", graph, ok), true); // no needs
  assert.equal(isReady("review_a", graph, ok), true);
  assert.equal(isReady("merge", graph, ok), false); // needs review_a+review_b
  assert.equal(isReady("nope", graph, ok), false); // unknown node
});

test("unmetNeeds helper", () => {
  const graph = makeGraph();
  const fold: Fold = {
    state: {},
    ready: [],
    done: ["review_b"],
    blocked: [],
    failed: [],
    awaiting: false,
    orphans: [],
    truncatedTail: false,
  };
  assert.deepEqual(unmetNeeds("merge", graph, fold), ["review_a"]);
  assert.deepEqual(unmetNeeds("merge", graph, { ...fold, done: ["review_a", "review_b"] }), []);
  assert.deepEqual(unmetNeeds("nope", graph, fold), []);
});

// ---------------------------------------------------------------------------
// applyReducer unit subtests: every reducer × every input shape
// ---------------------------------------------------------------------------

test("applyReducer", async (t) => {
  await t.test("set: replaces with next, any shape", () => {
    assert.deepEqual(applyReducer("set", { old: 1 }, "anything"), { ok: true, value: "anything" });
    assert.deepEqual(applyReducer("set", undefined, [1, 2]), { ok: true, value: [1, 2] });
  });

  await t.test("append: happy arrays concat", () => {
    assert.deepEqual(applyReducer("append", [1], [2, 3]), { ok: true, value: [1, 2, 3] });
  });

  await t.test("append: undefined current with array next (first write)", () => {
    assert.deepEqual(applyReducer("append", undefined, [1]), { ok: true, value: [1] });
    assert.deepEqual(applyReducer("append", undefined, []), { ok: true, value: [] });
  });

  await t.test("append: undefined current with non-array next → error", () => {
    assert.equal(applyReducer("append", undefined, "x").ok, false);
    assert.equal(applyReducer("append", undefined, 3).ok, false);
  });

  await t.test("append: non-array current on existing value → error", () => {
    const r = applyReducer("append", [1], "nope");
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /arrays/);
    const r2 = applyReducer("append", "nope", [1]);
    assert.equal(r2.ok, false);
  });

  await t.test("append: does not mutate the current array", () => {
    const current = [1];
    applyReducer("append", current, [2]);
    assert.deepEqual(current, [1]);
  });

  await t.test("merge: happy shallow merge, next wins per key", () => {
    assert.deepEqual(applyReducer("merge", { a: 1, shared: "old" }, { shared: "new", b: 2 }), {
      ok: true,
      value: { a: 1, shared: "new", b: 2 },
    });
  });

  await t.test("merge: undefined current with plain-object next (first write)", () => {
    assert.deepEqual(applyReducer("merge", undefined, { a: 1 }), { ok: true, value: { a: 1 } });
  });

  await t.test("merge: non-object next → error (also array is not a plain object)", () => {
    assert.equal(applyReducer("merge", { a: 1 }, 5).ok, false);
    assert.equal(applyReducer("merge", { a: 1 }, [1]).ok, false);
    assert.equal(applyReducer("merge", undefined, [1]).ok, false);
  });

  await t.test("merge: non-object current → error", () => {
    assert.equal(applyReducer("merge", 3, { a: 1 }).ok, false);
  });

  await t.test("merge: does not mutate current object", () => {
    const current = { a: 1 };
    applyReducer("merge", current, { b: 2 });
    assert.deepEqual(current, { a: 1 });
  });

  await t.test("sum: happy additions, undefined current treated as 0", () => {
    assert.deepEqual(applyReducer("sum", 5, 3), { ok: true, value: 8 });
    assert.deepEqual(applyReducer("sum", undefined, 4), { ok: true, value: 4 });
  });

  await t.test("sum: numeric coercion of string inputs", () => {
    assert.deepEqual(applyReducer("sum", "1", "2"), { ok: true, value: 3 });
  });

  await t.test("sum: non-finite result → error (NaN and Infinity)", () => {
    const nan = applyReducer("sum", 1, "not a number");
    assert.equal(nan.ok, false);
    if (!nan.ok) assert.match(nan.error, /non-finite/);
    assert.equal(applyReducer("sum", Infinity, 1).ok, false);
  });

  await t.test("max: happy, undefined current is first-write (-Infinity baseline)", () => {
    assert.deepEqual(applyReducer("max", 5, 3), { ok: true, value: 5 });
    assert.deepEqual(applyReducer("max", 5, 9), { ok: true, value: 9 });
    assert.deepEqual(applyReducer("max", undefined, -7), { ok: true, value: -7 });
  });
});
