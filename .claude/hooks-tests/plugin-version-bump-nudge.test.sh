#!/usr/bin/env bash
# Test for hooks/plugin-version-bump-nudge.sh — the in-session early-warning
# PostToolUse hook that reminds the agent to bump plugin.json#version after
# editing bundled plugin content.
#
# Run: bash .claude/hooks-tests/plugin-version-bump-nudge.test.sh
# Or:  pnpm test:hooks

set -u

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
HOOK="$REPO_ROOT/hooks/plugin-version-bump-nudge.sh"

if [ ! -f "$HOOK" ]; then
  printf 'FAIL: hook not found at %s\n' "$HOOK" >&2
  exit 1
fi

command -v jq >/dev/null 2>&1 || { printf 'SKIP: jq not on PATH\n'; exit 0; }

FAILURES=0

# Build a temp repo. `$1` = working version for plugin.json ("0.1.0" matches
# origin/main = no bump; "0.2.0" = bumped). Echoes the repo dir.
make_repo() {
  local working_version="$1"
  local TMPDIR
  TMPDIR=$(mktemp -d -t plugin-version-bump-nudge.XXXXXX)
  git init -q -b main "$TMPDIR"
  git -C "$TMPDIR" config user.email "test@example.com"
  git -C "$TMPDIR" config user.name "test"
  mkdir -p "$TMPDIR/plugin/.claude-plugin" "$TMPDIR/plugin/playbooks"
  printf 'base\n' > "$TMPDIR/README.md"
  printf '{\n  "name": "kookr-toolkit",\n  "version": "0.1.0"\n}\n' \
    > "$TMPDIR/plugin/.claude-plugin/plugin.json"
  printf '# Demo\n\nbody\n' > "$TMPDIR/plugin/playbooks/demo.md"
  git -C "$TMPDIR" add -A
  git -C "$TMPDIR" commit -q -m base
  git -C "$TMPDIR" update-ref refs/remotes/origin/main HEAD
  # Apply the working-tree version (simulating an in-progress edit session).
  printf '{\n  "name": "kookr-toolkit",\n  "version": "%s"\n}\n' "$working_version" \
    > "$TMPDIR/plugin/.claude-plugin/plugin.json"
  printf '%s' "$TMPDIR"
}

run_hook() {
  local file="$1"
  printf '{"tool_input":{"file_path":"%s"}}' "$file" | bash "$HOOK" 2>/dev/null
}

expect_nudge() {
  local label="$1" out="$2"
  if printf '%s' "$out" | jq -e '.hookSpecificOutput.additionalContext | test("version")' >/dev/null 2>&1; then
    printf 'PASS: %s\n' "$label"
  else
    printf 'FAIL: %s — expected a version-bump nudge, got: %s\n' "$label" "${out:-<empty>}" >&2
    FAILURES=$((FAILURES + 1))
  fi
}

expect_silent() {
  local label="$1" out="$2"
  if [ -z "$out" ]; then
    printf 'PASS: %s\n' "$label"
  else
    printf 'FAIL: %s — expected no output, got: %s\n' "$label" "$out" >&2
    FAILURES=$((FAILURES + 1))
  fi
}

# 1. plugin content edited, version NOT bumped -> nudge.
REPO=$(make_repo "0.1.0")
expect_nudge "plugin playbook edit without bump nudges" \
  "$(run_hook "$REPO/plugin/playbooks/demo.md")"
rm -rf "$REPO"

# 2. plugin content edited, version ALREADY bumped -> silent.
REPO=$(make_repo "0.2.0")
expect_silent "no nudge once the version is bumped" \
  "$(run_hook "$REPO/plugin/playbooks/demo.md")"
rm -rf "$REPO"

# 3. plugin.json itself edited -> silent (editing it is how you bump).
REPO=$(make_repo "0.1.0")
expect_silent "editing plugin.json itself does not nudge" \
  "$(run_hook "$REPO/plugin/.claude-plugin/plugin.json")"
rm -rf "$REPO"

# 4. non-plugin file edited -> silent.
REPO=$(make_repo "0.1.0")
expect_silent "editing a non-plugin file does not nudge" \
  "$(run_hook "$REPO/README.md")"
rm -rf "$REPO"

if [ "$FAILURES" -ne 0 ]; then
  printf 'Results: %d failed\n' "$FAILURES" >&2
  exit 1
fi
printf 'Results: all passed\n'
