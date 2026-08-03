#!/usr/bin/env bash
# Regression tests for hooks/gh-pr-merge-gate.sh (issue #1968).
#
# Run: bash .claude/hooks-tests/gh-pr-merge-gate.test.sh
# Or:  pnpm test:hooks

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
HOOK="$REPO_ROOT/hooks/gh-pr-merge-gate.sh"

[ -f "$HOOK" ] || { printf 'FAIL: hook not found at %s\n' "$HOOK" >&2; exit 1; }

PASS=0
FAIL=0

mk_payload() {
  jq -n --arg cmd "$1" '{tool_name:"Bash", tool_input:{command:$cmd}}'
}

run_hook() {
  local payload="$1"
  shift
  local tmpdir
  tmpdir=$(mktemp -d)
  local out
  out=$(
    printf '%s' "$payload" \
      | env HOME="$tmpdir" "$@" bash "$HOOK" 2>&1
  ) || true
  rm -rf "$tmpdir"
  printf '%s' "$out"
}

classify() {
  if printf '%s' "$1" | grep -q '"permissionDecision": "deny"'; then
    printf 'deny'
  else
    printf 'allow'
  fi
}

check() {
  local name="$1" want="$2" got="$3" detail="${4:-}"
  if [ "$want" = "$got" ]; then
    PASS=$((PASS + 1))
    printf '  [OK]   %s\n' "$name"
  else
    FAIL=$((FAIL + 1))
    printf '  [FAIL] %s (want %s got %s)\n' "$name" "$want" "$got"
    [ -n "$detail" ] && printf '         %s\n' "$detail"
  fi
}

printf '\nRunning gh-pr-merge-gate tests (issue #1968)\n\n'

# 1. No KOOKR_TASK_ID → allow (human / non-kookr session)
OUT=$(run_hook "$(mk_payload 'gh pr merge 42 --squash')" -u KOOKR_TASK_ID)
check "no KOOKR_TASK_ID → allow" allow "$(classify "$OUT")" "$OUT"

# 2. KOOKR_TASK_ID + default require review → deny bare gh pr merge
OUT=$(run_hook "$(mk_payload 'gh pr merge 42 --squash --delete-branch')" KOOKR_TASK_ID=task-1)
check "kookr session bare merge → deny" deny "$(classify "$OUT")" "$OUT"
if [ "$(classify "$OUT")" = "deny" ] && printf '%s' "$OUT" | grep -q 'pnpm merge'; then
  PASS=$((PASS + 1))
  printf '  [OK]   deny reason steers to pnpm merge\n'
else
  FAIL=$((FAIL + 1))
  printf '  [FAIL] deny reason steers to pnpm merge\n'
fi

# 3. KOOKR_MERGE_REQUIRE_REVIEW=0 → allow even in kookr session
OUT=$(run_hook "$(mk_payload 'gh pr merge 7')" KOOKR_TASK_ID=task-1 KOOKR_MERGE_REQUIRE_REVIEW=0)
check "KOOKR_MERGE_REQUIRE_REVIEW=0 → allow" allow "$(classify "$OUT")" "$OUT"

# 4. Non-merge command → allow (passthrough)
OUT=$(run_hook "$(mk_payload 'gh pr view 42')" KOOKR_TASK_ID=task-1)
check "gh pr view → allow" allow "$(classify "$OUT")" "$OUT"

# 5. Prefixed env still matches bare merge → deny
OUT=$(run_hook "$(mk_payload 'FOO=1 gh pr merge 99 --squash')" KOOKR_TASK_ID=task-1)
check "env-prefixed gh pr merge → deny" deny "$(classify "$OUT")" "$OUT"

printf '\nResults: %d passed, %d failed\n' "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
