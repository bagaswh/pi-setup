/**
 * graph.test.ts — validation rules, canonicalization, and hash stability
 * for graph.ts. Every rejection rule gets its own subtest; hash tests
 * prove insertion-order independence.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { canonicalJson, hashGraph, validateGraph, type Graph } from "./graph.ts";

function subagent(id: string, needs: string[] = []): Graph["nodes"][number] {
  return { id, type: "subagent", needs, prompt: `do ${id}` };
}

function shellNode(id: string, needs: string[] = []): Graph["nodes"][number] {
  return { id, type: "shell", needs, command: `echo ${id}` };
}

function validGraph(): Graph {
  return {
    nodes: [subagent("research"), subagent("review_a", ["research"]), shellNode("build", ["research"])],
    reducers: { findings: "append", count: "sum" },
    initial: { findings: [], count: 0 },
  };
}

test("valid graph passes", () => {
  const result = validateGraph(validGraph());
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.graph.nodes.length, 3);
    assert.deepEqual(result.graph.reducers, { findings: "append", count: "sum" });
    assert.deepEqual(result.graph.initial, { findings: [], count: 0 });
  }
});

test("rejection: non-object graph", () => {
  for (const bad of [null, undefined, 42, "graph", [], true]) {
    const result = validateGraph(bad);
    assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(bad)}`);
    if (!result.ok) assert.match(result.error, /must be a JSON object/);
  }
});

test("rejection: nodes not a non-empty array", () => {
  for (const nodes of [undefined, [], "nodes", {}, 5]) {
    const result = validateGraph({ nodes, reducers: {}, initial: {} });
    assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(nodes)}`);
    if (!result.ok) assert.match(result.error, /nodes must be a non-empty array/);
  }
});

test("rejection: duplicate node ids", () => {
  const result = validateGraph({
    nodes: [subagent("dup"), subagent("dup")],
    reducers: {},
    initial: {},
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /duplicate node id: dup/);
});

test("rejection: node id not matching the slug pattern", () => {
  for (const id of ["-lead", "_lead", "Has-Caps", "has space", "a".repeat(65), "x/y"]) {
    const result = validateGraph({ nodes: [{ ...subagent("ok"), id }], reducers: {}, initial: {} });
    assert.equal(result.ok, false, `expected rejection for id ${JSON.stringify(id)}`);
    if (!result.ok) assert.match(result.error, /\^\[a-z0-9\]\[a-z0-9_-\]\{0,63\}\$/);
  }
  // Empty id is rejected too, by the non-empty-id rule.
  const empty = validateGraph({ nodes: [{ ...subagent("ok"), id: "" }], reducers: {}, initial: {} });
  assert.equal(empty.ok, false);
  // Boundary: 64-char id is allowed.
  const ok = validateGraph({ nodes: [{ ...subagent("ok"), id: "a".repeat(64) }], reducers: {}, initial: {} });
  assert.equal(ok.ok, true);
});

test("rejection: needs referencing an unknown node", () => {
  const result = validateGraph({
    nodes: [subagent("a", ["ghost"])],
    reducers: {},
    initial: {},
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /needs unknown node "ghost"/);
});

test("rejection: three-node needs cycle reports the cycle", () => {
  const result = validateGraph({
    nodes: [subagent("a", ["c"]), subagent("b", ["a"]), subagent("c", ["b"])],
    reducers: {},
    initial: {},
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /cycle/);
    for (const id of ["a", "b", "c"]) {
      assert.ok(result.error.includes(id), `cycle error should name ${id}: ${result.error}`);
    }
  }
});

test("rejection: two-node cycle and self-reference", () => {
  const two = validateGraph({
    nodes: [subagent("a", ["b"]), subagent("b", ["a"])],
    reducers: {},
    initial: {},
  });
  assert.equal(two.ok, false);
  if (!two.ok) assert.match(two.error, /cycle/);

  const self = validateGraph({ nodes: [subagent("a", ["a"])], reducers: {}, initial: {} });
  assert.equal(self.ok, false);
  if (!self.ok) assert.match(self.error, /needs itself/);
});

test("rejection: node.type outside subagent|shell", () => {
  const result = validateGraph({
    nodes: [{ id: "weird", type: "llm", needs: [], prompt: "x" }],
    reducers: {},
    initial: {},
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /type must be "subagent" or "shell"/);
});

test("rejection: subagent node without non-empty prompt", () => {
  for (const prompt of [undefined, ""]) {
    const result = validateGraph({
      nodes: [{ id: "a", type: "subagent", needs: [], prompt: prompt as string }],
      reducers: {},
      initial: {},
    });
    assert.equal(result.ok, false, `expected rejection for prompt ${JSON.stringify(prompt)}`);
    if (!result.ok) assert.match(result.error, /requires a non-empty prompt/);
  }
});

test("rejection: shell node without non-empty command", () => {
  for (const command of [undefined, ""]) {
    const result = validateGraph({
      nodes: [{ id: "a", type: "shell", needs: [], command: command as string }],
      reducers: {},
      initial: {},
    });
    assert.equal(result.ok, false, `expected rejection for command ${JSON.stringify(command)}`);
    if (!result.ok) assert.match(result.error, /requires a non-empty command/);
  }
});

test("rejection: unknown reducer name", () => {
  const result = validateGraph({
    nodes: [subagent("a")],
    reducers: { findings: "append", score: "average" },
    initial: { findings: [], score: 0 },
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /unknown reducer "average"/);
});

test("rejection: initial not a plain object", () => {
  for (const initial of [null, [], "state", 3]) {
    const result = validateGraph({ nodes: [subagent("a")], reducers: {}, initial });
    assert.equal(result.ok, false, `expected rejection for initial ${JSON.stringify(initial)}`);
    if (!result.ok) assert.match(result.error, /initial must be a plain object/);
  }
});

test("rejection: reducer key missing from initial", () => {
  const result = validateGraph({
    nodes: [subagent("a")],
    reducers: { findings: "append", count: "sum" },
    initial: { findings: [] },
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /"count" has no initial value/);
});

test("initial may contain keys not declared in reducers (set-by-last-value keys)", () => {
  const result = validateGraph({
    nodes: [subagent("a")],
    reducers: { findings: "append" },
    initial: { findings: [], verdict: null },
  });
  assert.equal(result.ok, true);
});

test("needs may forward-reference nodes declared later", () => {
  const result = validateGraph({
    nodes: [subagent("b", ["a"]), subagent("a")],
    reducers: {},
    initial: {},
  });
  assert.equal(result.ok, true);
});

test("hash stability: same graph, different key insertion order", () => {
  const a = {
    nodes: [
      { id: "review_a", type: "subagent", needs: ["research"], prompt: "review", agent: "reviewer" },
      { id: "research", type: "shell", needs: [], command: "make research" },
    ],
    reducers: { findings: "append", verdict: "merge" },
    initial: { verdict: {}, findings: [] },
  };
  const b = {
    initial: { findings: [], verdict: {} },
    reducers: { verdict: "merge", findings: "append" },
    nodes: [
      { type: "subagent", prompt: "review", agent: "reviewer", needs: ["research"], id: "review_a" },
      { command: "make research", needs: [], type: "shell", id: "research" },
    ],
  };
  const ra = validateGraph(a);
  const rb = validateGraph(b);
  assert.equal(ra.ok && rb.ok, true);
  if (ra.ok && rb.ok) {
    assert.equal(hashGraph(ra.graph), hashGraph(rb.graph));
    assert.match(hashGraph(ra.graph), /^sha256:[0-9a-f]{64}$/);
  }
});

test("hash changes when the graph changes", () => {
  const base = validateGraph(validGraph());
  const other = validateGraph({ ...validGraph(), initial: { findings: [], count: 1 } });
  assert.equal(base.ok && other.ok, true);
  if (base.ok && other.ok) {
    assert.notEqual(hashGraph(base.graph), hashGraph(other.graph));
  }
});

test("canonicalJson sorts nested object keys", () => {
  assert.equal(
    canonicalJson({ b: { d: 2, c: { f: 3, e: 4 } }, a: 1 }),
    '{"a":1,"b":{"c":{"e":4,"f":3},"d":2}}',
  );
  assert.equal(canonicalJson([3, 1, 2]), "[3,1,2]");
  assert.equal(canonicalJson({}), "{}");
  assert.equal(canonicalJson("x"), '"x"');
  assert.equal(canonicalJson(undefined), "null");
  assert.equal(canonicalJson({ k: undefined }), "{}");
});
