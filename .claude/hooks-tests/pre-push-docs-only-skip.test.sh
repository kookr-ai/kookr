#!/usr/bin/env bash
# Regression tests for issue #942: docs-only prose pushes skip TypeScript and
# Vitest lanes, but validators still run and ambiguous diffs stay fail-closed.
#
# Run: bash .claude/hooks-tests/pre-push-docs-only-skip.test.sh
# Or:  pnpm test:hooks

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
HOOK="$REPO_ROOT/.hooks/pre-push"

if [ ! -f "$HOOK" ]; then
  printf 'FAIL: hook not found at %s\n' "$HOOK" >&2
  exit 1
fi

TMPDIR=$(mktemp -d -t pre-push-docs-only-skip.XXXXXX)
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
  printf 'base\n' > "$repo/README.md"
  git -C "$repo" add README.md
  git -C "$repo" commit -q -m "base"
  git -C "$repo" update-ref refs/remotes/origin/main HEAD
}

run_hook() {
  local repo="$1"
  : > "$repo/pnpm.log"
  (cd "$repo" && PNPM_LOG="$repo/pnpm.log" PATH="$repo/bin:$PATH" bash "$HOOK")
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

assert_all_heavy_lanes_run() {
  local repo="$1"
  assert_log_contains "$repo" "build:server"
  assert_log_contains "$repo" "check:e2e"
  assert_log_contains "$repo" "test"
}

assert_validators_run() {
  local repo="$1"
  assert_log_contains "$repo" "validate:skills"
  assert_log_contains "$repo" "validate:docs-commands"
  assert_log_contains "$repo" "validate:requirements"
}

write_review_marker() {
  local repo="$1"
  local branch="$2"
  local head_sha
  head_sha=$(git -C "$repo" rev-parse HEAD)
  mkdir -p "$repo/.review-state"
  printf '{"sha":"%s","status":"approved"}\n' "$head_sha" > "$repo/.review-state/$branch.json"
}

docs_repo="$TMPDIR/docs-only"
mkdir -p "$docs_repo"
setup_repo "$docs_repo"
git -C "$docs_repo" checkout -q -b docs-only
mkdir -p "$docs_repo/docs"
printf 'docs\n' > "$docs_repo/docs/usage.md"
printf 'contributing\n' > "$docs_repo/CONTRIBUTING.md"
git -C "$docs_repo" add docs/usage.md CONTRIBUTING.md
git -C "$docs_repo" commit -q -m "docs"
run_hook "$docs_repo"
assert_validators_run "$docs_repo"
assert_log_absent "$docs_repo" "build:server"
assert_log_absent "$docs_repo" "check:e2e"
assert_log_absent "$docs_repo" "test"

mixed_repo="$TMPDIR/mixed"
mkdir -p "$mixed_repo"
setup_repo "$mixed_repo"
git -C "$mixed_repo" checkout -q -b mixed
mkdir -p "$mixed_repo/docs" "$mixed_repo/src"
printf 'docs\n' > "$mixed_repo/docs/usage.md"
printf 'code\n' > "$mixed_repo/src/index.ts"
git -C "$mixed_repo" add docs/usage.md src/index.ts
git -C "$mixed_repo" commit -q -m "mixed"
write_review_marker "$mixed_repo" "mixed"
run_hook "$mixed_repo"
assert_validators_run "$mixed_repo"
assert_all_heavy_lanes_run "$mixed_repo"

github_repo="$TMPDIR/github-doc"
mkdir -p "$github_repo"
setup_repo "$github_repo"
git -C "$github_repo" checkout -q -b github-doc
mkdir -p "$github_repo/.github"
printf 'template\n' > "$github_repo/.github/pull_request_template.md"
git -C "$github_repo" add .github/pull_request_template.md
git -C "$github_repo" commit -q -m "github doc"
run_hook "$github_repo"
assert_validators_run "$github_repo"
assert_all_heavy_lanes_run "$github_repo"

rename_repo="$TMPDIR/source-rename"
mkdir -p "$rename_repo"
setup_repo "$rename_repo"
mkdir -p "$rename_repo/src"
printf 'code\n' > "$rename_repo/src/index.ts"
git -C "$rename_repo" add src/index.ts
git -C "$rename_repo" commit -q -m "add source"
git -C "$rename_repo" update-ref refs/remotes/origin/main HEAD
git -C "$rename_repo" checkout -q -b source-rename
mkdir -p "$rename_repo/docs"
git -C "$rename_repo" mv src/index.ts docs/index.md
git -C "$rename_repo" commit -q -m "rename source to docs"
write_review_marker "$rename_repo" "source-rename"
run_hook "$rename_repo"
assert_validators_run "$rename_repo"
assert_all_heavy_lanes_run "$rename_repo"

no_origin_repo="$TMPDIR/no-origin"
mkdir -p "$no_origin_repo"
setup_repo "$no_origin_repo"
git -C "$no_origin_repo" update-ref -d refs/remotes/origin/main
mkdir -p "$no_origin_repo/docs"
printf 'docs\n' > "$no_origin_repo/docs/no-origin.md"
git -C "$no_origin_repo" add docs/no-origin.md
git -C "$no_origin_repo" commit -q -m "docs without origin"
run_hook "$no_origin_repo"
assert_validators_run "$no_origin_repo"
assert_all_heavy_lanes_run "$no_origin_repo"

empty_repo="$TMPDIR/empty"
mkdir -p "$empty_repo"
setup_repo "$empty_repo"
run_hook "$empty_repo"
assert_validators_run "$empty_repo"
assert_all_heavy_lanes_run "$empty_repo"

printf 'PASS: docs-only lane skipping stays conservative\n'
