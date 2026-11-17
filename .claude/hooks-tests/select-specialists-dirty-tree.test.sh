#!/usr/bin/env bash
# Regression tests for issue #4113: select-specialists.sh must classify staged
# and unstaged edits to tracked files, not only committed history. Before the
# fix, an agent that had not committed yet got `SPECIALISTS=correctness`,
# `COUNT=1` and exit 0 — a silently narrowed review panel. A clean tree must
# still produce byte-identical stdout.
#
# Run: bash .claude/hooks-tests/select-specialists-dirty-tree.test.sh
# Or:  pnpm test:hooks select-specialists-dirty-tree

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
SELECT="${SELECT_SPECIALISTS:-$REPO_ROOT/plugin/skills/pre-pr-review/select-specialists.sh}"

if [ ! -f "$SELECT" ]; then
  printf 'FAIL: gating helper not found at %s\n' "$SELECT" >&2
  exit 1
fi

TMPDIR=$(mktemp -d -t select-specialists-dirty.XXXXXX)
cleanup() { rm -rf "$TMPDIR"; }
trap cleanup EXIT

# A repo whose origin/main holds a tracked src/core file, on a feature branch
# with no commits ahead of the base.
setup_repo() {
  local repo="$1"
  git init -q -b main "$repo"
  git -C "$repo" config user.email "test@example.com"
  git -C "$repo" config user.name "test"
  mkdir -p "$repo/src/core"
  printf 'const merge = 1\n' > "$repo/src/core/pr-merge-command.ts"
  git -C "$repo" add src/core/pr-merge-command.ts
  git -C "$repo" commit -q -m "base"
  git -C "$repo" update-ref refs/remotes/origin/main HEAD
  git -C "$repo" checkout -q -b feature
}

# Runs the helper; sets OUT (stdout), ERR (stderr), RC (exit code).
run_select() {
  local repo="$1"; shift
  RC=0
  OUT=$(cd "$repo" && bash "$SELECT" "$@" 2>"$TMPDIR/stderr") || RC=$?
  ERR=$(cat "$TMPDIR/stderr")
}

fail() {
  printf 'FAIL [%s]: %s\n--- stdout ---\n%s\n--- stderr ---\n%s\n' "$1" "$2" "$OUT" "$ERR" >&2
  exit 1
}

assert_field() {
  local key="$1" want="$2" label="$3" got
  got=$(grep "^${key}=" <<<"$OUT" | head -1 | cut -d= -f2-) || true
  [ "$got" = "$want" ] || fail "$label" "$key expected \"$want\" got \"$got\""
}

assert_rc0() { [ "$RC" -eq 0 ] || fail "$1" "exit code $RC, expected 0"; }

# --- Acceptance 1: one unstaged edit under src/core, no commits ahead --------
repo="$TMPDIR/unstaged"; setup_repo "$repo"
printf 'const extra = 2\n' >> "$repo/src/core/pr-merge-command.ts"
run_select "$repo"
assert_rc0 "unstaged"
assert_field SPECIALISTS "correctness,lint-like,test" "unstaged"
assert_field COUNT "3" "unstaged"
assert_field DOCS_DRIFT "inactive" "unstaged"
grep -q 'included 1 uncommitted tracked file' <<<"$ERR" \
  || fail "unstaged" "expected a stderr note naming 1 uncommitted file"
if grep -q 'uncommitted' <<<"$OUT"; then
  fail "unstaged" "the uncommitted-files note must go to stderr, not stdout"
fi

# --- Staged-only edit ---------------------------------------------------------
repo="$TMPDIR/staged"; setup_repo "$repo"
printf 'const extra = 2\n' >> "$repo/src/core/pr-merge-command.ts"
git -C "$repo" add src/core/pr-merge-command.ts
run_select "$repo"
assert_rc0 "staged"
assert_field SPECIALISTS "correctness,lint-like,test" "staged"
assert_field COUNT "3" "staged"

# --- Staged new file ----------------------------------------------------------
repo="$TMPDIR/staged-new"; setup_repo "$repo"
printf 'const fresh = 1\n' > "$repo/src/core/fresh.ts"
git -C "$repo" add src/core/fresh.ts
run_select "$repo"
assert_rc0 "staged-new"
assert_field SPECIALISTS "correctness,lint-like,test" "staged-new"

# --- Union: committed test-only change + uncommitted logic edit ---------------
repo="$TMPDIR/union"; setup_repo "$repo"
printf 'test("x", () => {})\n' > "$repo/src/core/pr-merge-command.test.ts"
git -C "$repo" add src/core/pr-merge-command.test.ts
git -C "$repo" commit -q -m "test only"
run_select "$repo"
assert_field SPECIALISTS "correctness,lint-like" "union-before-edit"
printf 'const extra = 2\n' >> "$repo/src/core/pr-merge-command.ts"
run_select "$repo"
assert_rc0 "union"
assert_field SPECIALISTS "correctness,lint-like,test" "union"
assert_field COUNT "3" "union"

# --- Content signal: an uncommitted export activates docs-drift --------------
repo="$TMPDIR/export"; setup_repo "$repo"
printf 'export const api = 3\n' >> "$repo/src/core/pr-merge-command.ts"
run_select "$repo"
assert_field DOCS_DRIFT "active" "uncommitted-export"

# --- Untracked-only files stay out of scope (issue covers tracked files) -----
repo="$TMPDIR/untracked"; setup_repo "$repo"
printf 'const loose = 1\n' > "$repo/src/core/loose.ts"
run_select "$repo"
assert_rc0 "untracked"
assert_field SPECIALISTS "correctness" "untracked"
assert_field COUNT "1" "untracked"

# --- No base ref resolves (develop-only repo): unstaged edits still count ---
repo="$TMPDIR/no-base"
git init -q -b develop "$repo"
git -C "$repo" config user.email "test@example.com"
git -C "$repo" config user.name "test"
mkdir -p "$repo/src/core"
printf 'const merge = 1\n' > "$repo/src/core/pr-merge-command.ts"
git -C "$repo" add src/core/pr-merge-command.ts
git -C "$repo" commit -q -m "base"
printf 'const extra = 2\n' >> "$repo/src/core/pr-merge-command.ts"
run_select "$repo"
assert_rc0 "no-base"
assert_field SPECIALISTS "correctness,lint-like,test" "no-base"
assert_field COUNT "3" "no-base"

# --- Acceptance 2: clean tree stdout is byte-identical -----------------------
repo="$TMPDIR/clean-empty"; setup_repo "$repo"
run_select "$repo"
assert_rc0 "clean-empty"
want_empty='SPECIALISTS=correctness
DOCS_DRIFT=inactive
FORCE=no
COUNT=1
rationale:
  correctness: always — unconditional, independent cross-check'
[ "$OUT" = "$want_empty" ] || fail "clean-empty" "stdout differs from the pre-#4113 contract"
[ -z "$ERR" ] || fail "clean-empty" "clean tree must not print a stderr note"

repo="$TMPDIR/clean-ahead"; setup_repo "$repo"
printf 'const more = 2\n' >> "$repo/src/core/pr-merge-command.ts"
git -C "$repo" commit -q -am "logic"
run_select "$repo"
assert_rc0 "clean-ahead"
want_ahead='SPECIALISTS=correctness,lint-like,test
DOCS_DRIFT=inactive
FORCE=no
COUNT=3
rationale:
  correctness: always — unconditional, independent cross-check
  lint-like: source changed; conventions + deadcode concerns active (docs-drift dormant — no docs/public API change)
  test: non-test logic changed'
[ "$OUT" = "$want_ahead" ] || fail "clean-ahead" "stdout differs from the pre-#4113 contract"
[ -z "$ERR" ] || fail "clean-ahead" "clean tree must not print a stderr note"

printf 'PASS: select-specialists classifies uncommitted tracked changes; clean-tree output unchanged (#4113)\n'
