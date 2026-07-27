#!/usr/bin/env bash
# Regression tests for issue #1558: a branch-deletion push (all-zeros local
# sha on every refspec) skips the heavy pre-push quality gate and exits 0
# fast, while mixed and normal refspec sets still run the full gate.
#
# Run: bash .claude/hooks-tests/pre-push-delete-only-skip.test.sh
# Or:  pnpm test:hooks

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
HOOK="$REPO_ROOT/.hooks/pre-push"

if [ ! -f "$HOOK" ]; then
  printf 'FAIL: hook not found at %s\n' "$HOOK" >&2
  exit 1
fi

ZERO_SHA="0000000000000000000000000000000000000000"
# 64-char all-zeros: git deletes under a SHA-256 repo send this form. The hook
# detects zero shas length-agnostically, so both must skip the gate.
ZERO_SHA256="0000000000000000000000000000000000000000000000000000000000000000"
UPDATE_SHA="1111111111111111111111111111111111111111"

# mktemp -d (no -t template): GNU and BSD/macOS agree on the bare form; the
# `-t name.XXXXXX` template is substituted differently across the two.
TMPDIR=$(mktemp -d)
cleanup() {
  rm -rf "$TMPDIR"
}
trap cleanup EXIT

setup_repo() {
  local repo="$1"
  git init -q -b main "$repo"
  git -C "$repo" config user.email "test@example.com"
  git -C "$repo" config user.name "test"
  mkdir -p "$repo/node_modules" "$repo/bin"
  cat > "$repo/bin/pnpm" <<'PNPM'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$PNPM_LOG"
exit 0
PNPM
  chmod +x "$repo/bin/pnpm"
  # A non-trivial source file so the normal/mixed cases would demand the full
  # gate (review marker + heavy lanes) — proving the gate really ran.
  mkdir -p "$repo/src"
  printf 'base\n' > "$repo/README.md"
  printf 'code\n' > "$repo/src/index.ts"
  git -C "$repo" add README.md src/index.ts
  git -C "$repo" commit -q -m "base"
  git -C "$repo" update-ref refs/remotes/origin/main HEAD
}

write_review_marker() {
  local repo="$1"
  local branch="$2"
  local head_sha
  head_sha=$(git -C "$repo" rev-parse HEAD)
  mkdir -p "$repo/.review-state"
  printf '{"sha":"%s","status":"approved"}\n' "$head_sha" > "$repo/.review-state/$branch.json"
}

# Run the hook feeding refspec lines on stdin (as git does). Returns the exit
# status; the pnpm command log is reset before each run.
run_hook_with_stdin() {
  local repo="$1"
  local stdin_data="$2"
  : > "$repo/pnpm.log"
  (cd "$repo" && PNPM_LOG="$repo/pnpm.log" PATH="$repo/bin:$PATH" bash "$HOOK" <<<"$stdin_data")
}

assert_log_absent() {
  local repo="$1"
  local command="$2"
  if grep -Fxq "$command" "$repo/pnpm.log"; then
    printf 'FAIL: did not expect pnpm command "%s"\n' "$command" >&2
    printf '%s\n' '--- pnpm.log ---' >&2
    cat "$repo/pnpm.log" >&2
    exit 1
  fi
}

assert_log_contains() {
  local repo="$1"
  local command="$2"
  if ! grep -Fxq "$command" "$repo/pnpm.log"; then
    printf 'FAIL: expected pnpm command "%s"\n' "$command" >&2
    printf '%s\n' '--- pnpm.log ---' >&2
    cat "$repo/pnpm.log" >&2
    exit 1
  fi
}

assert_gate_skipped() {
  local repo="$1"
  # No gate lane should have run for a delete-only push.
  assert_log_absent "$repo" "build:server"
  assert_log_absent "$repo" "check:e2e"
  assert_log_absent "$repo" "test"
  assert_log_absent "$repo" "validate:skills"
}

assert_gate_ran() {
  local repo="$1"
  assert_log_contains "$repo" "build:server"
  assert_log_contains "$repo" "check:e2e"
  assert_log_contains "$repo" "test"
}

# --- Case 1: delete-only push skips the gate and exits 0 fast --------------
delete_repo="$TMPDIR/delete-only"
setup_repo "$delete_repo"
delete_out=$(run_hook_with_stdin "$delete_repo" \
  "(delete) $ZERO_SHA refs/heads/feature $UPDATE_SHA")
assert_gate_skipped "$delete_repo"
if ! printf '%s\n' "$delete_out" | grep -q "delete-only push — skipping quality gate"; then
  printf 'FAIL: delete-only notice not printed\n' >&2
  printf '%s\n' "$delete_out" >&2
  exit 1
fi

# --- Case 2: delete-only with TWO deleted refs still skips -----------------
multi_delete_repo="$TMPDIR/multi-delete"
setup_repo "$multi_delete_repo"
run_hook_with_stdin "$multi_delete_repo" \
"(delete) $ZERO_SHA refs/heads/feature-a $UPDATE_SHA
(delete) $ZERO_SHA refs/heads/feature-b $UPDATE_SHA" >/dev/null
assert_gate_skipped "$multi_delete_repo"

# --- Case 2b: delete-only with a 64-char (SHA-256) zero sha still skips ----
sha256_repo="$TMPDIR/sha256-delete"
setup_repo "$sha256_repo"
run_hook_with_stdin "$sha256_repo" \
  "(delete) $ZERO_SHA256 refs/heads/feature $UPDATE_SHA" >/dev/null
assert_gate_skipped "$sha256_repo"

# --- Case 3: mixed push (one delete + one update) runs the full gate -------
mixed_repo="$TMPDIR/mixed"
setup_repo "$mixed_repo"
git -C "$mixed_repo" checkout -q -b mixed
printf 'more\n' > "$mixed_repo/src/index.ts"
git -C "$mixed_repo" add src/index.ts
git -C "$mixed_repo" commit -q -m "change"
write_review_marker "$mixed_repo" "mixed"
mixed_head=$(git -C "$mixed_repo" rev-parse HEAD)
run_hook_with_stdin "$mixed_repo" \
"refs/heads/mixed $mixed_head refs/heads/mixed $UPDATE_SHA
(delete) $ZERO_SHA refs/heads/stale $UPDATE_SHA" >/dev/null
assert_gate_ran "$mixed_repo"

# --- Case 4: normal push (single update refspec) runs the full gate --------
normal_repo="$TMPDIR/normal"
setup_repo "$normal_repo"
git -C "$normal_repo" checkout -q -b feature
printf 'change\n' > "$normal_repo/src/index.ts"
git -C "$normal_repo" add src/index.ts
git -C "$normal_repo" commit -q -m "change"
write_review_marker "$normal_repo" "feature"
normal_head=$(git -C "$normal_repo" rev-parse HEAD)
run_hook_with_stdin "$normal_repo" \
  "refs/heads/feature $normal_head refs/heads/feature $ZERO_SHA" >/dev/null
assert_gate_ran "$normal_repo"

printf 'PASS: delete-only pushes skip the gate; mixed and normal pushes run it\n'
