# Spec: durable-workflows (Pi extension)

Status: DRAFT — awaiting approval. Nothing is implemented yet.

## Objective

Give Pi what LangGraph gets from checkpointing, without embedding an orchestrator
inside an orchestrator: a durable, append-only **step log** per workflow thread,
plus a pure transition function that any fresh Pi session can fold to answer
"what is the state, what ran, what is ready, what is awaiting the user".

The primary user is the Pi agent itself (the driver). The driver executes nodes
(subagent runs or shell steps) and records facts in the log; the extension
decides transitions and never executes anything (the "agent shuttle" model from
the design review). The second user is the human, who answers interrupts and
consumes status.

User stories:

- As the agent, I can create a workflow thread with a graph (nodes, dependency
  edges, per-key reducers) and drive it step by step across sessions.
- As the agent, after a crash or a fresh `pi -p` invocation, I can discover
  threads, fold the log, and continue without re-running committed steps.
- As the agent, I can pause a workflow with a typed question and resume it much
  later from any session with a typed answer.
- As the agent, I can inspect the state at any past entry and fork a new thread
  from it without mutating the source thread.
- As the human, an interrupted workflow surfaces its question durably; nothing
  is lost across restarts or reboots.

## Background

The design was settled in a grilling session (2026-10-06) and is informed by
`docs/research/langgraph-checkpointing.md`. Settled decisions, binding:

1. **Agent-shuttle engine.** `wf_next` is a pure function of the log; the model
   ferries, code decides. The extension has no execution authority.
2. **Append-only write log, not snapshots.** Event-sourcing style; state is a
   fold. (Deliberate divergence from LangGraph's snapshot-per-superstep hybrid.)
3. **Graph as data.** The graph lives in a `thread_meta` log entry with a
   `graph_hash`; resume/fork do not depend on workflow code.
4. **Builtin reducers only**: `set`, `append`, `merge`, `sum`, `max`.
5. **Interrupts are durable re-invoke**: commit question → run ends → resume is
   a fresh invocation carrying the answer. No live pause.
6. **Time travel**: `inspect` is a read-only fold to an entry index; `fork`
   copies the prefix to a new thread; replay uses recorded outputs; `rerun`
   re-executes and marks results `rerun`.
7. **At-least-once commits** with orphan detection: `step_start` records the
   launch ref before execution; on resume the driver checks the orphan before
   re-running. Single-writer lease per thread.
8. **Node types**: subagent and shell, both recorded uniformly; v1 is exercised
   by a subagent workflow (research→review→fix) because the acceptance drill
   must not grind the GPU.
9. **Small typed state** (≤ 256 KiB per thread); big things are artifact paths.
10. **Storage**: `.pi/durable-workflows/<thread>/log.jsonl` under the project
    cwd by default; `storeRoot` override in settings. Never `/tmp`. Logs are
    gitignored runtime state.
11. **One `wf` tool**, action-dispatch, matching Pi house style.
12. **First real workflow**: research → parallel review → merge → approve
    (interrupt) → fix → verify.

## Tech Stack

- TypeScript, loaded by Pi via jiti (no build step), mirroring existing
  extensions (`.pi/extensions/ssh`, `.pi/extensions/context-compress`).
- Zero runtime npm dependencies. Node stdlib only (`fs`, `crypto`, `path`).
  Tool schema via a local Typebox-like object literal (same pattern as
  context-compress).
- Tests: `node:test` + `node:assert/strict`, run with
  `node --experimental-strip-types --test` (Node ≥ 22.6).
- Acceptance drill: bash + `pi -p` invocations (each is a fresh session = the
  crash surrogate).

## Log format (the contract)

One JSON object per line, appended atomically (single `appendFileSync` per
entry). Fields: `t` (entry type), `ts` (ISO 8601), plus type-specific fields.
Entry index = 0-based line number; it is the coordinate for `inspect`/`fork`.

```jsonc
// v1 entry types
{"t":"thread_meta","v":1,"thread_id":"fix-loop-1","title":"Fix the flaky test",
 "graph":{ /* see below */ },"graph_hash":"sha256:…","ts":"…"}

{"t":"step_start","node":"review_a","launch":{"kind":"subagent","ref":"<runId>"},"ts":"…"}
{"t":"step_result","node":"review_a","status":"ok|error","origin":"run|rerun",
 "output":{"findings":[{"sev":"high","note":"…"}]},"artifacts":["docs/x.md"],
 "summary":"reviewed parser path","ts":"…"}

{"t":"interrupt","question":"Apply the fix now?","options":["yes","no"],"ts":"…"}
{"t":"resume","answer":"yes","ts":"…"}
```

Graph object (inside `thread_meta`):

```jsonc
{"nodes":[{"id":"review_a","type":"subagent","needs":["research"],
           "prompt":"Review the diff for …","agent":null},
          {"id":"build","type":"shell","needs":[],"command":"npm test"}],
 "reducers":{"findings":"append","verdict":"merge","count":"sum"},
 "initial":{"findings":[],"verdict":{},"count":0}}
```

Rules:

- `node.needs` names other node ids; ready = all needs have an `ok`
  `step_result` and the node itself has no unconsumed `step_result`.
- Two `step_result`s for the same node: **last wins** in the fold. Re-issuing
  `step_start` for a done node is the rerun path; the commit records
  `origin:"rerun"`.
- A `step_result` with `status:"error"` does not satisfy dependents; the node
  returns to ready (retryable), and is surfaced in `failed`.
- An unresolved `interrupt` (no `resume` after it) makes the thread
  `awaiting`: `next` returns no ready set. `commit` stays allowed (in-flight
  nodes may finish while the user thinks).
- `step_start` without a later `step_result` = orphan: surfaced with its launch
  ref for the driver's orphan check; the node remains ready.
- Truncated/corrupt last line (crash mid-append): tolerated — fold stops at the
  last complete line and reports `truncated_tail:true`. A corrupt line in the
  middle is a hard error naming the index.
- `graph_hash` = sha256 of canonical JSON (sorted keys) of the graph object.
  **Hash over the normalized graph**: `validateGraph` drops unknown node
  fields, so hashes must always be computed over the graph as returned by
  `validateGraph(graph).graph` — a hash computed over the raw input (with
  extra fields) fails validation. `wf_create` does this automatically.
  `fork` copies `thread_meta` verbatim. A future "rebind to new graph" action
  (out of scope) would refuse on hash mismatch.

## Tool surface

One registered tool, `wf`, action-dispatch:

| Action | Input | Effect / output |
|---|---|---|
| `create` | `thread_id?`, `title?`, `graph` | Validate graph, hash it, write `thread_meta`; returns thread id, hash |
| `next` | `thread_id` | Fold → `{state, ready[], done[], blocked[], failed[], awaiting, orphans[], truncated_tail}` |
| `step_start` | `thread_id`, `node`, `launch` | Append `step_start` for a ready (or rerun-target) node; validates readiness |
| `commit` | `thread_id`, `node`, `output`, `status?`, `summary?`, `artifacts?`, `origin?` | Append `step_result`; requires a matching unconsumed `step_start` |
| `interrupt` | `thread_id`, `question`, `options?` | Append `interrupt`; returns the question for the driver to ask the user |
| `resume` | `thread_id`, `answer` | Append `resume`; clears awaiting |
| `status` | `thread_id?` | No id → list all threads (id, title, phase: `awaiting`\|`ready`\|`blocked`\|`done`\|`in-flight`\|`empty`, updated). With id → same fold as `next` |
| `inspect` | `thread_id`, `to` (entry index) | Read-only fold of entries `0..to` → state snapshot |
| `fork` | `thread_id`, `to?`, `new_thread_id?` | Copy prefix (default: whole log) to a new thread; source untouched |

All actions acquire the per-thread lease (below) for the duration of the call
only. All writes are single-line atomic appends. `thread_id` is sanitized
(`^[a-z0-9][a-z0-9-]{0,63}$`); ids are filesystem-safe slugs.

**Nested-object string shim**: the three nested-object inputs — `create.graph`,
`step_start.launch`, and `commit.output` — also accept a JSON-encoded string
form as a compatibility shim for model providers that stringify object
arguments before handing them to a tool (evidence: session log
`~/.pi/agent/sessions/--home-bagaswh-wf-demo--/2026-10-06T15-54-27-660Z_01a111ec-65cc-759c-bf5c-716e5473beb0.jsonl`,
where every `wf` call's nested objects arrived as JSON strings). The
`coerceObject` helper in `tool.ts` unwraps a string only when it parses to a
plain object; arrays, numbers, and invalid JSON pass through unchanged so the
normal validation errors are preserved.

## Concurrency & failure model

- **Single-writer lease**: `<thread>/.lease` holds `{pid, ts}`. Acquire with
  O_EXCL; steal if pid is dead or lease older than 60 s. Released at end of
  every tool call. Cross-process (two `pi` invocations), not intra-process.
- **At-least-once**: crash between node completion and `commit` → the node
  re-runs on resume. The drill asserts the orphan check makes the common case
  detectable, and the log makes any double execution visible.
- **State size**: entry append refused if the serialized entry exceeds
  64 KiB, and fold warns if folded state exceeds 256 KiB. Artifacts are paths.

## Commands

```bash
# Unit tests (pure logic; fast, no pi process)
cd .pi/extensions/durable-workflows && npm test

# Manual smoke in a scratch session
pi -e .pi/extensions/durable-workflows/index.ts

# Acceptance drill (the crash/resume scenario end-to-end)
bash drill/drill.sh
```

`npm test` script: `node --experimental-strip-types --test graph.test.ts
log.test.ts fold.test.ts lease.test.ts store.test.ts` (explicit file list,
matching the ssh extension convention).

## Project Structure

```
.pi/extensions/durable-workflows/   # the extension (committed source)
  index.ts        # registerTool(wf), renderCall/renderResult, thin dispatch
  graph.ts        # validate graph object, canonicalize, sha256 hash
  log.ts          # entry validation, atomic append, read w/ truncated-tail tolerance
  fold.ts         # PURE fold: entries[] → {state, ready, done, blocked, failed, awaiting, orphans}
  lease.ts        # cross-process single-writer lease
  store.ts        # storeRoot resolution (settings override), thread paths, slug sanitize
  tool.ts         # action dispatch + input validation (called from index.ts)
  package.json    # name pi-kit-durable-workflows, test script
  *.test.ts       # co-located node:test suites
drill/
  drill.sh        # acceptance drill: fresh pi -p invocations as crash surrogate
  README.md       # what the drill proves, how to read its output
tasks/            # plan.md + todo.md (this initiative)
docs/research/langgraph-checkpointing.md   # prior research this design draws on
```

Install for global availability (setup task): symlink
`~/.pi/agent/extensions/durable-workflows` → this repo's
`.pi/extensions/durable-workflows`. State stays project-scoped by cwd.

Settings: `durableWorkflows.storeRoot` (absolute path) in project
`.pi/settings.json` or global `~/.pi/agent/settings.json`, project wins.
Absent → `<cwd>/.pi/durable-workflows/`.

## Code Style

Follow the ssh extension exactly: file-header comment stating responsibility;
named exports; explicit types; no default exports except the extension factory
in `index.ts`; stdlib only; no classes where functions suffice.

```typescript
// fold.ts — the style anchor: pure, total, no fs
export type Fold = {
  state: Record<string, unknown>;
  ready: string[]; done: string[]; blocked: string[]; failed: string[];
  awaiting: boolean; orphans: Orphan[]; truncatedTail: boolean;
};

export function foldEntries(entries: LogEntry[], graph: Graph): Fold {
  const out: Fold = { state: structuredClone(graph.initial), /* … */ };
  for (const e of entries) applyEntry(out, e, graph); // one pass, in order
  return out;
}
```

## Testing Strategy

- **Unit** (`node:test`, co-located): `graph.test.ts` (validation + hash
  stability), `log.test.ts` (append atomicity via fs in temp dir, truncated
  tail, corrupt middle line, size cap), `fold.test.ts` (reducer semantics —
  including the parallel-merge case where two `review_*` nodes append to one
  key — ready/blocked/failed, awaiting gate, last-result-wins, rerun origin,
  orphans), `lease.test.ts` (acquire/steal on dead pid/expiry), `store.test.ts`
  (slug sanitize, storeRoot override layering).
- **Drill** (`drill/drill.sh`): the acceptance bar below, run against a real
  `pi -p`, three separate invocations. Bash asserts (no new test framework).
- Coverage expectation: `fold.ts` is the heart — its suite must cover every
  entry type and every reducer; other suites cover their module's contract.
  No coverage tooling in v1 (matches repo convention).

## Boundaries

- **Always**: append-only — never rewrite or delete existing log lines; release
  the lease on every exit path; validate entry size before append; sanitize
  thread ids against path traversal.
- **Ask first**: changing the log format (`v` bump or entry shape), adding a
  reducer, adding a new action, changing default store location.
- **Never**: execute nodes or schedule anything (no execution authority — the
  extension only records and folds); write outside `storeRoot`; commit logs
  (gitignore `.pi/durable-workflows/`); auto-delete threads; put secrets or
  large blobs in `output` (paths, not payloads); spawn background daemons.

## Success Criteria

The drill passes, end-to-end, from the log alone:

1. `pi -p` #1 creates a research→review→fix thread with parallel review
   branches and one real shell step (`sleep`+`echo`, no GPU); commits research
   + one review; dies mid-run.
2. `pi -p` #2 discovers the thread via `status`, folds: correct state, review_a
   done, review_b ready, orphan surfaced for the in-flight step.
3. Resume does NOT re-run committed nodes (asserted via recorded outputs in
   the fold, not by absence of calls).
4. Parallel review commits merge through the `append` reducer into one key.
5. Interrupt round-trips: `next` → awaiting → `pi -p` #3 `resume` with a typed
   answer → ready set returns.
6. `fork` at entry K: new thread has the exact prefix, source log byte-identical.
7. `inspect` at K returns the recorded state (no re-execution, no LLM calls).
8. All unit suites green; no npm dependencies added; `package-lock.json` untouched.

## Out of scope (v1)

- Executing or auto-scheduling nodes (agent shuttle only).
- Custom JS reducers; sub-thread namespaces (LangGraph `checkpoint_ns` analog);
  thread deletion; TTL/pruning; footer status widget; template rendering of
  node prompts; multi-machine sync; streaming fold for huge logs.

## Open Questions

None blocking. Deferred, with default answers: template rendering of
`{{state.key}}` in node prompts (no — driver composes, revisit when a real
workflow asks); footer widget for awaiting threads (no — tool-only discovery
was settled, add if forgotten interrupts happen in practice).
