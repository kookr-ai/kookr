#!/usr/bin/env bash
# select-specialists.sh — diff-adaptive pre-PR reviewer panel selection (issue #1305).
#
# Decides which reviewer specialists to launch from the CONTENT of the branch
# diff, never from the implementer's self-report. `correctness` is always
# included as an unconditional, independent cross-check. The cheap "lint-like"
# passes (conventions + deadcode, plus docs-drift when relevant) are folded into
# a single `lint-like` reviewer so a small PR pays 2-3 spawns instead of 5.
#
# An explicit escape hatch (`--force` / FORCE_FULL_PANEL=1) restores the full,
# un-consolidated 5-panel for large / risky / security-touching diffs.
#
# Usage:
#   select-specialists.sh [--force] [--base <ref>]
#
# Environment:
#   FORCE_FULL_PANEL=1     same as --force
#   SPECIALIST_BASE_REF    default base ref (else origin/main, else main)
#
# Output (stable, machine-readable lines followed by human rationale):
#   SPECIALISTS=correctness,lint-like,test
#   DOCS_DRIFT=active|inactive
#   FORCE=yes|no
#   COUNT=<n>
#   rationale:
#     <one line per selected specialist>
set -euo pipefail

FORCE="${FORCE_FULL_PANEL:-}"
BASE_REF="${SPECIALIST_BASE_REF:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --force) FORCE=1 ;;
    --base)
      if [ $# -lt 2 ]; then
        printf 'select-specialists: --base requires a ref argument\n' >&2
        exit 2
      fi
      shift; BASE_REF="$1" ;;
    --base=*) BASE_REF="${1#--base=}" ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) printf 'select-specialists: unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
  shift
done

# Resolve the base ref: explicit override, else the repo's default branch
# (main/master, remote-tracking preferred). Falls through to staged content
# only when none resolve (fresh/detached checkout).
if [ -z "$BASE_REF" ]; then
  for candidate in origin/main main origin/master master; do
    if git rev-parse --verify -q "$candidate" >/dev/null 2>&1; then
      BASE_REF="$candidate"
      break
    fi
  done
fi

if [ -n "$BASE_REF" ] && git rev-parse --verify -q "$BASE_REF" >/dev/null 2>&1; then
  MB=$(git merge-base "$BASE_REF" HEAD 2>/dev/null || printf '%s' "$BASE_REF")
  CHANGED_FILES=$(git diff --name-only "$MB" HEAD)
  # Exclude git's `+++ b/<path>` file headers so a filename containing the word
  # "export" cannot masquerade as a public-API change in the grep below.
  ADDED_LINES=$(git diff "$MB" HEAD | grep '^+' | grep -v '^+++' || true)
else
  # No base ref available (fresh repo / detached): fall back to staged content.
  CHANGED_FILES=$(git diff --cached --name-only)
  ADDED_LINES=$(git diff --cached | grep '^+' | grep -v '^+++' || true)
fi

has_change=0
has_nontest_logic=0
has_docs=0

while IFS= read -r f; do
  [ -z "$f" ] && continue
  has_change=1
  base=${f##*/}

  is_test=0
  case "$f" in
    */__tests__/*|*/__mocks__/*) is_test=1 ;;
  esac
  case "$base" in
    *.test.*|*.spec.*|*.test.sh) is_test=1 ;;
  esac

  is_doc=0
  case "$base" in
    *.md|*.mdx|*.rst|*.txt) is_doc=1 ;;
  esac
  case "$f" in
    docs/*|*/docs/*) is_doc=1 ;;
  esac

  if [ "$is_doc" = 1 ]; then
    has_docs=1
  elif [ "$is_test" = 1 ]; then
    :
  else
    has_nontest_logic=1
  fi
done <<EOF
$CHANGED_FILES
EOF

# Public-API signal from diff content: exported symbols added/changed.
api_changed=0
if printf '%s\n' "$ADDED_LINES" | grep -Eq '^\+.*\bexport\b'; then
  api_changed=1
fi

docs_drift_active=0
if [ "$has_docs" = 1 ] || [ "$api_changed" = 1 ]; then
  docs_drift_active=1
fi

if [ -n "$FORCE" ]; then
  printf 'SPECIALISTS=%s\n' 'conventions,correctness,deadcode,test,docs-drift'
  printf 'DOCS_DRIFT=%s\n' 'active'
  printf 'FORCE=%s\n' 'yes'
  printf 'COUNT=%s\n' '5'
  printf 'rationale:\n'
  printf '  force-full-panel: explicit escape hatch — full independent 5-panel restored (large/risky/security diff)\n'
  exit 0
fi

set -- correctness
[ "$has_change" = 1 ] && set -- "$@" lint-like
[ "$has_nontest_logic" = 1 ] && set -- "$@" test
count=$#

# Join selection with commas.
sel_csv=""
for s in "$@"; do
  if [ -z "$sel_csv" ]; then sel_csv="$s"; else sel_csv="$sel_csv,$s"; fi
done

printf 'SPECIALISTS=%s\n' "$sel_csv"
if [ "$docs_drift_active" = 1 ]; then
  printf 'DOCS_DRIFT=%s\n' 'active'
else
  printf 'DOCS_DRIFT=%s\n' 'inactive'
fi
printf 'FORCE=%s\n' 'no'
printf 'COUNT=%s\n' "$count"
printf 'rationale:\n'
printf '  correctness: always — unconditional, independent cross-check\n'
if [ "$has_change" = 1 ]; then
  if [ "$docs_drift_active" = 1 ]; then
    printf '  lint-like: source changed; conventions + deadcode + docs-drift concerns active (docs/public API touched)\n'
  else
    printf '  lint-like: source changed; conventions + deadcode concerns active (docs-drift dormant — no docs/public API change)\n'
  fi
fi
if [ "$has_nontest_logic" = 1 ]; then
  printf '  test: non-test logic changed\n'
fi
