#!/usr/bin/env bash
# Tests for scripts/validate-skills.ts.

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
VALIDATOR="$REPO_ROOT/scripts/validate-skills.ts"

PASS=0
FAIL=0

run_validator() {
  pnpm --dir "$REPO_ROOT" exec tsx "$VALIDATOR" "$@" >/tmp/skill-validator.out 2>&1
}

assert_pass() {
  local label="$1"
  shift
  if run_validator "$@"; then
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
  shift
  if run_validator "$@"; then
    FAIL=$((FAIL + 1))
    printf 'FAIL: %s — expected non-zero exit, got 0\n' "$label" >&2
  else
    PASS=$((PASS + 1))
    printf 'PASS: %s\n' "$label"
  fi
}

# Warn-mode contract: exit 0 but the warning text must be present.
assert_warns() {
  local label="$1"
  local pattern="$2"
  shift 2
  if run_validator "$@" && grep -q "$pattern" /tmp/skill-validator.out; then
    PASS=$((PASS + 1))
    printf 'PASS: %s\n' "$label"
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL: %s — expected exit 0 with warning matching: %s\n' "$label" "$pattern" >&2
    sed 's/^/    /' /tmp/skill-validator.out >&2
  fi
}

write_skill() {
  local dir="$1"
  local name="$2"
  shift 2
  mkdir -p "$dir"
  printf '%s\n' '---' "name: $name" "description: Test skill $name." "$@" '---' "# $name" \
    > "$dir/SKILL.md"
}

TMP=$(mktemp -d)
trap "rm -rf '$TMP' /tmp/skill-validator.out" EXIT

# --- frontmatter checks (errors: fail in both modes) ---

mkdir -p "$TMP/valid/plugin/skills/good"
printf '%s\n' \
  '---' \
  'name: good' \
  'description: "Handles values with colon: safely when quoted."' \
  'related: [helper]' \
  '---' \
  '# Good' \
  > "$TMP/valid/plugin/skills/good/SKILL.md"
write_skill "$TMP/valid/plugin/skills/helper" helper
assert_pass "valid frontmatter with resolvable related passes" "$TMP/valid"
assert_pass "valid corpus stays clean under --strict" "$TMP/valid" --strict

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

# --- reference linter (warnings: exit 0 normally, exit 1 under --strict) ---

write_skill "$TMP/phantom/plugin/skills/refs" refs 'related: nonexistent-skill'
assert_warns "phantom related warns in warn mode" 'does not resolve on the shipped surface' "$TMP/phantom"
assert_fail "phantom related fails under --strict" "$TMP/phantom" --strict

write_skill "$TMP/cross-tier/.claude/skills/kookr-helper" kookr-helper
write_skill "$TMP/cross-tier/plugin/skills/shipped" shipped 'related: helper'
assert_warns "plugin ref resolving only to .claude/kookr-* flags cross-tier" 'cross-tier dependency' "$TMP/cross-tier"

write_skill "$TMP/local-ok/.claude/skills/kookr-a" kookr-a 'related: kookr-b'
write_skill "$TMP/local-ok/.claude/skills/kookr-b" kookr-b
assert_pass ".claude refs may resolve within .claude" "$TMP/local-ok" --strict

mkdir -p "$TMP/wiki/plugin/skills/wiki"
{
  printf '%s\n' '---' 'name: wiki' 'description: Wiki-link cases.' '---' '# Wiki'
  printf '%s\n' 'See [[ghost-skill]] for more.'
} > "$TMP/wiki/plugin/skills/wiki/SKILL.md"
assert_warns "phantom wiki-link warns" 'wiki-link "ghost-skill"' "$TMP/wiki"

mkdir -p "$TMP/fenced/plugin/skills/fenced"
{
  printf '%s\n' '---' 'name: fenced' 'description: Fenced-block exclusion.' '---' '# Fenced'
  printf '%s\n' '```' 'related: [[ghost-skill]], [[another-ghost]]' '```'
  printf '%s\n' 'And inline syntax examples like `[[ghost-skill]]` are skipped too.'
} > "$TMP/fenced/plugin/skills/fenced/SKILL.md"
assert_pass "wiki-links in fenced blocks and inline code are ignored" "$TMP/fenced" --strict

mkdir -p "$TMP/paths/plugin/skills/paths"
{
  printf '%s\n' '---' 'name: paths' 'description: Path existence.' '---' '# Paths'
  printf '%s\n' 'See `src/missing-file.ts` for details.'
} > "$TMP/paths/plugin/skills/paths/SKILL.md"
assert_warns "missing inline-code repo path warns" 'referenced path does not exist: src/missing-file.ts' "$TMP/paths"

mkdir -p "$TMP/paths-ok/plugin/skills/paths-ok" "$TMP/paths-ok/src"
touch "$TMP/paths-ok/src/real-file.ts"
{
  printf '%s\n' '---' 'name: paths-ok' 'description: Path existence.' '---' '# Paths OK'
  printf '%s\n' 'See `src/real-file.ts` for details.'
} > "$TMP/paths-ok/plugin/skills/paths-ok/SKILL.md"
assert_pass "existing inline-code repo path passes" "$TMP/paths-ok" --strict

mkdir -p "$TMP/username/plugin/skills/user"
{
  printf '%s\n' '---' 'name: user' 'description: Username portability.' '---' '# User'
  printf '%s\n' 'Assign to jeanibarz.'
} > "$TMP/username/plugin/skills/user/SKILL.md"
assert_warns "hardcoded username in shipped content warns" 'hardcoded username' "$TMP/username"

mkdir -p "$TMP/username-local/.claude/skills/kookr-user"
{
  printf '%s\n' '---' 'name: kookr-user' 'description: Username in repo-local content.' '---' '# User'
  printf '%s\n' 'Assign to jeanibarz.'
} > "$TMP/username-local/.claude/skills/kookr-user/SKILL.md"
assert_pass "username in repo-local .claude content is allowed" "$TMP/username-local" --strict

mkdir -p "$TMP/playbook/plugin/playbooks"
printf '%s\n' '# Playbook' 'Run [[ghost-skill]] first.' > "$TMP/playbook/plugin/playbooks/demo.md"
assert_warns "plugin playbooks are scanned" 'wiki-link "ghost-skill"' "$TMP/playbook"

# --- flag handling ---

set +e
run_validator "$TMP/valid" --stict
rc=$?
set -e
if [ "$rc" -eq 2 ]; then
  PASS=$((PASS + 1))
  printf 'PASS: unknown flag rejected with exit 2\n'
else
  FAIL=$((FAIL + 1))
  printf 'FAIL: unknown flag rejected — expected exit 2, got %s\n' "$rc" >&2
  sed 's/^/    /' /tmp/skill-validator.out >&2
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
