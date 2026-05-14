#!/usr/bin/env bash
# Regression tests for plugin/hooks/reflect-memory-frontmatter-gate.sh.

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
GATE="$REPO_ROOT/plugin/hooks/reflect-memory-frontmatter-gate.sh"

PASS=0
FAIL=0

event_write() {
  local path="$1"
  printf '{"tool_name":"Write","tool_input":{"file_path":"%s","content":""}}\n' "$path"
}

assert_case() {
  local name="$1"
  local event="$2"
  local expected_exit="$3"
  local expected_grep="$4"
  shift 4

  local out actual_exit
  out=$(printf '%s' "$event" | env "$@" "$GATE" 2>&1) && actual_exit=0 || actual_exit=$?

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

node_only_bin=$(mktemp -d -t reflect-memory-gate-path.XXXXXX)
ln -s "$(command -v node)" "$node_only_bin/node"
ln -s "$(command -v bash)" "$node_only_bin/bash"
ln -s "$(command -v cat)" "$node_only_bin/cat"

assert_case \
  "ordinary file write is allowed without bun" \
  "$(event_write "$REPO_ROOT/README.md")" \
  0 \
  "" \
  "PATH=$node_only_bin" \
  "HOME=$HOME"

assert_case \
  "memory write blocks without bun" \
  "$(event_write "$HOME/.claude/projects/example/memory/note.md")" \
  2 \
  "bun not on PATH; blocking memory write" \
  "PATH=$node_only_bin" \
  "HOME=$HOME"

rm -rf "$node_only_bin"

if [ "$FAIL" -ne 0 ]; then
  printf '%s reflect-memory-frontmatter-gate tests failed; %s passed.\n' "$FAIL" "$PASS" >&2
  exit 1
fi

printf '%s reflect-memory-frontmatter-gate tests passed.\n' "$PASS"
