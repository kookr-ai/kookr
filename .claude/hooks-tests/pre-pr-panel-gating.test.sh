#!/usr/bin/env bash
# Regression tests for issue #1305: the pre-PR review specialist panel is
# diff-adaptive. `correctness` always runs; `test` runs only when non-test
# logic changes; the consolidated `lint-like` reviewer runs on any change and
# activates its docs-drift concern when docs / public API change; and an
# explicit --force restores the full un-consolidated 5-panel.
#
# Run: bash .claude/hooks-tests/pre-pr-panel-gating.test.sh
# Or:  pnpm test:hooks

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
SELECT="$REPO_ROOT/plugin/skills/pre-pr-review/select-specialists.sh"

if [ ! -x "$SELECT" ]; then
  printf 'FAIL: gating helper not found/executable at %s\n' "$SELECT" >&2
  exit 1
fi

TMPDIR=$(mktemp -d -t pre-pr-panel-gating.XXXXXX)
cleanup() { rm -rf "$TMPDIR"; }
trap cleanup EXIT

# Build a repo with an origin/main baseline and a feature branch.
setup_repo() {
  local repo="$1"
  git init -q -b main "$repo"
  git -C "$repo" config user.email "test@example.com"
  git -C "$repo" config user.name "test"
  mkdir -p "$repo/src"
  printf 'export const base = 1\n' > "$repo/src/base.ts"
  git -C "$repo" add src/base.ts
  git -C "$repo" commit -q -m "base"
  git -C "$repo" update-ref refs/remotes/origin/main HEAD
  git -C "$repo" checkout -q -b feature
}

run_select() {
  local repo="$1"; shift
  (cd "$repo" && "$SELECT" "$@")
}

assert_field() {
  local out="$1" key="$2" want="$3" label="$4"
  local got
  got=$(printf '%s\n' "$out" | grep "^${key}=" | head -1 | cut -d= -f2-)
  if [ "$got" != "$want" ]; then
    printf 'FAIL [%s]: %s expected "%s" got "%s"\n' "$label" "$key" "$want" "$got" >&2
    printf '%s\n' '--- output ---' >&2
    printf '%s\n' "$out" >&2
    exit 1
  fi
}

# --- Case 1: test-only diff -> correctness + lint-like, no test specialist ---
repo="$TMPDIR/test-only"; setup_repo "$repo"
printf 'test("x", () => {})\n' > "$repo/src/base.test.ts"
git -C "$repo" add src/base.test.ts
git -C "$repo" commit -q -m "test only"
out=$(run_select "$repo")
assert_field "$out" SPECIALISTS "correctness,lint-like" "test-only"
assert_field "$out" DOCS_DRIFT "inactive" "test-only"
assert_field "$out" COUNT "2" "test-only"

# --- Case 2: docs-only diff -> correctness + lint-like, docs-drift active ----
repo="$TMPDIR/docs-only"; setup_repo "$repo"
mkdir -p "$repo/docs"
printf '# Guide\n' > "$repo/docs/guide.md"
git -C "$repo" add docs/guide.md
git -C "$repo" commit -q -m "docs only"
out=$(run_select "$repo")
assert_field "$out" SPECIALISTS "correctness,lint-like" "docs-only"
assert_field "$out" DOCS_DRIFT "active" "docs-only"
assert_field "$out" COUNT "2" "docs-only"

# --- Case 3: single-file logic diff -> correctness + lint-like + test (<=3) --
repo="$TMPDIR/logic"; setup_repo "$repo"
printf 'const internal = 2\n' > "$repo/src/logic.ts"
git -C "$repo" add src/logic.ts
git -C "$repo" commit -q -m "logic"
out=$(run_select "$repo")
assert_field "$out" SPECIALISTS "correctness,lint-like,test" "logic"
assert_field "$out" DOCS_DRIFT "inactive" "logic"
assert_field "$out" COUNT "3" "logic"
count=$(printf '%s\n' "$out" | grep '^COUNT=' | cut -d= -f2)
if [ "$count" -gt 3 ]; then
  printf 'FAIL [logic]: single-file PR launched %s specialists (>3)\n' "$count" >&2
  exit 1
fi

# --- Case 4: public-API logic diff -> docs-drift concern activates -----------
repo="$TMPDIR/api"; setup_repo "$repo"
printf 'export function publicApi() { return 3 }\n' > "$repo/src/api.ts"
git -C "$repo" add src/api.ts
git -C "$repo" commit -q -m "public api"
out=$(run_select "$repo")
assert_field "$out" SPECIALISTS "correctness,lint-like,test" "api"
assert_field "$out" DOCS_DRIFT "active" "api"

# --- Case 5: --force restores the full un-consolidated 5-panel ---------------
repo="$TMPDIR/force"; setup_repo "$repo"
printf 'const internal = 4\n' > "$repo/src/logic.ts"
git -C "$repo" add src/logic.ts
git -C "$repo" commit -q -m "logic"
out=$(run_select "$repo" --force)
assert_field "$out" SPECIALISTS "conventions,correctness,deadcode,test,docs-drift" "force"
assert_field "$out" FORCE "yes" "force"
assert_field "$out" COUNT "5" "force"

# FORCE_FULL_PANEL env var is equivalent to --force.
out=$(cd "$repo" && FORCE_FULL_PANEL=1 "$SELECT")
assert_field "$out" SPECIALISTS "conventions,correctness,deadcode,test,docs-drift" "force-env"
assert_field "$out" FORCE "yes" "force-env"
assert_field "$out" COUNT "5" "force-env"

# --- Case 6: mixed docs + non-test logic -> both branches active -------------
repo="$TMPDIR/mixed"; setup_repo "$repo"
mkdir -p "$repo/docs"
printf '# Guide\n' > "$repo/docs/guide.md"
printf 'const internal = 5\n' > "$repo/src/logic.ts"
git -C "$repo" add docs/guide.md src/logic.ts
git -C "$repo" commit -q -m "mixed"
out=$(run_select "$repo")
assert_field "$out" SPECIALISTS "correctness,lint-like,test" "mixed"
assert_field "$out" DOCS_DRIFT "active" "mixed"

# --- Case 7: empty diff vs base -> correctness floor only --------------------
repo="$TMPDIR/empty"; setup_repo "$repo"
git -C "$repo" commit -q --allow-empty -m "no file changes"
out=$(run_select "$repo")
assert_field "$out" SPECIALISTS "correctness" "empty"
assert_field "$out" COUNT "1" "empty"

printf 'PASS: pre-PR specialist panel gating is diff-adaptive\n'
