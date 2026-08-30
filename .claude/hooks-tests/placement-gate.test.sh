#!/usr/bin/env bash
# Regression tests for plugin/hooks/placement-gate.sh.

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
GATE="$REPO_ROOT/plugin/hooks/placement-gate.sh"

PASS=0
FAIL=0

make_repo() {
  local kind="$1"
  local dir
  # Resolve to the physical path: on macOS `mktemp -d` yields /var/folders/...
  # but `git rev-parse --show-toplevel` (used by the gate) returns the
  # symlink-resolved /private/var/folders/... . Without this, the gate's
  # REPO_ROOT prefix match misses every fixture path and no warning fires.
  dir=$(cd "$(mktemp -d -t placement-gate.XXXXXX)" && pwd -P)
  (
    cd "$dir"
    git init -q -b main
    git config user.email "test@example.com"
    git config user.name "test"
    if [ "$kind" = "kookr" ]; then
      mkdir -p plugin/.claude-plugin
      printf '{"name":"kookr-toolkit","version":"0.0.0"}\n' > plugin/.claude-plugin/plugin.json
    fi
    : > base.txt
    git add .
    git commit -q -m base
  )
  printf '%s' "$dir"
}

event_write() {
  local path="$1"
  printf '{"tool_name":"Write","tool_input":{"file_path":"%s","content":""}}\n' "$path"
}

event_bash() {
  local command="$1"
  node -e 'console.log(JSON.stringify({tool_name:"Bash",tool_input:{command:process.argv[1]}}))' "$command"
}

assert_case() {
  local name="$1"
  local repo="$2"
  local event="$3"
  local expected_exit="$4"
  local expected_grep="$5"

  local out actual_exit
  out=$(cd "$repo" && printf '%s' "$event" | "$GATE" 2>&1) && actual_exit=0 || actual_exit=$?

  local ok=1
  if [ "$actual_exit" != "$expected_exit" ]; then
    ok=0
    printf 'FAIL: %s — expected exit %s, got %s\n%s\n' "$name" "$expected_exit" "$actual_exit" "$out" >&2
  elif [ -n "$expected_grep" ] && ! printf '%s' "$out" | grep -qE "$expected_grep"; then
    ok=0
    printf 'FAIL: %s — output did not match /%s/\n%s\n' "$name" "$expected_grep" "$out" >&2
  elif [ -z "$expected_grep" ] && [ -n "$out" ]; then
    ok=0
    printf 'FAIL: %s — expected no output, got:\n%s\n' "$name" "$out" >&2
  fi

  if [ "$ok" = 1 ]; then
    PASS=$((PASS + 1))
    printf 'PASS: %s\n' "$name"
  else
    FAIL=$((FAIL + 1))
  fi
}

kookr_repo=$(make_repo kookr)
plain_repo=$(make_repo plain)

assert_case \
  "kookr project skill without prefix warns" \
  "$kookr_repo" \
  "$(event_write "$kookr_repo/.claude/skills/example/SKILL.md")" \
  0 \
  "project-scope Kookr skills must start"

assert_case \
  "kookr project skill with prefix passes" \
  "$kookr_repo" \
  "$(event_write "$kookr_repo/.claude/skills/kookr-example/SKILL.md")" \
  0 \
  ""

touch "$kookr_repo/.kookr-placement-gate-strict"
assert_case \
  "strict mode blocks warning" \
  "$kookr_repo" \
  "$(event_write "$kookr_repo/.claude/skills/another/SKILL.md")" \
  2 \
  "possible placement mismatch"
rm "$kookr_repo/.kookr-placement-gate-strict"

assert_case \
  "non-kookr project skill does not warn" \
  "$plain_repo" \
  "$(event_write "$plain_repo/.claude/skills/their-skill/SKILL.md")" \
  0 \
  ""

assert_case \
  "plain-repo plugin skill with kookr prefix passes" \
  "$plain_repo" \
  "$(event_write "$plain_repo/plugin/skills/kookr-example/SKILL.md")" \
  0 \
  ""

assert_case \
  "plain-repo plugin agent with kookr prefix passes" \
  "$plain_repo" \
  "$(event_write "$plain_repo/plugin/agents/kookr-agent.md")" \
  0 \
  ""

assert_case \
  "kookr plugin skill with kookr prefix warns" \
  "$kookr_repo" \
  "$(event_write "$kookr_repo/plugin/skills/kookr-example/SKILL.md")" \
  0 \
  "distributed plugin skills must not start"

assert_case \
  "kookr plugin agent with kookr prefix warns" \
  "$kookr_repo" \
  "$(event_write "$kookr_repo/plugin/agents/kookr-agent.md")" \
  0 \
  "distributed plugin agents must not start"

assert_case \
  "kookr project agent without prefix warns" \
  "$kookr_repo" \
  "$(event_write "$kookr_repo/.claude/agents/example.md")" \
  0 \
  "project-scope Kookr agents must start"

mkdir -p "$kookr_repo/plugin/skills/duplicate"
assert_case \
  "same-name project skill duplicating plugin skill warns" \
  "$kookr_repo" \
  "$(event_write "$kookr_repo/.claude/skills/duplicate/SKILL.md")" \
  0 \
  "already exists"

assert_case \
  "bash redirected write is parsed" \
  "$kookr_repo" \
  "$(event_bash "cat > '$kookr_repo/.claude/skills/bash-skill/SKILL.md' <<'EOF'")" \
  0 \
  "project-scope Kookr skills must start"

assert_case \
  "quoted greater-than text is not parsed as redirect" \
  "$kookr_repo" \
  "$(event_bash "printf 'example > $kookr_repo/.claude/skills/text-only/SKILL.md\n'")" \
  0 \
  ""

(
  cd "$kookr_repo"
  mkdir -p .claude/skills/existing
  : > .claude/skills/existing/SKILL.md
  git add .claude/skills/existing/SKILL.md
  git commit -q -m "track existing skill"
)
assert_case \
  "tracked existing path is skipped" \
  "$kookr_repo" \
  "$(event_write "$kookr_repo/.claude/skills/existing/SKILL.md")" \
  0 \
  ""

assert_case \
  "malformed hook event is skipped" \
  "$kookr_repo" \
  "{not json" \
  0 \
  ""

rm -rf "$kookr_repo" "$plain_repo"

if [ "$FAIL" -ne 0 ]; then
  printf '%s placement-gate tests failed; %s passed.\n' "$FAIL" "$PASS" >&2
  exit 1
fi

printf '%s placement-gate tests passed.\n' "$PASS"
