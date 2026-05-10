#!/usr/bin/env bash
# Tests for hooks/skill-placement-gate.sh — fixture-based.
#
# Each case prepares a tmp directory with a synthetic repo layout and runs
# the gate against it. No git init required (the gate accepts an explicit
# repo-root argument).
#
# Run: bash .claude/hooks-tests/skill-placement-gate.test.sh
# Or:  pnpm test:hooks

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
HOOK="$REPO_ROOT/hooks/skill-placement-gate.sh"

if [ ! -f "$HOOK" ]; then
  printf 'FAIL: hook not found at %s\n' "$HOOK" >&2
  exit 1
fi

PASS=0
FAIL=0

assert_pass() {
  local label="$1"; local dir="$2"
  if bash "$HOOK" "$dir" 2>/dev/null; then
    PASS=$((PASS + 1))
    printf 'PASS: %s\n' "$label"
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL: %s — expected exit 0, got non-zero\n' "$label" >&2
    bash "$HOOK" "$dir" 2>&1 | sed 's/^/    /' >&2 || true
  fi
}

assert_fail() {
  local label="$1"; local dir="$2"
  if bash "$HOOK" "$dir" >/dev/null 2>&1; then
    FAIL=$((FAIL + 1))
    printf 'FAIL: %s — expected non-zero exit, got 0\n' "$label" >&2
  else
    PASS=$((PASS + 1))
    printf 'PASS: %s\n' "$label"
  fi
}

TMP=$(mktemp -d)
trap "rm -rf '$TMP'" EXIT

# Case 1: clean repo — kookr-* in .claude/skills, unprefixed in plugin/skills, empty agents
mkdir -p "$TMP/c1/.claude/skills/kookr-foo" "$TMP/c1/plugin/skills/general-skill"
assert_pass "clean repo passes" "$TMP/c1"

# Case 2: unprefixed dir in .claude/skills/
mkdir -p "$TMP/c2/.claude/skills/general-skill"
assert_fail "unprefixed dir in .claude/skills rejected" "$TMP/c2"

# Case 3: unprefixed file in .claude/agents/
mkdir -p "$TMP/c3/.claude/agents"
touch "$TMP/c3/.claude/agents/foo.md"
assert_fail "unprefixed agent in .claude/agents rejected" "$TMP/c3"

# Case 3b: kookr-* file in .claude/agents/ passes
mkdir -p "$TMP/c3b/.claude/agents"
touch "$TMP/c3b/.claude/agents/kookr-foo.md"
assert_pass "kookr-* agent in .claude/agents passes" "$TMP/c3b"

# Case 4: collision between .claude/skills and plugin/skills
mkdir -p "$TMP/c4/.claude/skills/kookr-foo" "$TMP/c4/plugin/skills/kookr-foo"
assert_fail "name collision rejected" "$TMP/c4"

# Case 5: kookr- prefix in plugin/skills
mkdir -p "$TMP/c5/plugin/skills/kookr-bad"
assert_fail "kookr- prefix in plugin/skills rejected" "$TMP/c5"

# Case 6: unqualified subagent_type in plugin/skills
mkdir -p "$TMP/c6/plugin/skills/foo"
echo 'Agent({subagent_type: "boundary-critic", prompt: "..."})' > "$TMP/c6/plugin/skills/foo/SKILL.md"
assert_fail "unqualified subagent_type rejected" "$TMP/c6"

# Case 7: qualified subagent_type passes
mkdir -p "$TMP/c7/plugin/skills/foo"
echo 'Agent({subagent_type: "kookr-toolkit:boundary-critic", prompt: "..."})' > "$TMP/c7/plugin/skills/foo/SKILL.md"
assert_pass "qualified subagent_type passes" "$TMP/c7"

# Case 8: descriptive prose mentioning an agent name (not in subagent_type context) passes
mkdir -p "$TMP/c8/plugin/skills/foo"
echo 'See the boundary-critic agent for boundary reviews.' > "$TMP/c8/plugin/skills/foo/SKILL.md"
assert_pass "descriptive prose mention passes" "$TMP/c8"

# Case 9: empty repo passes
mkdir -p "$TMP/c9"
assert_pass "empty repo passes" "$TMP/c9"

# Case 10: .claude/agents absent passes
mkdir -p "$TMP/c10/.claude/skills/kookr-foo"
assert_pass "absent .claude/agents passes" "$TMP/c10"

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
