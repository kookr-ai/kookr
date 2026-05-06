#!/usr/bin/env bash
# Regression test for issue #87: .review-state/*.json files must never be
# staged for push. They are local-only review-gate markers.
#
# Run: bash .claude/hooks-tests/pre-push-review-state.test.sh
# Or:  pnpm test:hooks

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
HOOK="$REPO_ROOT/.hooks/pre-push"

if [ ! -f "$HOOK" ]; then
  printf 'FAIL: hook not found at %s\n' "$HOOK" >&2
  exit 1
fi

TMPDIR=$(mktemp -d -t pre-push-review-state.XXXXXX)
cleanup() {
  rm -rf "$TMPDIR"
}
trap cleanup EXIT

git init -q -b main "$TMPDIR"
git -C "$TMPDIR" config user.email "test@example.com"
git -C "$TMPDIR" config user.name "test"
printf 'base\n' > "$TMPDIR/README.md"
git -C "$TMPDIR" add README.md
git -C "$TMPDIR" commit -q -m "base"

mkdir -p "$TMPDIR/.review-state"
printf '{"sha":"abc","status":"approved"}\n' > "$TMPDIR/.review-state/foo.json"
git -C "$TMPDIR" add .review-state/foo.json

set +e
OUT=$(cd "$TMPDIR" && bash "$HOOK" 2>&1)
STATUS=$?
set -e

if [ "$STATUS" -eq 0 ]; then
  printf 'FAIL: expected pre-push to reject staged .review-state file\n' >&2
  printf '%s\n' "$OUT" >&2
  exit 1
fi

if ! printf '%s' "$OUT" | grep -q '.review-state files must stay local-only'; then
  printf 'FAIL: rejection did not mention local-only .review-state files\n' >&2
  printf '%s\n' "$OUT" >&2
  exit 1
fi

printf 'PASS: staged .review-state file is rejected\n'
