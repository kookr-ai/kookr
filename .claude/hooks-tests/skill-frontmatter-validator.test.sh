#!/usr/bin/env bash
# Tests for scripts/validate-skills.ts.

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
VALIDATOR="$REPO_ROOT/scripts/validate-skills.ts"

PASS=0
FAIL=0

assert_pass() {
  local label="$1"
  local dir="$2"
  if pnpm --dir "$REPO_ROOT" exec tsx "$VALIDATOR" "$dir" >/tmp/skill-validator.out 2>&1; then
    PASS=$((PASS + 1))
    printf 'PASS: %s\n' "$label"
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL: %s — expected exit 0, got non-zero\n' "$label" >&2
    sed 's/^/    /' /tmp/skill-validator.out >&2
  fi
}

assert_fail() {
  local label="$1"
  local dir="$2"
  if pnpm --dir "$REPO_ROOT" exec tsx "$VALIDATOR" "$dir" >/tmp/skill-validator.out 2>&1; then
    FAIL=$((FAIL + 1))
    printf 'FAIL: %s — expected non-zero exit, got 0\n' "$label" >&2
  else
    PASS=$((PASS + 1))
    printf 'PASS: %s\n' "$label"
  fi
}

TMP=$(mktemp -d)
trap "rm -rf '$TMP' /tmp/skill-validator.out" EXIT

mkdir -p "$TMP/valid/plugin/skills/good"
printf '%s\n' \
  '---' \
  'name: good' \
  'description: "Handles values with colon: safely when quoted."' \
  'related: [one, two]' \
  '---' \
  '# Good' \
  > "$TMP/valid/plugin/skills/good/SKILL.md"
assert_pass "valid frontmatter passes" "$TMP/valid"

mkdir -p "$TMP/bad-yaml/plugin/skills/bad"
printf '%s\n' \
  '---' \
  'name: bad' \
  'description: This plain scalar has a colon: and must fail' \
  '---' \
  '# Bad' \
  > "$TMP/bad-yaml/plugin/skills/bad/SKILL.md"
assert_fail "invalid YAML frontmatter rejected" "$TMP/bad-yaml"

mkdir -p "$TMP/missing-name/plugin/skills/no-name"
printf '%s\n' \
  '---' \
  'description: Missing name' \
  '---' \
  '# Missing Name' \
  > "$TMP/missing-name/plugin/skills/no-name/SKILL.md"
assert_fail "missing name rejected" "$TMP/missing-name"

mkdir -p "$TMP/no-frontmatter/plugin/skills/no-frontmatter"
printf '%s\n' '# No Frontmatter' > "$TMP/no-frontmatter/plugin/skills/no-frontmatter/SKILL.md"
assert_fail "missing frontmatter rejected" "$TMP/no-frontmatter"

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
