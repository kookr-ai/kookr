#!/usr/bin/env bash
# Regression tests for the fast pre-push gate (issue #3788): with
# "prePushGate": "fast" in .kookr/delivery-gate.json on origin/main, the hook
# runs only the tests related to the diff and skips `pnpm test` and
# `pnpm test:integration`. Without the config, or with the kill-switch file,
# the full lanes run as before.
#
# Run: bash .claude/hooks-tests/pre-push-fast-gate.test.sh
# Or:  pnpm test:hooks

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
HOOK="$REPO_ROOT/.hooks/pre-push"

TMPDIR=$(mktemp -d -t pre-push-fast-gate.XXXXXX)
cleanup() {
  rm -rf "$TMPDIR"
}
trap cleanup EXIT

# The pnpm stub logs every call and fails `pnpm exec vitest related ...` when
# RELATED_EXIT is non-zero.
setup_repo() {
  local repo="$1" mode="$2"
  git init -q -b main "$repo"
  git -C "$repo" config user.email "test@example.com"
  git -C "$repo" config user.name "test"
  mkdir -p "$repo/node_modules" "$repo/bin"
  cat > "$repo/bin/pnpm" <<'PNPM'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$PNPM_LOG"
case "$*" in
  "exec vitest related "*) exit "${RELATED_EXIT:-0}" ;;
esac
exit 0
PNPM
  chmod +x "$repo/bin/pnpm"
  printf 'base\n' > "$repo/README.md"
  git -C "$repo" add README.md
  if [ "$mode" = "fast" ]; then
    mkdir -p "$repo/.kookr"
    printf '{ "integrationBranch": "staging", "prePushGate": "fast" }\n' > "$repo/.kookr/delivery-gate.json"
    git -C "$repo" add .kookr/delivery-gate.json
  fi
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

# run_case <name> <config-mode: fast|none> <related-exit> [killswitch] -> sets STATUS, REPO
run_case() {
  local repo="$TMPDIR/$1"
  mkdir -p "$repo"
  setup_repo "$repo" "$2"
  [ "${4:-}" = "killswitch" ] && : > "$repo/.git/kookr-full-gate"
  : > "$repo/pnpm.log"
  STATUS=0
  (cd "$repo" && PNPM_LOG="$repo/pnpm.log" RELATED_EXIT="$3" PATH="$repo/bin:$PATH" \
    bash "$HOOK" < /dev/null > "$repo/hook.out" 2>&1) || STATUS=$?
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

# 1. Fast mode: only related tests run; the full and integration lanes do not.
run_case fast fast 0
[ "$STATUS" -eq 0 ] || fail "fast gate with passing related tests should not reject the push (status $STATUS)"
grep -Fxq "exec vitest related --run --passWithNoTests src/index.ts" "$REPO/pnpm.log" \
  || fail "expected one vitest related run over the changed source file"
grep -Fxq "test" "$REPO/pnpm.log" && fail "fast mode must skip the full suite"
grep -Fxq "test:integration" "$REPO/pnpm.log" && fail "fast mode must skip the integration lane"
grep -Fq "Running fast gate" "$REPO/hook.out" || fail "expected the fast-gate banner"
printf 'PASS: fast mode runs related tests only\n'

# 2. Fast mode with failing related tests: rejected.
run_case fast-fail fast 1
[ "$STATUS" -ne 0 ] || fail "failing related tests must reject the push"
grep -Fq "Push rejected: fast-gate tests failed" "$REPO/hook.out" || fail "expected the fast-gate rejection message"
printf 'PASS: failing related tests reject the push\n'

# 3. No config: the full lanes run exactly as before.
run_case full none 0
[ "$STATUS" -eq 0 ] || fail "default mode should pass with a green stub (status $STATUS)"
grep -Fxq "test" "$REPO/pnpm.log" || fail "default mode must run the full suite"
grep -Fxq "test:integration" "$REPO/pnpm.log" || fail "default mode must run the integration lane"
grep -q "^exec vitest related" "$REPO/pnpm.log" && fail "default mode must not run the fast gate"
printf 'PASS: no config keeps the full gate\n'

# 4. Kill switch beats the config.
run_case killswitch fast 0 killswitch
[ "$STATUS" -eq 0 ] || fail "kill-switch run should pass with a green stub (status $STATUS)"
grep -Fxq "test" "$REPO/pnpm.log" || fail "kill switch must force the full suite"
grep -q "^exec vitest related" "$REPO/pnpm.log" && fail "kill switch must disable the fast gate"
printf 'PASS: the kill-switch file forces the full gate\n'
