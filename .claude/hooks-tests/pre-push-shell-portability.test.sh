#!/usr/bin/env bash
# Regression tests for the pre-push shell portability gate.
#
# Run: bash .claude/hooks-tests/pre-push-shell-portability.test.sh
# Or:  pnpm test:hooks

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
HOOK="$REPO_ROOT/.hooks/pre-push"
HELPER="$REPO_ROOT/scripts/check-shell-portability.sh"

if [ ! -f "$HOOK" ]; then
  printf 'FAIL: hook not found at %s\n' "$HOOK" >&2
  exit 1
fi
if [ ! -x "$HELPER" ]; then
  printf 'FAIL: helper not found or not executable at %s\n' "$HELPER" >&2
  exit 1
fi

TMPDIR=$(mktemp -d -t pre-push-shell-portability.XXXXXX)
cleanup() {
  rm -rf "$TMPDIR"
}
trap cleanup EXIT

setup_repo() {
  local repo="$1"
  git init -q -b main "$repo"
  git -C "$repo" config user.email "test@example.com"
  git -C "$repo" config user.name "test"
  mkdir -p "$repo/node_modules" "$repo/bin" "$repo/scripts"
  cp "$HELPER" "$repo/scripts/check-shell-portability.sh"
  chmod +x "$repo/scripts/check-shell-portability.sh"
  cat > "$repo/bin/pnpm" <<'PNPM'
#!/usr/bin/env bash
exit 0
PNPM
  chmod +x "$repo/bin/pnpm"
  printf 'base\n' > "$repo/README.md"
  git -C "$repo" add README.md scripts/check-shell-portability.sh
  git -C "$repo" commit -q -m "base"
  git -C "$repo" update-ref refs/remotes/origin/main HEAD
}

write_review_marker() {
  local repo="$1"
  local branch="$2"
  bash "$REPO_ROOT/scripts/write-review-state-marker.sh" \
    --repo-root "$repo" --status approved --specialists "test" --key "$branch" >/dev/null
}

run_hook() {
  local repo="$1"
  shift
  (cd "$repo" && PATH="$repo/bin:$PATH" "$@" bash "$HOOK")
}

expect_rejects_portability() {
  local name="$1"
  local repo="$2"
  local out actual_exit
  out=$(run_hook "$repo" 2>&1) && actual_exit=0 || actual_exit=$?
  if [ "$actual_exit" != 0 ] && printf '%s' "$out" | grep -q 'shell portability check failed'; then
    printf 'PASS: %s\n' "$name"
  else
    printf 'FAIL: %s — expected shell portability rejection, got exit %s\n' "$name" "$actual_exit" >&2
    printf '%s\n' "$out" >&2
    exit 1
  fi
}

expect_allows() {
  local name="$1"
  local repo="$2"
  shift 2
  local out actual_exit
  out=$(run_hook "$repo" "$@" 2>&1) && actual_exit=0 || actual_exit=$?
  if [ "$actual_exit" = 0 ]; then
    printf 'PASS: %s\n' "$name"
  else
    printf 'FAIL: %s — expected hook success, got exit %s\n' "$name" "$actual_exit" >&2
    printf '%s\n' "$out" >&2
    exit 1
  fi
}

hook_repo="$TMPDIR/hook-violation"
setup_repo "$hook_repo"
git -C "$hook_repo" checkout -q -b hook-violation
mkdir -p "$hook_repo/.hooks"
printf '%s %s "$0"\n' 'readlink' '-f' > "$hook_repo/.hooks/pre-push"
git -C "$hook_repo" add .hooks/pre-push
git -C "$hook_repo" commit -q -m "hook violation"
write_review_marker "$hook_repo" "hook-violation"
expect_rejects_portability "extensionless hook violation is blocked" "$hook_repo"

plain_ts_repo="$TMPDIR/plain-ts"
setup_repo "$plain_ts_repo"
git -C "$plain_ts_repo" checkout -q -b plain-ts
mkdir -p "$plain_ts_repo/src"
printf 'export const docs = "spawn point: %s %s /tmp";\n' 'readlink' '-f' > "$plain_ts_repo/src/note.ts"
git -C "$plain_ts_repo" add src/note.ts
git -C "$plain_ts_repo" commit -q -m "plain ts string"
write_review_marker "$plain_ts_repo" "plain-ts"
expect_allows "non-subprocess TypeScript string is ignored" "$plain_ts_repo"

subprocess_ts_repo="$TMPDIR/subprocess-ts"
setup_repo "$subprocess_ts_repo"
git -C "$subprocess_ts_repo" checkout -q -b subprocess-ts
mkdir -p "$subprocess_ts_repo/src"
printf 'import { execSync } from "node:child_process";\nexecSync("%s %s /tmp");\n' 'readlink' '-f' > "$subprocess_ts_repo/src/run.ts"
git -C "$subprocess_ts_repo" add src/run.ts
git -C "$subprocess_ts_repo" commit -q -m "subprocess ts violation"
write_review_marker "$subprocess_ts_repo" "subprocess-ts"
expect_rejects_portability "subprocess TypeScript violation is blocked" "$subprocess_ts_repo"

skip_repo="$TMPDIR/skip-env"
setup_repo "$skip_repo"
git -C "$skip_repo" checkout -q -b skip-env
mkdir -p "$skip_repo/.hooks"
printf '%s %s "$0"\n' 'readlink' '-f' > "$skip_repo/.hooks/pre-push"
git -C "$skip_repo" add .hooks/pre-push
git -C "$skip_repo" commit -q -m "skipped hook violation"
write_review_marker "$skip_repo" "skip-env"
expect_allows "SKIP_PORTABILITY_CHECK bypasses the block" "$skip_repo" env SKIP_PORTABILITY_CHECK=1

no_origin_repo="$TMPDIR/no-origin"
setup_repo "$no_origin_repo"
git -C "$no_origin_repo" update-ref -d refs/remotes/origin/main
mkdir -p "$no_origin_repo/.hooks"
printf '%s %s "$0"\n' 'readlink' '-f' > "$no_origin_repo/.hooks/pre-push"
git -C "$no_origin_repo" add .hooks/pre-push
git -C "$no_origin_repo" commit -q -m "first push hook violation"
write_review_marker "$no_origin_repo" "main"
expect_rejects_portability "missing origin/main scans committed shell files" "$no_origin_repo"

js_repo="$TMPDIR/js-subprocess"
setup_repo "$js_repo"
git -C "$js_repo" checkout -q -b js-subprocess
mkdir -p "$js_repo/src"
printf 'const { execSync } = require("node:child_process");\nexecSync("%s %s /tmp");\n' 'readlink' '-f' > "$js_repo/src/run.js"
git -C "$js_repo" add src/run.js
git -C "$js_repo" commit -q -m "js subprocess violation"
write_review_marker "$js_repo" "js-subprocess"
expect_rejects_portability "subprocess JavaScript violation is blocked" "$js_repo"

printf 'PASS: pre-push shell portability gate selector works\n'
