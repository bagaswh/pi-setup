/**
 * log.test.ts — validateEntry rejection rules, the 64 KiB append cap,
 * and the crash-tolerant readLog contract (truncated tail tolerated,
 * corrupt/empty middle line is a hard error naming the index). Fixtures
 * live in a per-run temp dir, cleaned up in after().
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendEntry,
  entryCount,
  MAX_ENTRY_BYTES,
  nowIso,
  readLog,
  validateEntry,
  type Interrupt,
  type Launch,
  type LogEntry,
  type Resume,
  type StepResult,
  type StepStart,
  type ThreadMeta,
} from "./log.ts";
import { hashGraph, validateGraph, type Graph } from "./graph.ts";

const tempRoot = mkdtempSync(join(tmpdir(), "durable-workflows-log-test-"));
const tempDirs: string[] = [];

after(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

function freshDir(name: string): string {
  const dir = join(tempRoot, name);
  tempDirs.push(dir);
  return dir;
}

function validGraph(): Graph {
  return {
    nodes: [
      { id: "research", type: "shell", needs: [], command: "echo research" },
      { id: "review_a", type: "subagent", needs: ["research"], prompt: "review a" },
    ],
    reducers: { findings: "append" },
    initial: { findings: [] },
  };
}

function threadMeta(overrides: Partial<ThreadMeta> = {}): ThreadMeta {
  const graph = validGraph();
  return {
    t: "thread_meta",
    v: 1,
    thread_id: "fix-loop-1",
    title: "Fix the flaky test",
    graph,
    graph_hash: hashGraph(graph),
    ts: nowIso(),
    ...overrides,
  };
}

function stepStart(node = "research", launch: Launch = { kind: "shell", ref: "run-1" }): StepStart {
  return { t: "step_start", node, launch, ts: nowIso() };
}

function stepResult(overrides: Partial<StepResult> = {}): StepResult {
  return { t: "step_result", node: "research", status: "ok", ts: nowIso(), ...overrides };
}

function interrupt(overrides: Partial<Interrupt> = {}): Interrupt {
  return { t: "interrupt", question: "Apply the fix now?", ts: nowIso(), ...overrides };
}

function resume(overrides: Partial<Resume> = {}): Resume {
  return { t: "resume", answer: "yes", ts: nowIso(), ...overrides };
}

function appendAll(dir: string, entries: LogEntry[]): void {
  for (const e of entries) {
    const result = appendEntry(dir, e);
    assert.equal(result.ok, true);
  }
}

function expectRejection(obj: unknown, pattern: RegExp): void {
  const result = validateEntry(obj);
  assert.equal(result.ok, false, `expected rejection, got: ${JSON.stringify(result)}`);
  if (!result.ok) assert.match(result.error, pattern);
}

test("validateEntry: all five types accepted with required fields", () => {
  const cases: LogEntry[] = [
    threadMeta(),
    stepStart(),
    stepResult({ output: { findings: [] }, artifacts: ["docs/x.md"], summary: "done", origin: "run" }),
    interrupt({ options: ["yes", "no"] }),
    resume(),
  ];
  for (const entry of cases) {
    const result = validateEntry(structuredClone(entry));
    assert.equal(result.ok, true, JSON.stringify(result));
  }
});

test("validateEntry: thread_meta round-trips graph and hash", () => {
  const result = validateEntry(threadMeta());
  assert.equal(result.ok, true);
  if (result.ok && result.entry.t === "thread_meta") {
    const graph = result.entry.graph;
    assert.equal(validateGraph(graph).ok, true);
    assert.equal(result.entry.graph_hash, hashGraph(graph));
    assert.equal(result.entry.thread_id, "fix-loop-1");
  }
});

test("rejection: non-object entry", () => {
  for (const bad of [null, undefined, 42, "step", [], true]) {
    expectRejection(bad, /entry must be a JSON object/);
  }
});

test("rejection: unknown or missing t", () => {
  for (const t of ["step", "ThreadMeta", "step_start ", 7, undefined]) {
    expectRejection({ ...(t === undefined ? {} : { t }), ts: nowIso() }, /unknown entry type/);
  }
});

test("rejection: missing or empty ts", () => {
  for (const ts of [undefined, "", 42]) {
    expectRejection({ t: "resume", answer: "yes", ts }, /non-empty ts string/);
  }
});

test("rejection: thread_meta requires v === 1", () => {
  for (const v of [0, 2, "1", undefined, null]) {
    expectRejection({ t: "thread_meta", v, ...validGraphFields(), ts: nowIso() }, /v === 1/);
  }
});

function validGraphFields(): { thread_id: string; graph: Graph; graph_hash: string } {
  const graph = validGraph();
  return { thread_id: "fix-loop-1", graph, graph_hash: hashGraph(graph) };
}

test("rejection: thread_meta thread_id must match the slug pattern", () => {
  for (const thread_id of ["-lead", "Has_Caps", "has space", "x/y", ".", "..", "a".repeat(65), ""]) {
    expectRejection(
      { t: "thread_meta", v: 1, ...validGraphFields(), thread_id, ts: nowIso() },
      /thread_id/,
    );
  }
  // Boundary: 64-char slug is allowed.
  const ok = validateEntry({ t: "thread_meta", v: 1, ...validGraphFields(), thread_id: "a".repeat(64), ts: nowIso() });
  assert.equal(ok.ok, true);
});

test("rejection: thread_meta graph_hash must equal hashGraph(graph)", () => {
  const fields = validGraphFields();
  expectRejection(
    { t: "thread_meta", v: 1, ...fields, graph_hash: "sha256:deadbeef", ts: nowIso() },
    /graph_hash does not match/,
  );
});

test("rejection: thread_meta graph must pass validateGraph", () => {
  const fields = validGraphFields();
  expectRejection(
    { t: "thread_meta", v: 1, thread_id: "fix-loop-1", graph: { nodes: [] }, graph_hash: fields.graph_hash, ts: nowIso() },
    /graph invalid/,
  );
});

test("rejection: thread_meta title must be a string when present", () => {
  expectRejection(
    { t: "thread_meta", v: 1, ...validGraphFields(), title: 42, ts: nowIso() },
    /title must be a string/,
  );
});

test("rejection: step_start node/launch rules", () => {
  expectRejection({ t: "step_start", node: "", launch: { kind: "shell", ref: "r" }, ts: nowIso() }, /non-empty node/);
  expectRejection({ t: "step_start", node: "a", launch: null, ts: nowIso() }, /launch must be an object/);
  expectRejection({ t: "step_start", node: "a", launch: { kind: "exec", ref: "r" }, ts: nowIso() }, /launch\.kind/);
  expectRejection({ t: "step_start", node: "a", launch: { kind: "shell", ref: "" }, ts: nowIso() }, /launch\.ref/);
  expectRejection({ t: "step_start", node: "a", ts: nowIso() }, /launch must be an object/);
});

test("rejection: step_result status/origin/artifacts/summary rules", () => {
  expectRejection({ t: "step_result", node: "a", status: "skipped", ts: nowIso() }, /status must be "ok" or "error"/);
  expectRejection({ t: "step_result", node: "a", ts: nowIso() }, /status must be "ok" or "error"/);
  expectRejection({ t: "step_result", node: "a", status: "ok", origin: "retry", ts: nowIso() }, /origin/);
  expectRejection({ t: "step_result", node: "a", status: "ok", artifacts: "docs/x.md", ts: nowIso() }, /artifacts/);
  expectRejection({ t: "step_result", node: "a", status: "ok", artifacts: [1], ts: nowIso() }, /artifacts/);
  expectRejection({ t: "step_result", node: "a", status: "ok", summary: 5, ts: nowIso() }, /summary/);
});

test("rejection: interrupt question and resume answer must be non-empty", () => {
  expectRejection({ t: "interrupt", question: "", ts: nowIso() }, /non-empty question/);
  expectRejection({ t: "interrupt", ts: nowIso() }, /non-empty question/);
  expectRejection({ t: "interrupt", question: "?", options: [1], ts: nowIso() }, /options/);
  expectRejection({ t: "resume", answer: "", ts: nowIso() }, /non-empty answer/);
  expectRejection({ t: "resume", ts: nowIso() }, /non-empty answer/);
});

test("unknown extra fields are allowed (forward compat)", () => {
  const result = validateEntry({ ...resume(), future_field: { nested: true } });
  assert.equal(result.ok, true);
});

test("contract lock: graph_hash must be computed over the NORMALIZED graph", () => {
  // validateGraph normalizes (drops unknown node fields); validateEntry enforces
  // graph_hash === hashGraph(stored graph). A hand-authored entry whose hash was
  // computed over the raw graph is refused loudly — correct, but a landmine for
  // future authors. This test locks the contract: hash over validateGraph(graph).graph.
  const rawGraph = {
    nodes: [{ id: "a", type: "subagent" as const, needs: [], prompt: "p", futureField: "x" }],
    reducers: {},
    initial: {},
  };
  const rawHash = hashGraph(rawGraph as unknown as Graph);
  const withRawHash = { t: "thread_meta", v: 1, thread_id: "t", graph: rawGraph, graph_hash: rawHash, ts: nowIso() };
  assert.equal(validateEntry(withRawHash).ok, false, "hash over raw (unnormalized) graph must be refused");

  const norm = validateGraph(rawGraph);
  assert.ok(norm.ok);
  const withNormHash = { ...withRawHash, graph_hash: hashGraph(norm.graph) };
  const round = validateEntry(withNormHash);
  assert.equal(round.ok, true);
  if (round.ok && round.entry.t === "thread_meta") {
    assert.equal(round.entry.graph_hash, hashGraph(norm.graph));
  }
});

test("appendEntry + readLog round-trip: index = line number", () => {
  const dir = freshDir("roundtrip");
  const entries: LogEntry[] = [
    threadMeta(),
    stepStart(),
    stepResult({ output: { findings: [1, 2] } }),
    interrupt(),
    resume(),
  ];
  appendAll(dir, entries);

  const read = readLog(dir);
  assert.equal(read.ok, true);
  if (read.ok) {
    assert.equal(read.truncatedTail, false);
    assert.equal(read.entries.length, 5);
    // Entry index contract: entries[0] is the first line.
    assert.deepEqual(read.entries[0], entries[0]);
    read.entries.forEach((e, i) => assert.deepEqual(e, entries[i], `mismatch at index ${i}`));
    assert.equal(entryCount(dir), 5);
  }
});

test("readLog of absent dir/file: empty entries, truncatedTail false", () => {
  const dir = freshDir("absent-does-not-exist");
  const read = readLog(dir);
  assert.deepEqual(read, { ok: true, entries: [], truncatedTail: false });
  assert.equal(entryCount(dir), 0);
});

test("appendEntry creates the dir (mkdir -p)", () => {
  const dir = freshDir("nested/deeper/dir");
  assert.equal(appendEntry(dir, resume()).ok, true);
  assert.equal(entryCount(dir), 1);
});

test("64 KiB cap: oversized entry refused, nothing written", () => {
  const dir = freshDir("size-cap");
  const big: StepResult = {
    t: "step_result",
    node: "big",
    status: "ok",
    output: { blob: "x".repeat(MAX_ENTRY_BYTES + 1) },
    ts: nowIso(),
  };
  const result = appendEntry(dir, big);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /entry exceeds 64 KiB cap/);
  assert.equal(readLog(dir).ok, true);
  if (readLog(dir).ok) assert.equal(readLog(dir).entries.length, 0);
});

test("entry just under the cap is accepted", () => {
  const dir = freshDir("size-ok");
  const big: StepResult = {
    t: "step_result",
    node: "big",
    status: "ok",
    output: { blob: "x".repeat(MAX_ENTRY_BYTES - 200) },
    ts: nowIso(),
  };
  assert.equal(appendEntry(dir, big).ok, true);
  assert.equal(entryCount(dir), 1);
});

test("truncated tail (half-written final line) tolerated with prior entries intact", () => {
  const dir = freshDir("truncated-tail");
  const meta = threadMeta();
  const first: StepStart = stepStart();
  assert.equal(appendEntry(dir, meta).ok, true);
  assert.equal(appendEntry(dir, first).ok, true);
  // Crash mid-append: half a JSON line, no trailing newline.
  appendFileSync(join(dir, "log.jsonl"), '{"t":"step_sta', "utf8");

  const read = readLog(dir);
  assert.equal(read.ok, true);
  if (read.ok) {
    assert.equal(read.truncatedTail, true);
    assert.equal(read.entries.length, 2);
    assert.deepEqual(read.entries[0], meta);
    assert.deepEqual(read.entries[1], first);
  }
});

test("truncated tail: complete but invalid final line also tolerated", () => {
  const dir = freshDir("invalid-final");
  assert.equal(appendEntry(dir, threadMeta()).ok, true);
  appendFileSync(join(dir, "log.jsonl"), '{"t":"nope"}\n', "utf8");
  const read = readLog(dir);
  assert.equal(read.ok, true);
  if (read.ok) {
    assert.equal(read.truncatedTail, true);
    assert.equal(read.entries.length, 1);
  }
});

test("corrupt middle line is a hard error naming its index", () => {
  const dir = freshDir("corrupt-middle");
  assert.equal(appendEntry(dir, threadMeta()).ok, true);
  appendFileSync(join(dir, "log.jsonl"), '{"broken\n', "utf8");
  assert.equal(appendEntry(dir, resume()).ok, true);

  const read = readLog(dir);
  assert.equal(read.ok, false);
  if (!read.ok) {
    assert.match(read.error, /line 1/);
    assert.match(read.error, /invalid JSON/);
    assert.equal(read.index, 1);
  }
});

test("empty line in the middle is a hard error naming its index", () => {
  const dir = freshDir("empty-middle");
  assert.equal(appendEntry(dir, threadMeta()).ok, true);
  appendFileSync(join(dir, "log.jsonl"), '\n', "utf8");
  assert.equal(appendEntry(dir, resume()).ok, true);

  const read = readLog(dir);
  assert.equal(read.ok, false);
  if (!read.ok) {
    assert.match(read.error, /empty line at index 1/);
    assert.equal(read.index, 1);
  }
});

test("entryCount throws on a corrupt log (hard error path)", () => {
  const dir = freshDir("count-throws");
  assert.equal(appendEntry(dir, threadMeta()).ok, true);
  appendFileSync(join(dir, "log.jsonl"), '{"broken\n', "utf8");
  assert.equal(appendEntry(dir, resume()).ok, true);
  assert.throws(() => entryCount(dir), /line 1/);
});

test("nowIso returns a parseable ISO 8601 timestamp", () => {
  const ts = nowIso();
  assert.match(ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(new Date(ts).toISOString(), ts);
});
