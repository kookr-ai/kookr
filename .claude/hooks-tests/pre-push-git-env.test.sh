#!/usr/bin/env bash
# Regression tests for issue #3647: the pre-push hook clears GIT_DIR,
# GIT_WORK_TREE and GIT_INDEX_FILE before it runs the build/test lanes.
#
# git exports GIT_DIR (and a caller may export the other two) into the hook's
# environment. Without the unset, a test that runs a bare `git init` /
# `git commit` in a temp directory re-inits or commits INTO the pushing
# worktree instead of the temp directory.
#
# Run: bash .claude/hooks-tests/pre-push-git-env.test.sh
# Or:  pnpm test:hooks

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
HOOK="$REPO_ROOT/.hooks/pre-push"

if [ ! -f "$HOOK" ]; then
  printf 'FAIL: hook not found at %s\n' "$HOOK" >&2
  exit 1
fi

# This test sets GIT_* itself; never let the caller's (e.g. an outer pre-push
# run) leak into the setup git calls below.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE

ZERO_SHA="0000000000000000000000000000000000000000"

WORK_DIR=$(mktemp -d)
cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

# A pnpm stub standing in for the lanes. On `test` it behaves like a careless
# test: bare `git init` + `git commit` in a fresh temp dir with no env helper.
# It records the GIT_* vars it saw and where its scratch repo lives.
make_pnpm_stub() {
  local bin="$1"
  mkdir -p "$bin"
  cat > "$bin/pnpm" <<'PNPM'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$PNPM_LOG"
if [ "${1:-}" = "test" ]; then
  env | grep -E '^GIT_(DIR|WORK_TREE|INDEX_FILE)=' > "$STUB_ENV_LOG" || true
  scratch=$(mktemp -d "$STUB_SCRATCH_PARENT/scratch.XXXXXX")
  printf '%s\n' "$scratch" > "$STUB_SCRATCH_LOG"
  cd "$scratch"
  git init -q
  printf 'x\n' > file.txt
  git add file.txt
  git -c user.name=stub -c user.email=stub@example.com -c commit.gpgsign=false commit -q -m "stub init"
fi
exit 0
PNPM
  chmod +x "$bin/pnpm"
}

setup_repo() {
  local repo="$1"
  git init -q -b main "$repo"
  git -C "$repo" config user.email "test@example.com"
  git -C "$repo" config user.name "test"
  mkdir -p "$repo/node_modules" "$repo/src"
  printf 'base\n' > "$repo/README.md"
  printf 'code\n' > "$repo/src/index.ts"
  git -C "$repo" add README.md src/index.ts
  git -C "$repo" commit -q -m "base"
  git -C "$repo" update-ref refs/remotes/origin/main HEAD
}

commit_change() {
  local repo="$1"
  local branch="$2"
  git -C "$repo" checkout -q -b "$branch"
  printf 'change\n' > "$repo/src/index.ts"
  git -C "$repo" add src/index.ts
  git -C "$repo" commit -q -m "change"
}

write_review_marker() {
  local repo="$1"
  local branch="$2"
  bash "$REPO_ROOT/scripts/write-review-state-marker.sh" \
    --repo-root "$repo" --status approved --specialists "test" --key "$branch" >/dev/null
}

# Snapshot of everything a stray init/commit would change in the pushing repo.
repo_snapshot() {
  local worktree="$1"
  {
    git -C "$worktree" rev-parse HEAD
    git -C "$worktree" for-each-ref --format='%(refname) %(objectname)'
    git -C "$worktree" status --porcelain --untracked-files=no
  }
}

# Run the hook as git does: cwd = pushing worktree, GIT_DIR exported, refspec
# on stdin. Pass a non-empty 3rd arg to also export GIT_WORK_TREE and
# GIT_INDEX_FILE (as a caller wrapping `git push` might).
run_hook() {
  local worktree="$1"
  local git_dir="$2"
  local index_file="${3:-}"
  local head
  head=$(git -C "$worktree" rev-parse HEAD)
  : > "$STATE/pnpm.log"
  rm -f "$STATE/env.log" "$STATE/scratch.log"
  (
    cd "$worktree"
    export GIT_DIR="$git_dir"
    if [ -n "$index_file" ]; then
      export GIT_WORK_TREE="$worktree" GIT_INDEX_FILE="$index_file"
    fi
    PNPM_LOG="$STATE/pnpm.log" STUB_ENV_LOG="$STATE/env.log" \
      STUB_SCRATCH_LOG="$STATE/scratch.log" STUB_SCRATCH_PARENT="$WORK_DIR" \
      PATH="$STATE/bin:$PATH" \
      bash "$HOOK" <<<"refs/heads/x $head refs/heads/x $ZERO_SHA"
  )
}

assert_no_leak() {
  local label="$1"
  local worktree="$2"
  local before="$3"
  local after
  after=$(repo_snapshot "$worktree")
  [ "$before" = "$after" ] || {
    printf '%s\n--- before ---\n%s\n--- after ---\n%s\n' "$label" "$before" "$after" >&2
    fail "$label: the stub's git init/commit wrote into the pushing repo"
  }
  grep -Fxq "test" "$STATE/pnpm.log" || fail "$label: test lane never ran (gate did not resolve the repo?)"
  grep -Fxq "build:server" "$STATE/pnpm.log" || fail "$label: build lane never ran"
  [ ! -s "$STATE/env.log" ] || fail "$label: lane inherited $(tr '\n' ' ' < "$STATE/env.log")"
  # Non-vacuity: the stub's commit landed in its own scratch repo.
  [ -s "$STATE/scratch.log" ] || fail "$label: stub did not record its scratch dir"
  local scratch
  scratch=$(cat "$STATE/scratch.log")
  [ -d "$scratch/.git" ] || fail "$label: scratch dir has no .git of its own"
  [ "$(git -C "$scratch" log -1 --format=%s 2>/dev/null)" = "stub init" ] \
    || fail "$label: stub commit did not land in the scratch repo"
}

STATE="$WORK_DIR/state"
mkdir -p "$STATE"
make_pnpm_stub "$STATE/bin"

# --- Case 1: only GIT_DIR exported (what git itself does) --------------------
# Without the unset, the stub's bare `git commit` lands in the pushing repo.
gd_repo="$WORK_DIR/gitdir-only"
setup_repo "$gd_repo"
commit_change "$gd_repo" feature
write_review_marker "$gd_repo" feature
before=$(repo_snapshot "$gd_repo")
run_hook "$gd_repo" "$gd_repo/.git" >/dev/null \
  || fail "GIT_DIR only: hook exited non-zero"
assert_no_leak "GIT_DIR only" "$gd_repo" "$before"

# --- Case 1b: main checkout, all three exported ------------------------------
main_repo="$WORK_DIR/main"
setup_repo "$main_repo"
commit_change "$main_repo" feature
write_review_marker "$main_repo" feature
before=$(repo_snapshot "$main_repo")
run_hook "$main_repo" "$main_repo/.git" "$main_repo/.git/index" >/dev/null \
  || fail "main checkout: hook exited non-zero"
assert_no_leak "main checkout" "$main_repo" "$before"

# --- Case 2: linked worktree, GIT_DIR=<main>/.git/worktrees/<name> -----------
# The hook's own git calls must still resolve the worktree: the review marker
# is written only for the worktree's branch, so a hook that resolved the main
# checkout instead would reject the push.
wt_main="$WORK_DIR/wt-main"
setup_repo "$wt_main"
wt="$WORK_DIR/wt-linked"
git -C "$wt_main" worktree add -q -b wt-branch "$wt" main
printf 'wt change\n' > "$wt/src/index.ts"
git -C "$wt" add src/index.ts
git -C "$wt" commit -q -m "wt change"
mkdir -p "$wt/node_modules"
write_review_marker "$wt" wt-branch
wt_git_dir=$(git -C "$wt" rev-parse --absolute-git-dir)
case "$wt_git_dir" in
  "$wt_main"/.git/worktrees/*) : ;;
  *) fail "setup: unexpected linked-worktree git dir $wt_git_dir" ;;
esac
before_wt=$(repo_snapshot "$wt")
before_main=$(repo_snapshot "$wt_main")
run_hook "$wt" "$wt_git_dir" "$wt_git_dir/index" >/dev/null \
  || fail "linked worktree: hook exited non-zero (hook git calls resolved the wrong repo?)"
assert_no_leak "linked worktree" "$wt" "$before_wt"
[ "$before_main" = "$(repo_snapshot "$wt_main")" ] \
  || fail "linked worktree: the main checkout changed"

printf 'PASS: pre-push lanes run without inherited GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE\n'
