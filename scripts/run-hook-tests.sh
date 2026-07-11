#!/usr/bin/env bash

set -u

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
TEST_DIR="$REPO_ROOT/.claude/hooks-tests"
FILTER=${1:-}

passed=0
failed=0
selected=0
failing_suites=()

for suite in "$TEST_DIR"/*.test.sh; do
  [ -f "$suite" ] || continue

  suite_name=$(basename "$suite")
  if [ -n "$FILTER" ] && [[ "$suite_name" != *"$FILTER"* ]]; then
    continue
  fi

  selected=$((selected + 1))
  printf '== %s ==\n' "$suite_name"
  if bash "$suite"; then
    passed=$((passed + 1))
  else
    failed=$((failed + 1))
    failing_suites+=("$suite_name")
  fi
  printf '\n'
done

if [ "$selected" -eq 0 ]; then
  if [ -n "$FILTER" ]; then
    printf "No hook test suites matched '%s'.\n" "$FILTER" >&2
  else
    printf 'No hook test suites found in %s.\n' "$TEST_DIR" >&2
  fi
  exit 1
fi

printf '%s passed / %s failed\n' "$passed" "$failed"
if [ "$failed" -gt 0 ]; then
  printf 'Failing suites:\n'
  for suite_name in "${failing_suites[@]}"; do
    printf '  - %s\n' "$suite_name"
  done
  exit 1
fi
