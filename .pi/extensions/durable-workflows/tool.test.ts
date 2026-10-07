/**
 * tool.test.ts — node:test suite for tool.ts (Task 5). Exercises
 * dispatch() end-to-end against a temp-dir store (os.tmpdir, cleaned in
 * an after hook): the full happy path, every refusal case from the
 * todo, commit atomicity (reducer violation → entry count unchanged),
 * the parallel-merge through the tool, fork prefix copy with a
 * byte-identical source (sha256), inspect prefix folds, and status
 * listing phases.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dispatch, type ToolCtx } from "./tool.ts";
import { entryCount } from "./log.ts";
import { hashGraph, validateGraph, type Graph } from "./graph.ts";

// ---------------------------------------------------------------------------
// Harness: a fresh temp store per test file run, one ctx shared.
// ---------------------------------------------------------------------------

const storeRoot = mkdtempSync(join(tmpdir(), "durable-wf-tool-"));
const ctx: ToolCtx = { storeRoot, cwd: "/unused" };

test.after(() => {
  rmSync(storeRoot, { recursive: true, force: true });
});

function ok(res: { ok: boolean; result?: unknown; error?: string }): any {
  assert.equal(res.ok, true, `expected ok, got error: ${res.error}`);
  return res.result;
}

function err(res: { ok: boolean; result?: unknown; error?: string }): string {
  assert.equal(res.ok, false, `expected error, got: ${JSON.stringify(res.result)}`);
  return res.error as string;
}

// The SPEC user-story graph, trimmed for tool tests.
const GRAPH_INPUT = {
  nodes: [
    { id: "research", type: "subagent", needs: [], prompt: "Research the topic" },
    { id: "review_a", type: "subagent", needs: ["research"], prompt: "Review part A" },
    { id: "review_b", type: "subagent", needs: ["research"], prompt: "Review part B" },
    { id: "merge", type: "shell", needs: ["review_a", "review_b"], command: "cat parts > whole" },
    { id: "approve", type: "subagent", needs: ["merge"], prompt: "Ask the user" },
  ],
  reducers: { findings: "append", verdict: "merge", count: "sum" },
  initial: { findings: [], verdict: {}, count: 0 },
};

function makeGraph(): Graph {
  const validated = validateGraph(GRAPH_INPUT);
  assert.ok(validated.ok, validated.ok ? "" : validated.error);
  return validated.graph;
}

function createThread(threadId: string): ReturnType<typeof dispatch> {
  return dispatch("create", { thread_id: threadId, graph: GRAPH_INPUT }, ctx) as ReturnType<typeof dispatch>;
}

function d(action: string, input: Record<string, unknown>) {
  return dispatch(action, input, ctx);
}

// ---------------------------------------------------------------------------
// Happy path: create → next → step_start → commit → next shows progression
// ---------------------------------------------------------------------------

test("happy path: create → next → step_start → commit → next shows progression", async () => {
  const created = ok(await d("create", { thread_id: "happy", graph: GRAPH_INPUT }));
  const graph = makeGraph();
  assert.equal(created.thread_id, "happy");
  assert.equal(created.graph_hash, hashGraph(graph));

  const next0 = ok(await d("next", { thread_id: "happy" }));
  assert.deepEqual(next0.ready, ["research"]);
  assert.deepEqual(next0.blocked, ["review_a", "review_b", "merge", "approve"]);
  assert.deepEqual(next0.blocked_detail, {
    review_a: ["research"],
    review_b: ["research"],
    merge: ["review_a", "review_b"],
    approve: ["merge"],
  });
  assert.equal(next0.awaiting, false);
  assert.deepEqual(next0.state, { findings: [], verdict: {}, count: 0 });

  ok(
    await d("step_start", {
      thread_id: "happy",
      node: "research",
      launch: { kind: "subagent", ref: "run-1" },
    }),
  );
  const mid = ok(await d("next", { thread_id: "happy" }));
  assert.deepEqual(mid.ready, []); // research in flight (orphan)
  assert.equal(mid.orphans.length, 1);
  assert.deepEqual(mid.orphans[0], {
    node: "research",
    launch: { kind: "subagent", ref: "run-1" },
  });

  const committed = ok(
    await d("commit", {
      thread_id: "happy",
      node: "research",
      output: { findings: ["f1"], count: 2 },
      summary: "did research",
    }),
  );
  assert.deepEqual(committed, { committed: "research", status: "ok", origin: "run" });

  const next1 = ok(await d("next", { thread_id: "happy" }));
  assert.deepEqual(next1.ready, ["review_a", "review_b"]);
  assert.deepEqual(next1.done, ["research"]);
  assert.deepEqual(next1.blocked, ["merge", "approve"]);
  assert.deepEqual(next1.state.count, 2);
  assert.deepEqual(next1.state.findings, ["f1"]);

  // review_a commits; parallel-merge setup for the other test lives in its own test.
  ok(
    await d("step_start", {
      thread_id: "happy",
      node: "review_a",
      launch: { kind: "subagent", ref: "run-2" },
    }),
  );
  ok(
    await d("commit", {
      thread_id: "happy",
      node: "review_a",
      output: { findings: ["fa"] },
    }),
  );
  const next2 = ok(await d("next", { thread_id: "happy" }));
  assert.deepEqual(next2.state.findings, ["f1", "fa"]);
  assert.deepEqual(next2.ready, ["review_b"]);
});

// ---------------------------------------------------------------------------
// create variants
// ---------------------------------------------------------------------------

test("create derives a slug from title", async () => {
  const created = ok(
    await d("create", { title: "Fix the Flaky Test!", graph: GRAPH_INPUT }),
  );
  assert.equal(created.thread_id, "fix-the-flaky-test");
});

test("create refuses an unslugable title", async () => {
  const e = err(await d("create", { title: "!!!", graph: GRAPH_INPUT }));
  assert.match(e, /cannot derive a thread id/);
});

test("create refuses a bad thread_id", async () => {
  assert.match(err(await d("create", { thread_id: "../evil", graph: GRAPH_INPUT }), ), /must match/);
  assert.match(err(await d("create", { thread_id: "UPPER", graph: GRAPH_INPUT }), ), /must match/);
});

test("create refuses a bad graph", async () => {
  assert.match(
    err(await d("create", { thread_id: "badgraph", graph: { nodes: [] } })),
    /invalid graph/,
  );
  assert.match(
    err(
      await d("create", {
        thread_id: "badgraph2",
        graph: {
          nodes: [{ id: "a", type: "subagent", needs: [], prompt: "p" }],
          reducers: { k: "nope" },
          initial: { k: 0 },
        },
      }),
    ),
    /unknown reducer/,
  );
});

test("create refuses an existing thread but allows an existing EMPTY log file", async () => {
  await createThread("dup");
  assert.match(err(await d("create", { thread_id: "dup", graph: GRAPH_INPUT })), /already exists/);
  await createThread("empty-file");
  // Now truncate to an empty file and re-create: allowed.
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(storeRoot, "durable-workflows", "empty-file", "log.jsonl"), "");
  const again = ok(await d("create", { thread_id: "empty-file", graph: GRAPH_INPUT }));
  assert.equal(again.thread_id, "empty-file");
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

test("unknown action", async () => {
  assert.equal(err(await d("frobnicate", {})), "unknown action frobnicate");
});

test("unknown thread: next/step_start/commit/status-id/fork all refuse", async () => {
  for (const action of ["next", "step_start", "commit", "inspect", "fork"]) {
    const input: Record<string, unknown> = { thread_id: "no-such-thread", node: "x", to: 0 };
    if (action === "step_start") input.launch = { kind: "shell", ref: "r" };
    if (action === "commit") input.output = {};
    const res = await d(action, input);
    assert.match(err(res), /thread no-such-thread not found/, action);
  }
  assert.match(err(await d("status", { thread_id: "no-such-thread" })), /not found/);
});

test("commit without step_start refuses", async () => {
  await createThread("orphan-commit");
  assert.match(
    err(await d("commit", { thread_id: "orphan-commit", node: "research", output: {} })),
    /no step_start to commit for research/,
  );
});

test("step_start of an unknown node refuses", async () => {
  await createThread("unknown-node");
  assert.match(
    err(
      await d("step_start", {
        thread_id: "unknown-node",
        node: "nope",
        launch: { kind: "shell", ref: "r" },
      }),
    ),
    /unknown node nope/,
  );
});

test("step_start of a not-ready node refuses (blocked / done)", async () => {
  await createThread("not-ready");
  // blocked: merge needs reviews
  assert.match(
    err(
      await d("step_start", {
        thread_id: "not-ready",
        node: "merge",
        launch: { kind: "shell", ref: "r" },
      }),
    ),
    /node merge is not ready/,
  );
  // done: finish research then try again
  ok(
    await d("step_start", {
      thread_id: "not-ready",
      node: "research",
      launch: { kind: "subagent", ref: "r1" },
    }),
  );
  ok(await d("commit", { thread_id: "not-ready", node: "research", output: {} }));
  assert.match(
    err(
      await d("step_start", {
        thread_id: "not-ready",
        node: "research",
        launch: { kind: "subagent", ref: "r2" },
      }),
    ),
    /node research is not ready/,
  );
});

test("step_start during awaiting gate is refused with awaiting in the message", async () => {
  await createThread("gated");
  ok(
    await d("interrupt", { thread_id: "gated", question: "Proceed?", options: ["yes", "no"] }),
  );
  const next = ok(await d("next", { thread_id: "gated" }));
  assert.equal(next.awaiting, true);
  assert.deepEqual(next.ready, []);
  const e = err(
    await d("step_start", {
      thread_id: "gated",
      node: "research",
      launch: { kind: "subagent", ref: "r" },
    }),
  );
  assert.match(e, /not ready/);
  assert.match(e, /awaiting/);
});

test("resume without interrupt refuses", async () => {
  await createThread("no-interrupt");
  assert.match(err(await d("resume", { thread_id: "no-interrupt", answer: "yes" })), /no interrupt to resume/);
});

test("interrupt requires a non-empty question; resume requires a non-empty answer", async () => {
  await createThread("nonempty");
  assert.match(err(await d("interrupt", { thread_id: "nonempty", question: "" })), /question/);
  ok(await d("interrupt", { thread_id: "nonempty", question: "Q?" }));
  assert.match(err(await d("resume", { thread_id: "nonempty", answer: "" })), /answer/);
});

test("inspect out-of-range refuses with the valid range", async () => {
  await createThread("range");
  assert.match(err(await d("inspect", { thread_id: "range", to: 5 })), /must be an integer in \[0, 0\]/);
  assert.match(err(await d("inspect", { thread_id: "range", to: -1 })), /must be an integer/);
  assert.match(err(await d("inspect", { thread_id: "range", to: 1.5 })), /must be an integer/);
});

test("fork refuses to an existing id", async () => {
  await createThread("fork-src");
  await createThread("fork-dup");
  assert.match(
    err(
      await d("fork", { thread_id: "fork-src", new_thread_id: "fork-dup" }),
    ),
    /already exists/,
  );
});

test("fork out-of-range to refuses", async () => {
  await createThread("fork-range");
  assert.match(err(await d("fork", { thread_id: "fork-range", to: 9 })), /must be an integer in \[0, 0\]/);
});

// ---------------------------------------------------------------------------
// commit semantics
// ---------------------------------------------------------------------------

test("oversized output is refused by the 64 KiB entry cap", async () => {
  await createThread("big");
  ok(
    await d("step_start", {
      thread_id: "big",
      node: "research",
      launch: { kind: "subagent", ref: "r" },
    }),
  );
  const big = "x".repeat(70 * 1024);
  const e = err(await d("commit", { thread_id: "big", node: "research", output: { blob: big } }));
  assert.match(e, /64 KiB cap/);
  // The log is untouched: the node is still an orphan (start not consumed).
  const next = ok(await d("next", { thread_id: "big" }));
  assert.equal(next.orphans.length, 1);
});

test("reducer violation on commit is refused BEFORE append (atomicity)", async () => {
  await createThread("atomic");
  ok(
    await d("step_start", {
      thread_id: "atomic",
      node: "research",
      launch: { kind: "subagent", ref: "r" },
    }),
  );
  // findings is an append reducer; a non-array next violates it.
  const before = entryCount(join(storeRoot, "durable-workflows", "atomic"));
  const e = err(
    await d("commit", {
      thread_id: "atomic",
      node: "research",
      output: { findings: "not-an-array" },
    }),
  );
  assert.match(e, /commit refused \(would violate fold\)/);
  assert.match(e, /append requires both current and next to be arrays/);
  const after = entryCount(join(storeRoot, "durable-workflows", "atomic"));
  assert.equal(after, before, "entry count must be unchanged on refused commit");
  // The node is still startable/committable afterwards: nothing half-landed.
  ok(
    await d("commit", {
      thread_id: "atomic",
      node: "research",
      output: { findings: ["ok-now"] },
    }),
  );
  const next = ok(await d("next", { thread_id: "atomic" }));
  assert.deepEqual(next.state.findings, ["ok-now"]);
});

test("commit with status error skips the dry-run and lands; node goes to failed", async () => {
  await createThread("err-commit");
  ok(
    await d("step_start", {
      thread_id: "err-commit",
      node: "research",
      launch: { kind: "subagent", ref: "r" },
    }),
  );
  const res = ok(
    await d("commit", {
      thread_id: "err-commit",
      node: "research",
      status: "error",
      output: { findings: "anything-goes" }, // not validated against reducers
    }),
  );
  assert.equal(res.status, "error");
  const next = ok(await d("next", { thread_id: "err-commit" }));
  assert.deepEqual(next.failed, ["research"]);
  assert.deepEqual(next.ready, ["research"]); // retryable
  assert.deepEqual(next.state.findings, []); // nothing written
});

test("bad commit input validation: status/origin enums", async () => {
  await createThread("enums");
  ok(
    await d("step_start", {
      thread_id: "enums",
      node: "research",
      launch: { kind: "subagent", ref: "r" },
    }),
  );
  assert.match(err(await d("commit", { thread_id: "enums", node: "research", status: "meh" })), /status must be/);
  assert.match(err(await d("commit", { thread_id: "enums", node: "research", origin: "side" })), /origin must be/);
});

test("parallel merge through dispatch: two review commits merge into one key", async () => {
  await createThread("parallel");
  ok(
    await d("step_start", {
      thread_id: "parallel",
      node: "research",
      launch: { kind: "subagent", ref: "r0" },
    }),
  );
  ok(await d("commit", { thread_id: "parallel", node: "research", output: {} }));
  for (const node of ["review_a", "review_b"] as const) {
    ok(
      await d("step_start", {
        thread_id: "parallel",
        node,
        launch: { kind: "subagent", ref: `r-${node}` },
      }),
    );
    ok(
      await d("commit", {
        thread_id: "parallel",
        node,
        output: { findings: [`${node}-finding`] },
      }),
    );
  }
  const next = ok(await d("next", { thread_id: "parallel" }));
  assert.deepEqual(next.state.findings, ["review_a-finding", "review_b-finding"]);
  assert.deepEqual(next.ready, ["merge"]);
  assert.deepEqual(next.done, ["research", "review_a", "review_b"]);
});

// ---------------------------------------------------------------------------
// interrupt / resume
// ---------------------------------------------------------------------------

test("interrupt → awaiting → resume with typed answer → ready returns", async () => {
  await createThread("gate");
  ok(
    await d("step_start", {
      thread_id: "gate",
      node: "research",
      launch: { kind: "subagent", ref: "r" },
    }),
  );
  ok(await d("commit", { thread_id: "gate", node: "research", output: {} }));
  const interrupted = ok(
    await d("interrupt", { thread_id: "gate", question: "Apply the fix now?", options: ["yes", "no"] }),
  );
  assert.deepEqual(interrupted, { interrupted: true, question: "Apply the fix now?", options: ["yes", "no"] });

  const awaiting = ok(await d("next", { thread_id: "gate" }));
  assert.equal(awaiting.awaiting, true);
  assert.deepEqual(awaiting.ready, []);

  const resumed = ok(await d("resume", { thread_id: "gate", answer: "yes" }));
  assert.deepEqual(resumed, { resumed: true, answer: "yes", ready: ["review_a", "review_b"] });

  const after = ok(await d("next", { thread_id: "gate" }));
  assert.equal(after.awaiting, false);
  assert.deepEqual(after.ready, ["review_a", "review_b"]);
});

// ---------------------------------------------------------------------------
// in-flight rerun path (orphan re-launch)
// ---------------------------------------------------------------------------

test("step_start on an orphaned node is allowed (rerun path); commit records rerun", async () => {
  await createThread("rerun");
  ok(
    await d("step_start", {
      thread_id: "rerun",
      node: "research",
      launch: { kind: "subagent", ref: "r1" },
    }),
  );
  // Crash surrogate: re-issue step_start on the same orphaned node.
  ok(
    await d("step_start", {
      thread_id: "rerun",
      node: "research",
      launch: { kind: "subagent", ref: "r2" },
    }),
  );
  const mid = ok(await d("next", { thread_id: "rerun" }));
  assert.equal(mid.orphans.length, 1);
  assert.deepEqual(mid.orphans[0].launch, { kind: "subagent", ref: "r2" });
  ok(
    await d("commit", {
      thread_id: "rerun",
      node: "research",
      output: {},
      origin: "rerun",
    }),
  );
  const next = ok(await d("next", { thread_id: "rerun" }));
  assert.equal(next.lastRerunNode, "research");
});

// ---------------------------------------------------------------------------
// inspect
// ---------------------------------------------------------------------------

test("inspect at 0 returns the initial state; at later indexes returns the recorded prefix", async () => {
  await createThread("time-travel");
  ok(
    await d("step_start", {
      thread_id: "time-travel",
      node: "research",
      launch: { kind: "subagent", ref: "r" },
    }),
  );
  ok(
    await d("commit", {
      thread_id: "time-travel",
      node: "research",
      output: { count: 5, findings: ["x"] },
    }),
  );
  ok(
    await d("interrupt", { thread_id: "time-travel", question: "go on?" }),
  );

  const at0 = ok(await d("inspect", { thread_id: "time-travel", to: 0 }));
  assert.equal(at0.up_to, 0);
  assert.deepEqual(at0.state, { findings: [], verdict: {}, count: 0 });
  assert.deepEqual(at0.ready, ["research"]);
  assert.equal(at0.awaiting, false);
  assert.equal(at0.truncatedTail, false);

  const at3 = ok(await d("inspect", { thread_id: "time-travel", to: 3 }));
  assert.equal(at3.up_to, 3);
  assert.deepEqual(at3.state, { findings: ["x"], verdict: {}, count: 5 });
  assert.deepEqual(at3.done, ["research"]);
  assert.equal(at3.awaiting, true);
});

// ---------------------------------------------------------------------------
// fork
// ---------------------------------------------------------------------------

test("fork copies the prefix; source log byte-identical (sha256)", async () => {
  await createThread("forkable");
  ok(
    await d("step_start", {
      thread_id: "forkable",
      node: "research",
      launch: { kind: "subagent", ref: "r" },
    }),
  );
  ok(
    await d("commit", {
      thread_id: "forkable",
      node: "research",
      output: { count: 3 },
    }),
  );
  const sourcePath = join(storeRoot, "durable-workflows", "forkable", "log.jsonl");
  const shaBefore = createHash("sha256").update(
    (await import("node:fs")).readFileSync(sourcePath),
  ).digest("hex");

  const res = ok(await d("fork", { thread_id: "forkable", new_thread_id: "forked" }));
  assert.deepEqual(res, { thread_id: "forked", copied: 3, source_untouched: true });

  const shaAfter = createHash("sha256").update(
    (await import("node:fs")).readFileSync(sourcePath),
  ).digest("hex");
  assert.equal(shaAfter, shaBefore, "source log must be byte-identical after fork");

  // The fork's fold matches the source at the fork point.
  const forkNext = ok(await d("next", { thread_id: "forked" }));
  assert.deepEqual(forkNext.state, { findings: [], verdict: {}, count: 3 });
  assert.deepEqual(forkNext.ready, ["review_a", "review_b"]);
  assert.deepEqual(forkNext.done, ["research"]);

  // Default id: "<source>-fork-<8hex>".
  const auto = ok(await d("fork", { thread_id: "forkable" }));
  assert.match(auto.thread_id, /^forkable-fork-[0-9a-f]{8}$/);
  assert.equal(auto.copied, 3);
});

test("fork of a prefix at to=1 excludes later entries", async () => {
  await createThread("fork-prefix");
  ok(
    await d("step_start", {
      thread_id: "fork-prefix",
      node: "research",
      launch: { kind: "subagent", ref: "r" },
    }),
  );
  ok(
    await d("commit", {
      thread_id: "fork-prefix",
      node: "research",
      output: { count: 9 },
    }),
  );
  // to=2 includes the commit; to=1 excludes it (prefix proof).
  const res = ok(await d("fork", { thread_id: "fork-prefix", to: 2, new_thread_id: "fork-p2" }));
  assert.equal(res.copied, 3);
  const folded = ok(await d("next", { thread_id: "fork-p2" }));
  assert.deepEqual(folded.state.count, 9);
  assert.deepEqual(folded.done, ["research"]);

  const resShort = ok(await d("fork", { thread_id: "fork-prefix", to: 1, new_thread_id: "fork-p1" }));
  assert.equal(resShort.copied, 2);
  const foldedShort = ok(await d("next", { thread_id: "fork-p1" }));
  assert.deepEqual(foldedShort.state.count, 0); // step_result excluded
  assert.deepEqual(foldedShort.orphans.length, 1); // research in flight
});

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

test("status without id lists threads with phases; with id matches the next shape", async () => {
  await createThread("st-ready");
  await createThread("st-awaiting");
  await createThread("st-done");
  ok(await d("interrupt", { thread_id: "st-awaiting", question: "wait" }));

  // Drive st-done to completion (merge + approve done).
  for (const [node, launch, output] of [
    ["research", { kind: "subagent", ref: "r" }, {}],
    ["review_a", { kind: "subagent", ref: "r1" }, { findings: ["a"] }],
    ["review_b", { kind: "subagent", ref: "r2" }, { findings: ["b"] }],
    ["merge", { kind: "shell", ref: "r3" }, {}],
    ["approve", { kind: "subagent", ref: "r4" }, {}],
  ] as Array<[string, { kind: "subagent" | "shell"; ref: string }, Record<string, unknown>]>) {
    ok(await d("step_start", { thread_id: "st-done", node, launch }));
    ok(await d("commit", { thread_id: "st-done", node, output }));
  }

  const listing = ok(await d("status", {}));
  const byId = new Map<string, any>(
    (listing.threads as any[]).map((t) => [t.thread_id, t]),
  );
  assert.equal(byId.get("st-ready").phase, "ready");
  assert.equal(byId.get("st-ready").ready_count, 1);
  assert.equal(byId.get("st-ready").awaiting, false);
  assert.equal(byId.get("st-ready").title, undefined);
  assert.equal(byId.get("st-awaiting").phase, "awaiting");
  assert.equal(byId.get("st-awaiting").awaiting, true);
  assert.equal(byId.get("st-done").phase, "done");
  assert.ok(typeof byId.get("st-done").updated === "string");
  assert.ok(existsSync(join(storeRoot, "durable-workflows", "st-done", "log.jsonl")));

  // Empty-phase thread: blocked graph is hard to build without a blocked
  // root, so exercise "empty" via a single-node done graph.
  const solo = ok(
    await d("create", {
      thread_id: "st-empty",
      graph: {
        nodes: [{ id: "only", type: "shell", needs: [], command: "true" }],
        reducers: {},
        initial: {},
      },
    }),
  );
  assert.equal(solo.thread_id, "st-empty");
  const listing2 = ok(await d("status", {}));
  const row = (listing2.threads as any[]).find((t) => t.thread_id === "st-empty");
  assert.equal(row.phase, "ready"); // a single root node is ready, not empty

  // status with id = the next shape (fold + blocked_detail).
  const withId = ok(await d("status", { thread_id: "st-ready" }));
  const next = ok(await d("next", { thread_id: "st-ready" }));
  assert.deepEqual(withId, next);
  assert.ok(withId.blocked_detail);
});

test("status listing shows in-flight for orphaned mid-run threads", async () => {
  // A thread with a started-but-uncommitted node is neither ready, blocked,
  // done, nor empty — its phase must be "in-flight" (regression: this used
  // to fall through to "empty" because orphans were not in the phase map).
  ok(
    await d("create", {
      thread_id: "st-inflight",
      graph: {
        nodes: [{ id: "solo", type: "shell", needs: [], command: "true" }],
        reducers: {},
        initial: {},
      },
    }),
  );
  ok(await d("step_start", { thread_id: "st-inflight", node: "solo", launch: { kind: "shell", ref: "r1" } }));
  const listing = ok(await d("status", {}));
  const row = (listing.threads as any[]).find((t) => t.thread_id === "st-inflight");
  assert.equal(row.phase, "in-flight");
});

test("status listing keeps blocked priority over in-flight when both present", async () => {
  // blocked (someone waiting on an unmet need) outranks in-flight in the
  // phase order — same fixture shape that exposed the original fall-through.
  ok(
    await d("create", {
      thread_id: "st-mixed",
      graph: {
        nodes: [
          { id: "solo", type: "shell", needs: [], command: "true" },
          { id: "next_up", type: "shell", needs: ["solo"], command: "true" },
        ],
        reducers: {},
        initial: {},
      },
    }),
  );
  ok(await d("step_start", { thread_id: "st-mixed", node: "solo", launch: { kind: "shell", ref: "r1" } }));
  const listing = ok(await d("status", {}));
  const row = (listing.threads as any[]).find((t) => t.thread_id === "st-mixed");
  assert.equal(row.phase, "blocked");
});

test("status listing skips an unreadable thread instead of failing", async () => {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const broken = join(storeRoot, "durable-workflows", "zz-broken");
  mkdirSync(broken, { recursive: true });
  writeFileSync(join(broken, "log.jsonl"), "not json at all\n", { mode: 0o444 });
  const listing = ok(await d("status", {}));
  assert.equal(
    (listing.threads as any[]).some((t) => t.thread_id === "zz-broken"),
    false,
  );
  rmSync(broken, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// JSON-string coercion of nested-object inputs (provider compatibility)
// ---------------------------------------------------------------------------

test("create accepts graph as a JSON-encoded string; hash matches the object form", async () => {
  const graphString = JSON.stringify(GRAPH_INPUT);
  const fromObject = ok(await d("create", { thread_id: "coerce-obj", graph: GRAPH_INPUT }));
  const fromString = ok(
    await d("create", { thread_id: "coerce-str", graph: graphString }),
  );
  assert.equal(fromString.graph_hash, fromObject.graph_hash);
  assert.equal(fromString.thread_id, "coerce-str");
});

test("create with graph as invalid-JSON string gives the normal graph error, no crash", async () => {
  const e = err(await d("create", { thread_id: "coerce-bad", graph: "{not json" }));
  assert.match(e, /invalid graph|must be a JSON object/);
});

test("create with graph as a string parsing to a non-object (array/number) gives the normal error", async () => {
  const arrayCase = err(
    await d("create", { thread_id: "coerce-arr", graph: JSON.stringify([1, 2]) }),
  );
  assert.match(arrayCase, /invalid graph|must be a JSON object/);
  const numberCase = err(
    await d("create", { thread_id: "coerce-num", graph: JSON.stringify(42) }),
  );
  assert.match(numberCase, /invalid graph|must be a JSON object/);
});

test("step_start accepts launch as a JSON-encoded string", async () => {
  await createThread("coerce-launch");
  const res = ok(
    await d("step_start", {
      thread_id: "coerce-launch",
      node: "research",
      launch: JSON.stringify({ kind: "subagent", ref: "r-str" }),
    }),
  );
  assert.deepEqual(res.launch, { kind: "subagent", ref: "r-str" });
});

test("commit accepts output as a JSON-encoded string; folds identically to the object form", async () => {
  await createThread("coerce-output");
  ok(
    await d("step_start", {
      thread_id: "coerce-output",
      node: "research",
      launch: { kind: "subagent", ref: "r" },
    }),
  );
  ok(
    await d("commit", {
      thread_id: "coerce-output",
      node: "research",
      output: JSON.stringify({ findings: ["from-string"], count: 7 }),
    }),
  );
  const next = ok(await d("next", { thread_id: "coerce-output" }));
  assert.deepEqual(next.state, { findings: ["from-string"], verdict: {}, count: 7 });
});
