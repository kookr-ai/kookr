#!/usr/bin/env bash
# Regression tests for hooks/gh-pr-merge-gate.sh (issue #1968, #2944).
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

# --- issue #2944: the `gh api` PUT .../pulls/<n>/merge bypass -----------------

# 6. gh api PUT to the merge endpoint → deny (the bypass this issue closes)
OUT=$(run_hook "$(mk_payload 'gh api --method PUT repos/kookr-ai/kookr/pulls/42/merge --raw-field merge_method=squash')" KOOKR_TASK_ID=task-1)
check "gh api PUT pulls/N/merge → deny" deny "$(classify "$OUT")" "$OUT"

# 7. Short -X PUT form of the same call → deny
OUT=$(run_hook "$(mk_payload 'gh api -X PUT repos/o/r/pulls/7/merge -f merge_method=squash')" KOOKR_TASK_ID=task-1)
check "gh api -X PUT pulls/N/merge → deny" deny "$(classify "$OUT")" "$OUT"

# 8. env-prefixed gh api PUT merge → deny (defense-in-depth, matcher is Bash(gh api*))
OUT=$(run_hook "$(mk_payload 'FOO=1 gh api --method PUT repos/o/r/pulls/9/merge')" KOOKR_TASK_ID=task-1)
check "env-prefixed gh api PUT merge → deny" deny "$(classify "$OUT")" "$OUT"

# 9. gh api on a non-merge path → allow (the overwhelming majority of gh api)
OUT=$(run_hook "$(mk_payload 'gh api repos/o/r/pulls/42 --jq .mergeable')" KOOKR_TASK_ID=task-1)
check "gh api non-merge path → allow" allow "$(classify "$OUT")" "$OUT"

# 10. gh api GET (read-only) merge-status check on the merge path → allow.
#     A merge always spells out PUT; a bare/GET request only reads status.
OUT=$(run_hook "$(mk_payload 'gh api repos/o/r/pulls/42/merge')" KOOKR_TASK_ID=task-1)
check "gh api GET pulls/N/merge (status) → allow" allow "$(classify "$OUT")" "$OUT"

# 11. Sanctioned wrapper still works — `bash scripts/kookr-merge.sh <PR>` does
#     not itself match a merge verb (its inner gh api runs as a subprocess, not
#     a Bash tool call), so the hook lets it straight through.
OUT=$(run_hook "$(mk_payload 'bash scripts/kookr-merge.sh 42')" KOOKR_TASK_ID=task-1)
check "bash scripts/kookr-merge.sh → allow" allow "$(classify "$OUT")" "$OUT"

# 12. pnpm merge wrapper → allow
OUT=$(run_hook "$(mk_payload 'pnpm merge 42')" KOOKR_TASK_ID=task-1)
check "pnpm merge → allow" allow "$(classify "$OUT")" "$OUT"

# 13. KOOKR_MERGE_REQUIRE_REVIEW=0 disables the gh api gate too → allow
OUT=$(run_hook "$(mk_payload 'gh api --method PUT repos/o/r/pulls/42/merge')" KOOKR_TASK_ID=task-1 KOOKR_MERGE_REQUIRE_REVIEW=0)
check "review off → gh api merge allowed" allow "$(classify "$OUT")" "$OUT"

# --- per-segment evaluation: chained bypasses + compound false positives -----

# 14. Chained no-op wrapper must NOT launder a real gh api merge → deny.
#     (Appending `&& bash scripts/kookr-merge.sh <PR>` once slipped past a
#     whole-string wrapper allow-list.)
OUT=$(run_hook "$(mk_payload 'gh api --method PUT repos/o/r/pulls/42/merge && bash scripts/kookr-merge.sh 999')" KOOKR_TASK_ID=task-1)
check "gh api merge && kookr-merge.sh → deny" deny "$(classify "$OUT")" "$OUT"

# 15. Same laundering attempt for the `gh pr merge` verb → deny.
OUT=$(run_hook "$(mk_payload 'gh pr merge 42 --squash; bash scripts/kookr-merge.sh 999')" KOOKR_TASK_ID=task-1)
check "gh pr merge ; kookr-merge.sh → deny" deny "$(classify "$OUT")" "$OUT"

# 16. Compound gh api where the merge PATH and the PUT belong to DIFFERENT
#     calls (read PR-42 merge status, then PUT an unrelated resource) → allow.
OUT=$(run_hook "$(mk_payload 'gh api repos/o/r/pulls/42/merge --jq .merged && gh api --method PUT repos/o/r/labels/bug')" KOOKR_TASK_ID=task-1)
check "split path/PUT across calls → allow" allow "$(classify "$OUT")" "$OUT"

# 17. Glued method-flag spellings still deny (lock the regex coverage).
OUT=$(run_hook "$(mk_payload 'gh api --method=PUT repos/o/r/pulls/5/merge')" KOOKR_TASK_ID=task-1)
check "gh api --method=PUT merge → deny" deny "$(classify "$OUT")" "$OUT"
OUT=$(run_hook "$(mk_payload 'gh api -XPUT repos/o/r/pulls/5/merge')" KOOKR_TASK_ID=task-1)
check "gh api -XPUT merge → deny" deny "$(classify "$OUT")" "$OUT"

printf '\nResults: %d passed, %d failed\n' "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
