#!/usr/bin/env bash
# Fast pre-push gate test lane (issue #3788).
#
# Usage: bash scripts/fast-gate-tests.sh <merge-base-sha>
#
# Runs only the tests related to the diff <merge-base-sha>..HEAD instead of the
# whole suite (the integration train runs that). The selection logic lives in
# scripts/fast-gate-select.mjs. Exits non-zero only when a selected test or lane
# command fails; deferred and unmapped paths are reported and never fail.
#
# Flaky handling matches the full-suite lane in .hooks/pre-push: when a few test
# files fail, re-run only those once; a pass is logged to the shared flaky log
# and the push continues, a second failure fails the gate.

set -u

BASE="${1:-}"
if [ -z "$BASE" ]; then
  echo "usage: fast-gate-tests.sh <merge-base-sha>" >&2
  exit 2
fi

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd -P)
SELECTOR="$SCRIPT_DIR/fast-gate-select.mjs"
FLAKY_HELPER="$SCRIPT_DIR/flaky-rerun-files.mjs"
# Select against the repo being pushed (the cwd), not the checkout holding this script.
REPO_ROOT=$(git rev-parse --show-toplevel)
cd "$REPO_ROOT" || exit 2

WORK=$(mktemp -d "${TMPDIR:-/tmp}/kookr-fast-gate.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

if ! node "$SELECTOR" --root "$REPO_ROOT" --base "$BASE" > "$WORK/selection.json"; then
  echo "[fast-gate] selection failed" >&2
  exit 1
fi

# json_list <field> <outfile>: one array element per line.
json_list() { jq -r ".$1[]" "$WORK/selection.json" > "$2"; }
json_list related "$WORK/related"
json_list tests "$WORK/tests"
json_list commands "$WORK/commands"
json_list deferred "$WORK/deferred"
json_list unmapped "$WORK/unmapped"

count() { grep -c . "$1" || true; }
echo "[fast-gate] $(count "$WORK/related") source files -> related tests, $(count "$WORK/tests") extra test files, $(count "$WORK/commands") lane command(s); full suite runs on the integration train"

status=0

# --- Vitest: tests importing the changed sources, plus the listed test files.
# `vitest related` runs a test when it imports a listed path or IS a listed path,
# so both lists go in one invocation. Paths come from a file into "$@", never
# through word-splitting.
set --
while IFS= read -r p; do
  [ -n "$p" ] && set -- "$@" "$p"
done < <(cat "$WORK/related" "$WORK/tests" | sort -u)

if [ "$#" -gt 0 ]; then
  REPORT="$WORK/vitest-report.json"
  if ! VITEST_RERUN_SUMMARY_FILE="$REPORT" pnpm exec vitest related --run --passWithNoTests "$@"; then
    RERUN_FILES=""
    if [ -f "$FLAKY_HELPER" ]; then
      RERUN_FILES=$(node "$FLAKY_HELPER" "$REPORT" --max-files 5) || RERUN_FILES=""
    fi
    if [ -z "$RERUN_FILES" ]; then
      status=1
    else
      set --
      while IFS= read -r f; do
        [ -n "$f" ] && set -- "$@" "$f"
      done <<EOF
$RERUN_FILES
EOF
      echo ""
      echo "[fast-gate] $# test file(s) failed; re-running only those once to tell a flake from a real failure:"
      printf '  %s\n' "$@"
      if pnpm exec vitest run "$@"; then
        FLAKY_LOG="$(git rev-parse --git-common-dir 2>/dev/null)/kookr-flaky-tests.log"
        HEAD_SHA=$(git rev-parse HEAD 2>/dev/null || echo unknown)
        BRANCH=$(git symbolic-ref --short HEAD 2>/dev/null || echo detached)
        for f in "$@"; do
          printf '%s\t%s\t%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$BRANCH" "$HEAD_SHA" "$f" >> "$FLAKY_LOG" 2>/dev/null || true
        done
        echo ""
        echo "[fast-gate] FLAKY: the file(s) above failed in the first run and passed on re-run."
        echo "[fast-gate] Continuing. Logged to $FLAKY_LOG - please fix these flakes."
      else
        status=1
      fi
    fi
  fi
fi

# --- Lane commands (fixed strings from the selector's rule table).
while IFS= read -r cmd; do
  [ -n "$cmd" ] || continue
  echo "[fast-gate] running: $cmd"
  read -r -a argv <<< "$cmd"
  if ! "${argv[@]}"; then
    echo "[fast-gate] lane command failed: $cmd" >&2
    status=1
  fi
done < "$WORK/commands"

# --- Report what this gate leaves to the integration train.
while IFS= read -r p; do
  [ -n "$p" ] && echo "[fast-gate] $p: verified by the integration train"
done < "$WORK/deferred"

if [ -s "$WORK/unmapped" ]; then
  UNMAPPED_LOG="$(git rev-parse --git-common-dir 2>/dev/null)/kookr-fast-gate-unmapped.log"
  BRANCH=$(git symbolic-ref --short HEAD 2>/dev/null || echo detached)
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    echo "[fast-gate] $p: no fast-gate rule; left to the integration train"
    printf '%s\t%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$BRANCH" "$p" >> "$UNMAPPED_LOG" 2>/dev/null || true
  done < "$WORK/unmapped"
fi

exit "$status"
