#!/usr/bin/env bash
# Tests for plugin/hooks/skill-load-counter.sh.
#
# The hook's contract: append one valid JSONL record per skill invocation,
# and NEVER block — every failure path must exit 0 without corrupting the log.

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
HOOK="$REPO_ROOT/plugin/hooks/skill-load-counter.sh"

PASS=0
FAIL=0

TMP=$(mktemp -d)
trap "rm -rf '$TMP'" EXIT

LOG="$TMP/skill-load-log.jsonl"

run_hook() {
  KOOKR_SKILL_LOAD_LOG="$LOG" "$HOOK"
}

assert_exit0() {
  local label="$1"
  local rc="$2"
  if [ "$rc" -eq 0 ]; then
    PASS=$((PASS + 1))
    printf 'PASS: %s\n' "$label"
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL: %s — expected exit 0, got %s\n' "$label" "$rc" >&2
  fi
}

assert_log_lines() {
  local label="$1"
  local expected="$2"
  local actual
  actual=$(wc -l < "$LOG" 2>/dev/null || echo 0)
  if [ "$actual" -eq "$expected" ]; then
    PASS=$((PASS + 1))
    printf 'PASS: %s\n' "$label"
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL: %s — expected %s log lines, got %s\n' "$label" "$expected" "$actual" >&2
  fi
}

# --- happy path: one valid JSONL record with the right skill name ---

rc=0; printf '{"tool_input":{"skill":"probe-skill"}}' | run_hook || rc=$?
assert_exit0 "valid payload exits 0" "$rc"
assert_log_lines "valid payload appends one line" 1
if [ "$(jq -r '.skill' "$LOG")" = "probe-skill" ]; then
  PASS=$((PASS + 1)); printf 'PASS: record carries the skill name\n'
else
  FAIL=$((FAIL + 1)); printf 'FAIL: record carries the skill name\n' >&2
fi

# --- hostile skill name: newline must still produce one valid JSON line ---

rc=0; printf '{"tool_input":{"skill":"a\\nb"}}' | run_hook || rc=$?
assert_exit0 "newline-bearing skill name exits 0" "$rc"
assert_log_lines "newline-bearing skill name appends exactly one line" 2
if jq -s 'length == 2' "$LOG" >/dev/null 2>&1 && [ "$(jq -s '.[1].skill' "$LOG")" = '"a\nb"' ]; then
  PASS=$((PASS + 1)); printf 'PASS: log stays parseable JSONL with encoded newline\n'
else
  FAIL=$((FAIL + 1)); printf 'FAIL: log stays parseable JSONL with encoded newline\n' >&2
fi

# --- failure paths: exit 0, no append ---

rc=0; run_hook </dev/null || rc=$?
assert_exit0 "empty stdin exits 0" "$rc"
assert_log_lines "empty stdin appends nothing" 2

rc=0; printf 'not json at all' | run_hook || rc=$?
assert_exit0 "malformed JSON exits 0" "$rc"
assert_log_lines "malformed JSON appends nothing" 2

rc=0; printf '{"tool_input":{}}' | run_hook || rc=$?
assert_exit0 "payload without skill exits 0" "$rc"
assert_log_lines "payload without skill appends nothing" 2

rc=0; head -c 70000 /dev/zero | tr '\0' 'x' | run_hook || rc=$?
assert_exit0 "oversized payload exits 0" "$rc"
assert_log_lines "oversized payload appends nothing" 2

rc=0; printf '{"tool_input":{"skill":"x"}}' | KOOKR_SKILL_LOAD_LOG="$TMP/no-such-dir-parent-is-a-file/log.jsonl" sh -c "touch '$TMP/no-such-dir-parent-is-a-file'; '$HOOK'" || rc=$?
assert_exit0 "unwritable log path exits 0" "$rc"

rc=0; printf '{"tool_input":{"skill":"x"}}' | KOOKR_SKILL_LOAD_COUNTER_SKIP=1 run_hook || rc=$?
assert_exit0 "KOOKR_SKILL_LOAD_COUNTER_SKIP=1 exits 0" "$rc"
assert_log_lines "skip flag appends nothing" 2

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
