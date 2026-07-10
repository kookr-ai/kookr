#!/usr/bin/env bash
# Regression test for issue #1308: the rfc-iterative-review skill must
# (1) enforce the critic-panel cap as a *checked* gate (assertion + recorded
# override for N>5), not just prose, and (2) ship a shared evidence pack that
# is marked "evidence to check" while preserving the mandatory post-round-1
# empirical redundancy.
#
# The skill is an LLM-followed workflow, not an executable hook, so this test
# asserts the enforcing language is present in SKILL.md. That prevents a future
# edit from silently regressing the gate back to unbinding prose (the exact
# failure #1308 documents).
#
# Run: bash .claude/hooks-tests/rfc-critic-cap.test.sh
# Or:  pnpm test:hooks

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
SKILL="$REPO_ROOT/plugin/skills/rfc-iterative-review/SKILL.md"

if [ ! -f "$SKILL" ]; then
  printf 'FAIL: skill not found at %s\n' "$SKILL" >&2
  exit 1
fi

PASS=0
FAIL=0

# assert_grep <label> <pattern>  — pattern must be present (fixed-string, -F)
assert_grep() {
  local label="$1"; local pattern="$2"
  if grep -qF -- "$pattern" "$SKILL"; then
    PASS=$((PASS + 1))
    printf 'PASS: %s\n' "$label"
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL: %s — missing: %s\n' "$label" "$pattern" >&2
  fi
}

# --- Panel cap enforced as a checked gate --------------------------------

assert_grep "panel selection gate exists" "Panel Selection Gate"
# The cap is expressed as an assertion, not just prose.
assert_grep "cap is an assertion (N <= 5)" 'Assert `N ≤ 5`'
# N>5 requires a recorded justification/override line.
assert_grep "override requires recorded justification" "Panel cap override"
assert_grep "gate says >5 requires recorded justification" "record an explicit justification"

# --- Shared evidence pack -------------------------------------------------

assert_grep "shared evidence pack section exists" "Shared evidence pack"
assert_grep "pack assembly documented — pipeline map" "Pipeline map"
assert_grep "pack assembly documented — telemetry findings" "Telemetry / evidence findings"
# Pack is bundled into each critic's prompt.
assert_grep "pack delivered into every critic prompt" "into **every** critic's prompt"

# --- Preserve redundancy: verify-not-trust + freedom to re-verify --------

assert_grep "pack marked evidence-to-check, not settled fact" '"evidence to check,"'
assert_grep "critics free to re-read and re-verify" "re-read source and re-verify"
assert_grep "cap limits breadth not depth" "cap limits breadth, not depth"

# --- Mandatory empirical checkpoint retained & cross-referenced ----------

assert_grep "empirical checkpoint still mandatory" "Empirical validation checkpoint (MANDATORY)"
assert_grep "checkpoint cross-referenced as intentional redundancy" "intentional redundancy"

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
