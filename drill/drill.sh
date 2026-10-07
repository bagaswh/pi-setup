#!/usr/bin/env bash
# drill/drill.sh — the acceptance drill for the durable-workflows extension.
#
# Runs the SPEC-durable-workflows.md "Success Criteria" (all eight) end-to-end
# against the real extension via THREE separate headless `pi -ne -e` sessions.
# Each session is a FRESH pi process with a FRESH session — the crash surrogate:
# resume must work from the on-disk log alone, never from chat context.
#
# Storage is scoped to a mktemp scratch dir (the extension resolves cwd via the
# pi process's cwd, so running pi FROM the scratch dir puts state in
# <scratch>/.pi/durable-workflows/). The scratch dir is removed on exit unless
# DRILL_PRESERVE=1.
#
# Env knobs:
#   DRILL_MODEL      model for all pi calls (default: omniroute/bitdeer/deepseek-ai/DeepSeek-V4.1-Flash)
#   DRILL_TIMEOUT    per pi invocation timeout in seconds (default: 240)
#   DRILL_PRESERVE   =1 keeps the scratch dir for post-mortem (log.jsonl etc.)
#
# Only the drill asserts the extension; it never modifies it. Failures print
# FAIL <n>: <desc>; the script exits 1 if any criterion failed.
set -euo pipefail

cd "$(dirname "$0")/.."
REPO_ROOT=$(pwd)
EXT="$REPO_ROOT/.pi/extensions/durable-workflows/index.ts"
MODEL="${DRILL_MODEL:-omniroute/bitdeer/deepseek-ai/DeepSeek-V4.1-Flash}"
TIMEOUT="${DRILL_TIMEOUT:-240}"

SCRATCH=$(mktemp -d /tmp/wf-drill.XXXXXX)
cleanup() {
  if [[ "${DRILL_PRESERVE:-0}" == "1" ]]; then
    echo "DRILL: scratch preserved at $SCRATCH"
  else
    rm -rf "$SCRATCH"
  fi
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

PASS_N=0
FAIL_N=0
declare -a FAILED_CRITERIA=()

pass() { echo "PASS $1: $2"; PASS_N=$((PASS_N + 1)); }
fail() {
  echo "FAIL $1: $2" >&2
  FAIL_N=$((FAIL_N + 1))
  FAILED_CRITERIA+=("$1")
}

# Run one headless pi session in the scratch dir. The prompt's final line
# MUST be "DRILL-RESULT: <compact json>" for bash grep-asserts.
# $1 = criterion number (for retry messages), $2 = prompt (from a var).
# On success, LAST_LINE holds the DRILL-RESULT line.
LAST_LINE=""
run_pi() {
  local cn="$1"
  local prompt="$2"
  local attempt out exit_code
  for attempt in 1 2 3; do # initial try + 2 retries
    out=$(cd "$SCRATCH" && timeout "$TIMEOUT" \
      pi -ne -e "$EXT" --model "$MODEL" --no-session -p "$prompt" 2>&1)
    exit_code=$?
    LAST_LINE=$(printf '%s\n' "$out" | grep '^DRILL-RESULT:' | tail -1 || true)
    if [[ $exit_code -eq 0 && -n "$LAST_LINE" ]]; then
      return 0
    fi
    echo "drill: pi session (criterion $cn) attempt $attempt failed (exit=$exit_code, marker=$([[ -n "$LAST_LINE" ]] && echo yes || echo no)); retrying..." >&2
  done
  return 1
}

# Extract a dotted-ish path from the DRILL-RESULT JSON via jq.
# jget <json> <filter>  → raw jq output
jget() { printf '%s' "$1" | jq -r "$2"; }

# Check a DRILL-RESULT marker line is parseable JSON.
# cnum, desc, then jq filter + expected value pairs come as args after the json:
# assert_j <marker> <desc> <filter> <expected> [<filter> <expected>...]
assert_j() {
  local marker="$1" desc="$2"; shift 2
  local i=0
  while [[ $# -ge 2 ]]; do
    local filter="$1" expected="$2"
    shift 2
    local actual
    if ! actual=$(printf '%s' "$marker" | sed 's/^DRILL-RESULT: //' | jq -r "$filter" 2>/dev/null); then
      fail "$desc" "jq could not parse DRILL-RESULT for filter $filter"
      continue
    fi
    i=$((i + 1))
    if [[ "$actual" == "$expected" ]]; then
      pass "$desc" "assert $i: $filter == $expected"
    else
      fail "$desc" "assert $i: $filter expected [$expected] got [$actual]"
    fi
  done
}

sha_of() { sha256sum "$1" | cut -d' ' -f1; }

# ---------------------------------------------------------------------------
# Node helper: in-process dispatch assertions (extension imported directly,
# no pi). The three crash-surrogate sessions above are real pi; this helper
# only adds assertions a prompt round-trip cannot express (byte identity,
# refusal semantics). Runs inside the scratch store via cwd.
# ---------------------------------------------------------------------------
NODE_HELPER_IMPORT="$REPO_ROOT/.pi/extensions/durable-workflows/tool.ts"

helper() { # helper <action> <json-input> → stdout: raw dispatch result JSON
  # The JS is a template with a REPO placeholder (never shell-interpolated):
  # shell expansion of the JS string would double-expansion-corrupt the
  # ${2:-{}} default (bash re-expands "{}" to "{}"+"}" in this context).
  #
  # The action/input are passed via WF_ACTION/WF_INPUT environment variables
  # (see helper()): a positional argv "inspect" collides with Node's built-in
  # `node inspect` debug subcommand — which spawns a paused --inspect-brk child
  # that waits for a debugger forever and hangs the drill. Env vars sidestep
  # Node's argv subcommand parsing entirely.
  local js='import { dispatch } from "REPO/.pi/extensions/durable-workflows/tool.ts";
const ctx = { storeRoot: null, cwd: process.cwd() };
const r = await dispatch(process.env.WF_ACTION ?? "", JSON.parse(process.env.WF_INPUT ?? "{}"), ctx);
process.stdout.write(JSON.stringify(r));'
  # NOTE: action/input travel via env (WF_ACTION/WF_INPUT), NOT argv: Node's
  # built-in `node inspect <script>` debug subcommand swallows the literal
  # positional "inspect" EVEN AFTER `--` (verified: only the word "inspect"
  # collides; status/fork/etc. pass through). Env is immune to argv parsing.
  ( cd "$SCRATCH" && WF_ACTION="$1" WF_INPUT="${2:-\{\}}" node --experimental-strip-types --input-type=module \
      -e "${js/REPO/$REPO_ROOT}" 2>/dev/null )
}

LOG() { echo "$SCRATCH/.pi/durable-workflows/$1/log.jsonl"; }

# ---------------------------------------------------------------------------
# Session 1 (criterion 1): create + partial progress + die mid-run.
# One fresh pi process creates the research→review→fix thread with parallel
# review branches + one real shell step, commits research and review_a, starts
# review_b (step_start only), then DIES without committing review_b.
# ---------------------------------------------------------------------------
P1='You have a "wf" tool. Follow these steps EXACTLY, in order, using ONLY the wf tool (do NOT execute any node yourself — do not research, review, or run anything; the node "executions" are faked here). After each wf call, print the tool result JSON on one line. Do these wf calls:

1. wf action=create thread_id="drill-thread" title="Drill thread" graph={"nodes":[{"id":"research","type":"subagent","needs":[],"prompt":"research the repo"},{"id":"review_a","type":"subagent","needs":["research"],"prompt":"review a"},{"id":"review_b","type":"subagent","needs":["research"],"prompt":"review b"},{"id":"approve","type":"subagent","needs":["review_a","review_b"],"prompt":"approve"},{"id":"fix","type":"shell","needs":["approve"],"command":"echo drill-fix"},{"id":"verify","type":"subagent","needs":["fix"],"prompt":"verify"}],"reducers":{"findings":"append","verdict":"merge"},"initial":{"findings":[],"verdict":{}}}
2. wf action=next thread_id="drill-thread"   (expect ready to be exactly ["research"])
3. wf action=step_start thread_id="drill-thread" node="research" launch={"kind":"subagent","ref":"s1-research"}
4. wf action=commit thread_id="drill-thread" node="research" output={"findings":["core bug found"]} status="ok"
5. wf action=step_start thread_id="drill-thread" node="review_a" launch={"kind":"subagent","ref":"s2-a"}
6. wf action=commit thread_id="drill-thread" node="review_a" output={"findings":["review-a finding"],"verdict":{"a":"patch"}} status="ok"
7. wf action=step_start thread_id="drill-thread" node="review_b" launch={"kind":"subagent","ref":"s3-b"}
8. Then STOP IMMEDIATELY. Do NOT commit review_b. Do NOT do anything else.

The absence of review_b'"'"'s commit simulates a crash mid-run. Print each tool result. At the very end output exactly one final line, nothing after it (SCALARS only — never embed a whole result object; join array items with commas, empty string if empty):
DRILL-RESULT: {"created":<true if step 1 result had ok:true>,"research_committed":<true if step 4 result ok:true>,"review_a_committed":<true if step 6 ok:true>,"review_b_started":<true if step 7 ok:true>,"step2_ready":"<comma-joined ready array from the step 2 result>","step2_done":"<comma-joined done array from the step 2 result>"}'
echo "== SESSION 1: create + partial progress + die =="
if run_pi 1 "$P1"; then
  assert_j "$LAST_LINE" "1" \
    '.created' "true" \
    '.research_committed' "true" \
    '.review_a_committed' "true" \
    '.review_b_started' "true" \
    '.step2_ready' "research" \
    '.step2_done' ""
else
  fail 1 "session 1 (create + partial progress + die) failed after retries"
fi

# ---------------------------------------------------------------------------
# Session 2 (criteria 2, 3, 4): fresh session = post-crash. Discovers the
# thread via status, folds: committed state present, orphan surfaced, nothing
# re-run, parallel findings merged through the append reducer.
# ---------------------------------------------------------------------------
P2='A previous session (now dead) was driving a durable workflow with the "wf" tool. You are a FRESH session: recover state from the wf tool alone. Use ONLY the wf tool. Do NOT re-run, re-start, re-commit, or create anything — read-only session.

1. wf action=status   (list all threads; no thread_id)
2. wf action=next thread_id="drill-thread"

Print both tool results. At the very end output exactly one final line, nothing after it:
DRILL-RESULT: {"listed":<true if the status listing includes thread_id "drill-thread">,"findings":<the exact array next.state.findings>,"verdict":<the exact object next.state.verdict>,"ready":<next.ready array>,"done":<next.done array>,"blocked":<next.blocked array>,"orphan_nodes":<array of next.orphans[].node>,"orphan_refs":<array of next.orphans[].launch.ref>,"awaiting":<next.awaiting>,"approve_blocked":<true if "approve" is in next.blocked>,"fix_blocked":<true if "fix" is in next.blocked>,"verify_blocked":<true if "verify" is in next.blocked>,"review_b_done":<true if "review_b" is in next.done>}'
echo "== SESSION 2: fresh session discovers + folds =="
if run_pi 2 "$P2"; then
  assert_j "$LAST_LINE" "2" \
    '.listed' "true" \
    '.findings[0]' "core bug found" \
    '.findings[1]' "review-a finding" \
    '.findings | length' "2" \
    '.verdict.a' "patch" \
    '.ready | length' "0" \
    '.done | sort | join(",")' "research,review_a" \
    '.orphan_nodes | join(",")' "review_b" \
    '.orphan_refs | join(",")' "s3-b" \
    '.awaiting' "false" \
    '.approve_blocked' "true" \
    '.fix_blocked' "true" \
    '.verify_blocked' "true" \
    '.review_b_done' "false"
else
  fail 2 "session 2 (status discovers thread, fold correct, orphan surfaced) failed after retries"
fi

# Capture the source log hash BEFORE session 3's fork (criterion 6 baseline)
# and compute the inspect/fork entry index K from the actual log: K = the
# index of the entry right after research's step_result. Folding 0..K then
# yields exactly "initial + research output" (findings ["core bug found"],
# verdict {}) regardless of any extra step_start entries the model emitted.
SRC_LOG=$(LOG drill-thread)
[[ -f "$SRC_LOG" ]] || { fail 6 "source log.jsonl missing at $SRC_LOG (cannot check byte-identity)"; }
INSPECT_TO=$(jq -s 'to_entries
  | map(select(.value.t == "step_result" and .value.node == "research"))
  | .[0].key + 1' "$SRC_LOG" 2>/dev/null || true)
if [[ ! "$INSPECT_TO" =~ ^[0-9]+$ ]]; then
  echo "drill: could not compute inspect index from $SRC_LOG; defaulting to 2" >&2
  INSPECT_TO=2
fi
FORK_COPIED_EXPECT=$((INSPECT_TO + 1))

# ---------------------------------------------------------------------------
# Session 3 (criteria 4 remainder, 5, 7 + fork setup): resume the orphan,
# finish the merge, interrupt round-trip, approve+commit, inspect at K.
# ---------------------------------------------------------------------------
P3='You are continuing a durable workflow ("wf" tool) that a previous dead session left mid-run. Recover from the log alone. Use ONLY the wf tool for the workflow steps (do NOT actually execute any node; outputs are faked here). Do these wf calls in order, printing each tool result:

1. wf action=step_start thread_id="drill-thread" node="review_b" launch={"kind":"subagent","ref":"s3-b"}   (re-issued start for the orphaned in-flight node — this is allowed and supersedes)
2. wf action=commit thread_id="drill-thread" node="review_b" output={"findings":["review-b finding"],"verdict":{"b":"patch"}} status="ok"
3. wf action=next thread_id="drill-thread"   (expect ready exactly ["approve"], findings all three, verdict merged)
4. wf action=interrupt thread_id="drill-thread" question="Apply the fix now?" options=["yes","no"]
5. wf action=next thread_id="drill-thread"   (expect awaiting true, ready empty)
6. wf action=resume thread_id="drill-thread" answer="yes"
7. wf action=next thread_id="drill-thread"   (expect ready exactly ["approve"] again)
8. wf action=step_start thread_id="drill-thread" node="approve" launch={"kind":"subagent","ref":"s4"}
9. wf action=commit thread_id="drill-thread" node="approve" output={"verdict":{"approved":"yes"}} status="ok"
10. wf action=next thread_id="drill-thread"   (expect ready exactly ["fix"])
11. wf action=inspect thread_id="drill-thread" to=$INSPECT_TO   (pass to EXACTLY the integer $INSPECT_TO — read-only fold of entries 0..$INSPECT_TO, up to and including the step_result of node research, which must show ONLY the research output)

At the very end output exactly one final line, nothing after it:
DRILL-RESULT: {"restart_ok":<step 1 ok:true>,"review_b_committed":<step 2 ok:true>,"after_resume_commit_findings":<step 3 next.state.findings>,"after_resume_commit_verdict":<step 3 next.state.verdict>,"ready_after_merge":<step 3 next.ready>,"interrupted":<step 4 ok:true>,"awaiting_after_interrupt":<step 5 next.awaiting>,"ready_during_interrupt":<step 5 next.ready>,"resumed":<step 6 ok:true>,"resume_ready":<step 6 result.ready>,"ready_after_gate_lift":<step 7 next.ready>,"approve_committed":<step 9 ok:true>,"ready_after_approve":<step 10 next.ready>,"inspect_findings":<step 11 result.state.findings>,"inspect_verdict":<step 11 result.state.verdict>,"inspect_up_to":<step 11 result.up_to>}'
echo "== SESSION 3: resume orphan + interrupt round-trip + approve + inspect =="
if run_pi 3 "$P3"; then
  # Criterion 4 remainder: parallel review commits merge via append + merge.
  assert_j "$LAST_LINE" "4" \
    '.review_b_committed' "true" \
    '.after_resume_commit_findings | join(",")' "core bug found,review-a finding,review-b finding" \
    '.after_resume_commit_findings | length' "3" \
    '.after_resume_commit_verdict | keys | sort | join(",")' "a,b" \
    '.after_resume_commit_verdict.a' "patch" \
    '.after_resume_commit_verdict.b' "patch" \
    '.ready_after_merge | join(",")' "approve"
  # Criterion 5: interrupt round-trip.
  assert_j "$LAST_LINE" "5" \
    '.interrupted' "true" \
    '.awaiting_after_interrupt' "true" \
    '.ready_during_interrupt | length' "0" \
    '.resumed' "true" \
    '.resume_ready | join(",")' "approve" \
    '.ready_after_gate_lift | join(",")' "approve" \
    '.approve_committed' "true" \
    '.ready_after_approve | join(",")' "fix"
  # Criterion 7: inspect at K returns the recorded state (no re-execution).
  assert_j "$LAST_LINE" "7" \
    '.inspect_findings | join(",")' "core bug found" \
    '.inspect_findings | length' "1" \
    '.inspect_verdict' "{}"
else
  fail 3 "session 3 (resume + interrupt round-trip + inspect) failed after retries"
fi

# ---------------------------------------------------------------------------
# Criterion 6: fork. The pi session 3 prompt already ended at inspect; fork
# runs via the node helper (still a real dispatch against the same store) so
# we can hash the source log before/after without another LLM round-trip.
# Then: prefix byte-copy, source byte-identity, and resume-without-interrupt
# refusal on the fork (it has no pending interrupt).
# ---------------------------------------------------------------------------
echo "== NODE HELPER: criterion 7 inspect at K (precise, no LLM) =="
INSPECT_JSON=$(helper inspect "{\"thread_id\":\"drill-thread\",\"to\":$INSPECT_TO}" || true)
if [[ -n "$INSPECT_JSON" ]] && printf '%s' "$INSPECT_JSON" | jq -e '.ok == true' >/dev/null 2>&1; then
  I_UP_TO=$(jget "$INSPECT_JSON" '.result.up_to')
  I_FINDINGS=$(jget "$INSPECT_JSON" '.result.state.findings | join(",")')
  I_VERDICT=$(jget "$INSPECT_JSON" '.result.state.verdict | tostring')
  if [[ "$I_UP_TO" == "$INSPECT_TO" ]]; then
    pass 7 "inspect to=$INSPECT_TO echoes up_to=$I_UP_TO (read-only fold of entries 0..$INSPECT_TO)"
  else
    fail 7 "inspect up_to=$I_UP_TO, expected $INSPECT_TO"
  fi
  if [[ "$I_FINDINGS" == "core bug found" && "$I_VERDICT" == "{}" ]]; then
    pass 7 "inspect at K returns the recorded state (findings=[core bug found], verdict={}) — no re-execution, no LLM calls"
  else
    fail 7 "inspect state at K: findings=[$I_FINDINGS] verdict=$I_VERDICT"
  fi
else
  fail 7 "inspect via helper failed: $INSPECT_JSON"
fi

echo "== NODE HELPER: fork + byte identity + refusal semantics =="
# Baseline hash NOW (after session 3 — its appends are legitimate; the
# byte-identity contract is about the fork call itself not mutating source).
SRC_HASH_BEFORE=$(sha_of "$SRC_LOG" 2>/dev/null || echo "")
FORK_JSON=$(helper fork "{\"thread_id\":\"drill-thread\",\"to\":$INSPECT_TO}" || true)
if [[ -n "$FORK_JSON" ]] && printf '%s' "$FORK_JSON" | jq -e '.ok == true' >/dev/null 2>&1; then
  pass 6 "fork at entry $INSPECT_TO returned ok"
  FORK_ID=$(jget "$FORK_JSON" '.result.thread_id')
  FORK_COPIED=$(jget "$FORK_JSON" '.result.copied')
  if [[ "$FORK_COPIED" == "$FORK_COPIED_EXPECT" ]]; then
    pass 6 "fork copied exactly the $FORK_COPIED_EXPECT-entry prefix (meta .. research commit)"
  else
    fail 6 "fork copied $FORK_COPIED entries, expected $FORK_COPIED_EXPECT"
  fi
  if [[ -n "${SRC_HASH_BEFORE:-}" ]]; then
    SRC_HASH_AFTER=$(sha_of "$SRC_LOG")
    if [[ "$SRC_HASH_BEFORE" == "$SRC_HASH_AFTER" ]]; then
      pass 6 "source log byte-identical after fork (sha256 $SRC_HASH_BEFORE)"
    else
      fail 6 "source log CHANGED during fork: $SRC_HASH_BEFORE -> $SRC_HASH_AFTER"
    fi
    # The fork's own log must exist and its content lines must equal the
    # source's first 5 lines (modulo the rewritten thread_id in the meta).
    FORK_LOG=$(LOG "$FORK_ID")
    if [[ -f "$FORK_LOG" ]]; then
      SRC_PREFIX=$(head -$FORK_COPIED_EXPECT "$SRC_LOG" | sed "1s/\"thread_id\":\"drill-thread\"/\"thread_id\":\"$FORK_ID\"/")
      FORK_PREFIX=$(head -$FORK_COPIED_EXPECT "$FORK_LOG")
      if [[ "$SRC_PREFIX" == "$FORK_PREFIX" ]]; then
        pass 6 "fork log prefix is a byte-exact copy of the source prefix (meta id rewritten)"
      else
        fail 6 "fork log prefix differs from source prefix"
      fi
    else
      fail 6 "fork log.jsonl missing at $FORK_LOG"
    fi
  else
    fail 6 "could not hash source log before fork (missing file)"
  fi
  # resume-without-interrupt on the forked thread must fail (no pending
  # interrupt at entry 4).
  RJSON=$(helper resume "{\"thread_id\":\"$FORK_ID\",\"answer\":\"yes\"}" || true)
  if printf '%s' "$RJSON" | jq -e '.ok == false' >/dev/null 2>&1; then
    pass 6 "resume on forked thread refused (no pending interrupt): $(jget "$RJSON" '.error')"
  else
    fail 6 "resume on forked thread did NOT fail: $RJSON"
  fi
  # Criterion 6 in-process cross-check via the helper: fork fold shows the
  # prefix state (findings == ["core bug found"], verdict {}).
  NJ=$(helper next "{\"thread_id\":\"$FORK_ID\"}" || true)
  if printf '%s' "$NJ" | jq -e '.ok == true' >/dev/null 2>&1; then
    NF=$(jget "$NJ" '.result.state.findings | length')
    NV=$(jget "$NJ" '.result.state.verdict' 2>/dev/null)
    if [[ "$NF" == "1" && "$NV" == "{}" ]]; then
      pass 6 "forked thread folds to the recorded prefix state (findings=[core bug found], verdict={})"
    else
      fail 6 "forked thread fold mismatch: findings length=$NF verdict=$NV"
    fi
  else
    fail 6 "helper next on forked thread failed: $NJ"
  fi
else
  fail 6 "fork via helper failed: $FORK_JSON"
fi

# Criterion 8: unit suites green; no npm dependencies; package-lock untouched.
echo "== CRITERION 8: unit suites + zero deps + lock untouched =="
LOCK_BEFORE=$(sha_of "$REPO_ROOT/package-lock.json" 2>/dev/null || echo "absent")
if (cd "$REPO_ROOT/.pi/extensions/durable-workflows" && npm test >/tmp/wf-drill-unittest.log 2>&1); then
  UTESTS=$(grep -E '^# (tests|pass) ' /tmp/wf-drill-unittest.log | head -2 || true)
  pass 8 "all unit suites green ($UTESTS)"
else
  fail 8 "unit suites failed (see /tmp/wf-drill-unittest.log)"
fi
DEPS=$(jget "$(cat "$REPO_ROOT/.pi/extensions/durable-workflows/package.json" | jq -c .)" '.dependencies // "none"' 2>/dev/null || echo "?")
if [[ "$DEPS" == "none" ]]; then
  pass 8 "extension package.json declares zero dependencies"
else
  fail 8 "extension package.json has dependencies: $DEPS"
fi
if [[ ! -e "$REPO_ROOT/.pi/extensions/durable-workflows/node_modules" && ! -e "$REPO_ROOT/.pi/extensions/durable-workflows/package-lock.json" ]]; then
  pass 8 "no node_modules / package-lock in the extension dir"
else
  fail 8 "extension dir gained node_modules or package-lock.json"
fi
LOCK_AFTER=$(sha_of "$REPO_ROOT/package-lock.json" 2>/dev/null || echo "absent")
if [[ "$LOCK_BEFORE" == "$LOCK_AFTER" ]]; then
  pass 8 "repo package-lock.json untouched (sha256 $LOCK_AFTER)"
else
  fail 8 "repo package-lock.json changed during drill: $LOCK_BEFORE -> $LOCK_AFTER"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo
echo "DRILL SUMMARY: $PASS_N passed, $FAIL_N failed"
if [[ $FAIL_N -gt 0 ]]; then
  echo "FAILED CRITERIA: ${FAILED_CRITERIA[*]}"
  echo "scratch (preserved only with DRILL_PRESERVE=1): $SCRATCH"
  exit 1
fi
echo "ALL PASS"
