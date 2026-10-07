# drill — the durable-workflows acceptance drill

`drill.sh` executes the eight success criteria of
[`SPEC-durable-workflows.md`](../SPEC-durable-workflows.md) ("Success Criteria")
end-to-end against the real extension, using **three separate headless
`pi -ne -e <ext> -p "<prompt>"` invocations**. Each invocation is a fresh pi
process with a fresh session — that is the **crash surrogate**: session 2 and 3
can only recover state from the on-disk log under
`<scratch>/.pi/durable-workflows/`, never from chat context.

## Run

```bash
bash drill/drill.sh        # from the repo root
```

Three pi sessions, a few minutes, costs tokens (model: DeepSeek-V4.1-Flash via
bitdeer by default). The drill creates a temp scratch dir (`/tmp/wf-drill.*`),
runs pi **from inside it** (so the extension's cwd-based storage lands there),
and removes it on exit.

## What each PASS proves (spec criterion mapping)

The drill prints `PASS <n>: <desc>` / `FAIL <n>: <desc>` where `<n>` is the
spec success-criterion number:

| # | Proven by |
|---|-----------|
| 1 | **Session 1**: one fresh pi session creates the `drill-thread` graph (research → parallel `review_a`/`review_b` → approve → shell `fix` → verify, reducers `findings:append` + `verdict:merge`), commits `research` + `review_a`, issues `step_start` for `review_b`, then stops — "dies mid-run". |
| 2 | **Session 2** (fresh process, no context): `wf status` lists `drill-thread` with phase `in-flight` (the `review_b` orphan); `wf next` shows `findings == ["core bug found","review-a finding"]`, `ready == []` (`review_b` in flight as an orphan carrying ref `s3-b`), `done == [research, review_a]`, approve/fix/verify blocked, not awaiting. |
| 3 | Same session-2 fold: the recorded outputs of the committed nodes are in the state, and session 2 is read-only — nothing re-runs, nothing re-commits (`review_b_done == false`, `ready == []` because the orphan is in flight, not ready). |
| 4 | **Session 3**: committing `review_b` (`{"findings":["review-b finding"],"verdict":{"b":"patch"}}`) merges through the reducers — `findings` holds all three values in log order (append), `verdict` is `{"a":"patch","b":"patch"}` (merge across the parallel reviews), and `ready == [approve]`. |
| 5 | **Session 3**: `interrupt` → `next` shows `awaiting: true`, ready gated empty → `resume answer="yes"` → ready returns `[approve]`; then approve is started/committed and `ready == [fix]`. |
| 6 | After session 3, the drill forks `drill-thread` at entry 4 via a direct in-process `dispatch` call: exactly the 5-entry prefix is copied, the source `log.jsonl` is **byte-identical** (sha256 before/after), the fork's first 5 lines equal the source's (with only the meta `thread_id` rewritten), and `resume` on the fork is **refused** (`ok:false` — it has no pending interrupt at that point). |
| 7 | **Session 3**: `wf inspect to=4` folds entries 0..4 read-only and returns the recorded state at that point — `findings == ["core bug found"]`, `verdict == {}` — with no re-execution and no LLM calls. |
| 8 | `npm test` in the extension dir (all suites, currently 137 tests); extension `package.json` declares zero dependencies; no `node_modules`/`package-lock.json` in the extension dir; the repo `package-lock.json` sha256 is unchanged across the drill. |

A final `ALL PASS` (exit 0) means all eight criteria held.

## How to read failures

- Each `FAIL <n>: ...` names the criterion number and the exact
  filter/expected/actual triple that missed. Criteria 1–5 and 7 assert against
  the `DRILL-RESULT: {...}` line the pi session is instructed to print; a
  missing marker means the model never got through the steps (see retries
  below).
- Each pi session is retried up to 2 extra times on non-zero exit or a missing
  `DRILL-RESULT` marker (transient network/402/model errors). If all retries
  fail, that criterion is FAILed and the drill continues.
- Session failures are usually drill-prompt problems (model misformatting the
  final line); fold/state mismatches are more likely real extension bugs.
  Cross-check against the actual log before filing: the extension asserts
  nothing that the raw `log.jsonl` doesn't show.

## Debugging with the real log

```bash
DRILL_PRESERVE=1 bash drill/drill.sh          # keep the scratch dir
# → "DRILL: scratch preserved at /tmp/wf-drill.XXXXXX"
cat /tmp/wf-drill.XXXXXX/.pi/durable-workflows/drill-thread/log.jsonl
```

Each line is one JSON log entry (`thread_meta`, `step_start`, `step_result`,
`interrupt`, `resume`) — the ground truth the fold is computed from.

## Env knobs

| Variable | Default | Meaning |
|---|---|---|
| `DRILL_MODEL` | `omniroute/bitdeer/deepseek-ai/DeepSeek-V4.1-Flash` | Model for every pi invocation. |
| `DRILL_TIMEOUT` | `240` | Per-pi-invocation timeout, seconds. |
| `DRILL_PRESERVE` | unset | `=1` keeps the scratch dir (log.jsonl, session state) for post-mortem; otherwise removed on exit. |

## Design notes

- **Three real pi sessions are mandatory** — they are what makes the drill an
  acceptance test of *durable* resume (log alone, fresh process, fresh session).
- A small node helper (`node --experimental-strip-types --input-type=module`)
  imports `dispatch` from `tool.ts` directly for the criterion-6 assertions
  that a prompt round-trip cannot express cleanly: sha256 byte-identity of the
  source log across the fork, prefix line equality, and the
  `resume`-without-interrupt refusal. The helper only reads/appends against
  the same scratch store; it never replaces a pi session.
- Only bash + node stdlib + `jq` (present on this box) are used.
