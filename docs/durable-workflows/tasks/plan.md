# Implementation Plan: durable-workflows

Spec: `SPEC-durable-workflows.md` (approved pending final OK on this plan).
Task index below mirrors `tasks/todo.md` (the task list target).

## Overview

A Pi extension that adds durable workflow threads: an append-only step log per
thread plus a pure fold that answers state/ready/awaiting questions. The
extension records and folds; the agent (driver) executes nodes. Verified by a
crash-resume drill using fresh `pi -p` invocations.

## Architecture Decisions

- **Append-only event log, not snapshots** (research conclusion): state is a
  fold over entries; time travel is a prefix fold; fork is a prefix copy. No
  write-log + snapshot hybrid.
- **Pure core, thin shell**: `graph.ts`, `fold.ts`, `log.ts` (pure or fs-bounded
  modules) are independently unit-testable; `index.ts`/`tool.ts` are a thin
  dispatch layer. Everything below index.ts has no Pi imports — testable with
  plain `node:test`.
- **No execution authority in the extension**: correctness of the design rests
  on `wf_next` being a pure function of the log, so any fresh session can
  resume; execution stays with the driver (agent-shuttle, settled in review).
- **Graph-as-data with `graph_hash`**: resume/fork never depend on workflow
  code being present; hash guards against accidental graph divergence.
- **Cross-process lease, not intra-process locks**: the crash scenario is two
  `pi` processes, so the lease is a pid+timestamp file with dead-pid steal.
- **Slices are vertical**: each task ends with a runnable check (unit suite or
  smoke), building create→next→commit→crash→resume→interrupt→fork in the order
  the drill consumes them.

## Task List

### Phase 1: Foundation (pure logic, no Pi)
- [ ] T1: Scaffold package + `graph.ts` (validate, canonicalize, sha256 hash)
- [ ] T2: `log.ts` — entry validation, atomic append, truncated-tail read
- [ ] T3: `fold.ts` — full fold semantics (reducer merges, ready/blocked/failed/awaiting/orphans)
- [ ] T4: `store.ts` + `lease.ts` — paths, slug sanitize, storeRoot layering, cross-process lease

### Checkpoint: Foundation
- [ ] All four unit suites green (`npm test` inside the extension dir)
- [ ] Pure modules importable without any Pi types

### Phase 2: Tool surface (binds core to Pi)
- [ ] T5: `tool.ts` — action dispatch + per-action input validation
- [ ] T6: `index.ts` — `registerTool(wf)` with schema + renderCall/renderResult; smoke via `pi -e`

### Checkpoint: Tool surface
- [ ] `pi -e` smoke: create + next + step_start + commit round-trips in one session

### Phase 3: Drill (the acceptance bar)
- [ ] T7: `drill/drill.sh` — three `pi -p` invocations + assertions; README
- [ ] T8: Symlink install task (`ln -s` into `~/.pi/agent/extensions/`) + `.gitignore` entry

### Checkpoint: Complete
- [ ] Drill passes end-to-end (all 8 success criteria in the spec)
- [ ] No new npm deps; lockfile untouched; suites green

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Fold semantics drift from spec (ready/awaiting/orphan edge cases) | High | T3's suite enumerates every entry type × reducer; drill asserts behavior, not internals |
| Crash mid-append corrupts a line | Med | T2 tests truncated tail explicitly; fold stops at last complete line |
| Lease stolen while writer alive (clock skew) | Med | 60 s expiry + dead-pid check; drill never crosses processes concurrently |
| pi API mismatch (registerTool schema shape) | Med | T6 smoke runs against real `pi -e` early, not at the end; copy context-compress's Typebox-like pattern |
| State size creep (blobs smuggled into output) | Low | 64 KiB entry cap enforced at append; fold warns at 256 KiB |

## Open Questions

None blocking. Deferred items live in the spec's Out of scope / Open Questions.
