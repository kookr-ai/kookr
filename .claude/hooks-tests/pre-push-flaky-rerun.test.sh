#!/usr/bin/env bash
# Regression tests for the pre-push flake re-run: when a few unit-test files
# fail, the hook re-runs only those files once. A pass lets the push through and
# logs the flake; a second failure, too many failed files, or a report that
# names no failed file rejects the push as before.
#
# Run: bash .claude/hooks-tests/pre-push-flaky-rerun.test.sh
# Or:  pnpm test:hooks

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
HOOK="$REPO_ROOT/.hooks/pre-push"

TMPDIR=$(mktemp -d -t pre-push-flaky-rerun.XXXXXX)
cleanup() {
  rm -rf "$TMPDIR"
}
trap cleanup EXIT

# The pnpm stub fails `pnpm test` after writing a Vitest-shaped JSON report that
# marks $FAILED_COUNT files failed, and answers the re-run with $RERUN_EXIT.
setup_repo() {
  local repo="$1"
  git init -q -b main "$repo"
  git -C "$repo" config user.email "test@example.com"
  git -C "$repo" config user.name "test"
  mkdir -p "$repo/node_modules" "$repo/bin"
  cat > "$repo/bin/pnpm" <<'PNPM'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$PNPM_LOG"
if [ "$*" = "test" ]; then
  root=$(pwd -P)
  {
    printf '{"testResults":['
    i=0
    while [ "$i" -lt "${FAILED_COUNT:-0}" ]; do
      [ "$i" -gt 0 ] && printf ','
      printf '{"name":"%s/src/f%s.test.ts","status":"failed"}' "$root" "$i"
      i=$((i + 1))
    done
    printf ']}'
  } > "$VITEST_JSON_REPORT_FILE"
  exit 1
fi
case "$*" in
  "exec vitest run "*) exit "${RERUN_EXIT:-0}" ;;
esac
exit 0
PNPM
  chmod +x "$repo/bin/pnpm"
  printf 'base\n' > "$repo/README.md"
  git -C "$repo" add README.md
  git -C "$repo" commit -q -m "base"
  git -C "$repo" update-ref refs/remotes/origin/main HEAD
  git -C "$repo" checkout -q -b feature
  mkdir -p "$repo/src"
  printf 'code\n' > "$repo/src/index.ts"
  git -C "$repo" add src/index.ts
  git -C "$repo" commit -q -m "code"
  bash "$REPO_ROOT/scripts/write-review-state-marker.sh" \
    --repo-root "$repo" --status approved --specialists "test" --key feature >/dev/null
}

# run_case <name> <failed-count> <rerun-exit> -> sets STATUS, leaves logs in the repo
run_case() {
  local repo="$TMPDIR/$1"
  mkdir -p "$repo"
  setup_repo "$repo"
  : > "$repo/pnpm.log"
  STATUS=0
  (cd "$repo" && PNPM_LOG="$repo/pnpm.log" FAILED_COUNT="$2" RERUN_EXIT="$3" PATH="$repo/bin:$PATH" \
    bash "$HOOK" > "$repo/hook.out" 2>&1) || STATUS=$?
  REPO="$repo"
}

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  printf '%s\n' '--- pnpm.log ---' >&2
  cat "$REPO/pnpm.log" >&2
  printf '%s\n' '--- hook output ---' >&2
  cat "$REPO/hook.out" >&2
  exit 1
}

# 1. Two files fail, both pass on re-run: push proceeds, flake is logged.
run_case flake 2 0
[ "$STATUS" -eq 0 ] || fail "a flake that passes on re-run should not reject the push (status $STATUS)"
grep -Fxq "exec vitest run src/f0.test.ts src/f1.test.ts" "$REPO/pnpm.log" \
  || fail "expected a re-run of exactly the two failed files"
grep -Fq "FLAKY" "$REPO/hook.out" || fail "expected a FLAKY notice"
grep -Fq "src/f1.test.ts" "$REPO/.git/kookr-flaky-tests.log" || fail "expected the flake in the shared log"
grep -Fxq "test:integration" "$REPO/pnpm.log" || fail "later lanes should still run after a flake"
printf 'PASS: a re-run that passes lets the push through and logs the flake\n'

# 2. The re-run fails again: rejected, later lanes do not run.
run_case real-failure 1 1
[ "$STATUS" -ne 0 ] || fail "a file failing twice must reject the push"
grep -Fq "failed again on re-run" "$REPO/hook.out" || fail "expected the re-run rejection message"
grep -Fxq "test:integration" "$REPO/pnpm.log" && fail "integration lane must not run after a real failure"
printf 'PASS: a file that fails again rejects the push\n'

# 3. Too many failed files: rejected without any re-run.
run_case too-many 6 0
[ "$STATUS" -ne 0 ] || fail "six failed files must reject the push"
grep -q "^exec vitest run" "$REPO/pnpm.log" && fail "no re-run expected when too many files failed"
printf 'PASS: more than five failed files rejects without a re-run\n'

# 4. Suite failed but no file is marked failed (error outside tests): rejected.
run_case no-files 0 0
[ "$STATUS" -ne 0 ] || fail "a failed run with no failed file must reject the push"
grep -q "^exec vitest run" "$REPO/pnpm.log" && fail "no re-run expected without failed files"
printf 'PASS: a failure outside any test file rejects without a re-run\n'
