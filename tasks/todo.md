# durable-workflows — Task List

Spec: `../SPEC-durable-workflows.md` · Plan: `plan.md`

## Phase 1: Foundation

- [ ] Task 1: Scaffold package + `graph.ts` (graph validation, canonicalization, sha256 hash)
  - Acceptance: `package.json` (pi-kit-durable-workflows, test script) + `graph.ts` exports `validateGraph(input): Result<Graph>`, `canonicalJson(graph): string`, `hashGraph(graph): string` (sha256 of canonical JSON, sorted keys); rejects: unknown reducer names, node ids not matching `^[a-z0-9][a-z0-9_-]{0,63}$`, `needs` referencing unknown nodes, `needs` cycles, duplicate node ids, missing/empty `initial` for keys named in `reducers`, non-object `graph`.
  - Verify: `npm test` (graph.test.ts) green inside `.pi/extensions/durable-workflows/`.
  - Files: `.pi/extensions/durable-workflows/{package.json,graph.ts,graph.test.ts}`
  - Dependencies: None. Estimated scope: S.

- [ ] Task 2: `log.ts` — entry validation, atomic append, crash-tolerant read
  - Acceptance: exports `LogEntry` type, `validateEntry(obj): Result<LogEntry>` (per-spec entry shapes incl. `thread_meta` graph+hash), `appendEntry(dir, entry)` (single-appendFile, mkdir -p, refuses serialized entries > 64 KiB, all-or-nothing), `readLog(dir): {entries, truncatedTail}` (stops at last complete line; a corrupt non-final line is a hard error naming its index), `entryIndex` = line number contract.
  - Verify: `npm test` (log.test.ts): appends visible to a fresh read; killed-mid-write tail tolerated (fixture: file ending in half a JSON line); corrupt middle line errors with index; size cap refuses.
  - Files: `.pi/extensions/durable-workflows/{log.ts,log.test.ts}`
  - Dependencies: Task 1 (uses `Graph` type). Estimated scope: S.

- [ ] Task 3: `fold.ts` — pure fold over entries
  - Acceptance: `foldEntries(entries, graph): Fold` — one pass, in order: reducer application (`set`,`append`,`merge`,`sum`,`max`; parallel `step_result`s from different nodes merging into one key via the declared reducer), `ready` (all `needs` ok'd, no unconsumed own result; error-results unsatisfy → node back to ready and listed in `failed`), `done`, `blocked` (with missing need names), `awaiting` gate (unresolved `interrupt` → `next` ready set empty, `commit` unaffected), `orphans` (`step_start` without result, carrying launch ref), `truncatedTail` passthrough, last-result-wins, `origin:"rerun"` recorded on the fold's done view. No fs, no Pi imports.
  - Verify: `npm test` (fold.test.ts): a table of scenario fixtures covering every entry type × every reducer + the parallel-merge, awaiting, orphan, error-retry, rerun cases.
  - Files: `.pi/extensions/durable-workflows/{fold.ts,fold.test.ts}`
  - Dependencies: Task 1 (Graph), Task 2 (LogEntry). Estimated scope: M.

- [ ] Task 4: `store.ts` + `lease.ts` — paths, slugs, storeRoot layering, cross-process lease
  - Acceptance: `store.ts`: `resolveThreadDir(storeRoot, cwd, threadId)` → `<storeRoot ?? cwd/.pi>/durable-workflows/<thread>/`, `sanitizeThreadId` (enforce `^[a-z0-9][a-z0-9-]{0,63}$`, refuse `.`/`..`), `listThreads`. `lease.ts`: `withLease(dir, fn)` — O_EXCL acquire of `.lease` `{pid,ts}`, steal when pid dead or lease > 60 s, always-release on all exit paths (incl. thrown), re-entrant within one pid.
  - Verify: `npm test` (store.test.ts, lease.test.ts): slug refusals; temp storeRoot respected; lease: second acquire while held fails, dead-pid lease stealable, lease released after throw.
  - Files: `.pi/extensions/durable-workflows/{store.ts,store.test.ts,lease.ts,lease.test.ts}`
  - Dependencies: None (parallel-safe with T2/T3; merges last into `npm test` list). Estimated scope: S.

## Checkpoint: Foundation
- [ ] All unit suites green via one `npm test`
- [ ] No module below `tool.ts` imports anything from Pi
- [ ] Review with human before Phase 2

## Phase 2: Tool surface

- [ ] Task 5: `tool.ts` — `wf` action dispatch + input validation
  - Acceptance: `dispatch(action, input, ctx)` implements all nine actions from the spec table with per-action validation (thread existence, node-in-graph, readiness checks for `step_start`, unconsumed-`step_start` requirement for `commit`, `answer` required by `resume`, `to` bounds for `inspect`, prefix-copy + new-id rules for `fork`); returns structured results incl. the `next` fold; every action acquires the lease via `withLease`; no rendering/UI concerns.
  - Verify: `npm test` (tool.test.ts) with mocked fs-in-temp-dir: full happy path create→next→step_start→commit→next; refusal cases (unknown thread, commit without start, resume without interrupt).
  - Files: `.pi/extensions/durable-workflows/{tool.ts,tool.test.ts}`
  - Dependencies: Tasks 1–4. Estimated scope: M.

- [ ] Task 6: `index.ts` — register the `wf` tool + smoke test
  - Acceptance: default-export extension factory registering tool `wf` with a typebox-like schema (one `action` enum + per-action optional fields, matching the spec table); `renderCall`/`renderResult` one-liners (action + thread, status lines); loads `durableWorkflows.storeRoot` from settings (project wins over global); smoke run in a real `pi -e` session performs create + next + step_start + commit and prints the fold.
  - Verify: manual `pi -e .pi/extensions/durable-workflows/index.ts` smoke (scripted keystrokes or `-p` prompt); unit tests still green.
  - Files: `.pi/extensions/durable-workflows/index.ts`
  - Dependencies: Task 5. Estimated scope: S.

## Checkpoint: Tool surface
- [ ] `pi -e` smoke round-trips the four core actions
- [ ] Review with human before Phase 3

## Phase 3: Drill + install

- [ ] Task 7: `drill/drill.sh` + `drill/README.md` — the acceptance bar
  - Acceptance: the eight success criteria from the spec, executed as three separate `pi -p` invocations (fresh session = crash surrogate): (1) create thread w/ parallel reviews + one shell step, commit research + review_a, die; (2) `status` discovers, fold shows review_a done / review_b ready / orphan; no re-run of committed nodes; parallel commits merge via `append`; (3) `resume` with typed answer after interrupt; then `fork` prefix copy with source byte-identical (`sha256sum`), `inspect` at K returns recorded state. Bash assertions with clear PASS/FAIL output; README explains what the drill proves and how to read failures. Runs against the *installed* extension (Task 8), so this task lands the script and can run with `pi -e` before install.
  - Verify: `bash drill/drill.sh` exits 0 with all assertions PASS; drill leaves no state outside a temp cwd.
  - Files: `drill/drill.sh`, `drill/README.md`
  - Dependencies: Task 6 (needs a working tool). Estimated scope: M.

- [x] Task 8: Install (per-file symlinks in a real dir — dir-symlinks are skipped by pi discovery) + gitignore entry
  - Acceptance: `ln -s <repo>/.pi/extensions/durable-workflows ~/.pi/agent/extensions/durable-workflows` (idempotent re-run), `.gitignore` gains `.pi/durable-workflows/`, drill re-run passes against the installed extension via plain `pi -p`.
  - Verify: `pi -p 'call wf status …'` from a scratch dir sees the tool; drill green.
  - Files: `~/.pi/agent/extensions/durable-workflows/` (real dir, per-file symlinks), `.gitignore`
  - Dependencies: Task 7. Estimated scope: XS.

## Checkpoint: Complete
- [ ] Drill passes end-to-end (all 8 spec success criteria)
- [ ] No new npm deps; `package-lock.json` untouched
- [ ] Review with human: initiative done
