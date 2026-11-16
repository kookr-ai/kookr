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

# The pnpm stub logs every call. It fails `pnpm exec vitest related ...` when
# RELATED_EXIT is non-zero (writing a rerun summary naming src/flaky.test.ts as
# the failed file when SUMMARY_FAIL=1, the same file the real reporter would
# report), `pnpm exec vitest run ...` (the flaky re-run) when RERUN_EXIT is
# non-zero, `pnpm test:hooks` when HOOKS_EXIT is non-zero, and
# `pnpm validate:docs-env-vars` when ENVVARS_EXIT is non-zero.
#
# setup_repo <repo> <mode> <hookfile> <noorigin>
#   mode: fast (config on origin/main), none (no config), other (prePushGate
#   is not "fast"), missing (no prePushGate key), branch-only (config only on
#   the pushed branch, not on origin/main).
# hooktest: when set, the base commit holds .claude/hooks-tests/x.test.sh, which
#   appends "ran" to $HOOKTEST_LOG and exits with that status.
# fromstaging: origin/staging holds one more commit (src/staged.ts) than
#   origin/main, and the feature branch is cut from it (issue #3995).
#   stagingbehind: origin/staging stays at the base commit while origin/main
#   gains one commit (src/mainonly.ts); the branch is cut from main.
setup_repo() {
  local repo="$1" mode="$2" hookfile="${3:-}" noorigin="${4:-}" hooktest="${5:-}" fromstaging="${6:-}" cfg=""
  git init -q -b main "$repo"
  git -C "$repo" config user.email "test@example.com"
  git -C "$repo" config user.name "test"
  mkdir -p "$repo/node_modules" "$repo/bin"
  cat > "$repo/bin/pnpm" <<'PNPM'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$PNPM_LOG"
case "$*" in
  "exec vitest related "*)
    if [ "${RELATED_EXIT:-0}" -ne 0 ] && [ "${SUMMARY_FAIL:-0}" = 1 ]; then
      printf '{"reason":"failed","unhandledErrors":0,"modules":[{"file":"%s/src/flaky.test.ts","state":"failed"}]}' "$(pwd -P)" > "$VITEST_RERUN_SUMMARY_FILE"
    fi
    exit "${RELATED_EXIT:-0}" ;;
  "exec vitest run "*) exit "${RERUN_EXIT:-0}" ;;
  "test:hooks") exit "${HOOKS_EXIT:-0}" ;;
  "validate:docs-env-vars") exit "${ENVVARS_EXIT:-0}" ;;
esac
exit 0
PNPM
  chmod +x "$repo/bin/pnpm"
  printf 'base\n' > "$repo/README.md"
  git -C "$repo" add README.md
  if [ -n "$hooktest" ]; then
    mkdir -p "$repo/.claude/hooks-tests"
    printf 'echo ran >> "$HOOKTEST_LOG"\nexit %s\n' "$hooktest" > "$repo/.claude/hooks-tests/x.test.sh"
    git -C "$repo" add .claude/hooks-tests/x.test.sh
  fi
  case "$mode" in
    fast) cfg='{ "integrationBranch": "staging", "prePushGate": "fast" }' ;;
    other) cfg='{ "integrationBranch": "staging", "prePushGate": "full" }' ;;
    missing) cfg='{ "integrationBranch": "staging" }' ;;
  esac
  mkdir -p "$repo/.kookr"
  if [ -n "$cfg" ]; then
    printf '%s\n' "$cfg" > "$repo/.kookr/delivery-gate.json"
    git -C "$repo" add .kookr/delivery-gate.json
  fi
  git -C "$repo" commit -q -m "base"
  git -C "$repo" update-ref refs/remotes/origin/main HEAD
  if [ "$fromstaging" = behind ]; then
    git -C "$repo" update-ref refs/remotes/origin/staging HEAD
    mkdir -p "$repo/src"
    printf 'main only\n' > "$repo/src/mainonly.ts"
    git -C "$repo" add src/mainonly.ts
    git -C "$repo" commit -q -m "promoted to main"
    git -C "$repo" update-ref refs/remotes/origin/main HEAD
  elif [ -n "$fromstaging" ]; then
    mkdir -p "$repo/src"
    printf 'staged\n' > "$repo/src/staged.ts"
    git -C "$repo" add src/staged.ts
    git -C "$repo" commit -q -m "waiting on staging"
    git -C "$repo" update-ref refs/remotes/origin/staging HEAD
  fi
  git -C "$repo" checkout -q -b feature
  mkdir -p "$repo/src"
  printf 'code\n' > "$repo/src/index.ts"
  git -C "$repo" add src/index.ts
  if [ "$mode" = "branch-only" ]; then
    printf '{ "integrationBranch": "staging", "prePushGate": "fast" }\n' > "$repo/.kookr/delivery-gate.json"
    git -C "$repo" add .kookr/delivery-gate.json
  fi
  if [ -n "$hookfile" ]; then
    mkdir -p "$repo/$(dirname "$hookfile")"
    printf '#!/bin/bash\n' > "$repo/$hookfile"
    git -C "$repo" add "$hookfile"
  fi
  git -C "$repo" commit -q -m "code"
  bash "$REPO_ROOT/scripts/write-review-state-marker.sh" \
    --repo-root "$repo" --status approved --specialists "test" --key feature >/dev/null
  if [ "$noorigin" = noorigin ]; then
    git -C "$repo" update-ref -d refs/remotes/origin/main
  fi
}

# run_case <name> <mode> <related-exit> [option...] -> sets STATUS, REPO
# options: killswitch, noorigin, hookfile=<path>, hooksfail, summaryfail, rerunfail, envvarsfail,
#          hooktest=<exit status of .claude/hooks-tests/x.test.sh>
run_case() {
  local repo="$TMPDIR/$1" mode="$2" related="$3" opt
  local hookfile="" noorigin="" killswitch="" hooks_exit=0 summary_fail=0 rerun_exit=0 envvars_exit=0 hooktest="" fromstaging=""
  shift 3
  for opt in "$@"; do
    case "$opt" in
      killswitch) killswitch=1 ;;
      noorigin) noorigin=noorigin ;;
      hookfile=*) hookfile="${opt#hookfile=}" ;;
      hooksfail) hooks_exit=1 ;;
      summaryfail) summary_fail=1 ;;
      rerunfail) rerun_exit=1 ;;
      envvarsfail) envvars_exit=1 ;;
      hooktest=*) hooktest="${opt#hooktest=}" ;;
      fromstaging) fromstaging=1 ;;
      stagingbehind) fromstaging=behind ;;
    esac
  done
  mkdir -p "$repo"
  setup_repo "$repo" "$mode" "$hookfile" "$noorigin" "$hooktest" "$fromstaging"
  [ -n "$killswitch" ] && : > "$repo/.git/kookr-full-gate"
  : > "$repo/pnpm.log"
  : > "$repo/hooktest.log"
  STATUS=0
  (cd "$repo" && PNPM_LOG="$repo/pnpm.log" HOOKTEST_LOG="$repo/hooktest.log" RELATED_EXIT="$related" HOOKS_EXIT="$hooks_exit" \
    SUMMARY_FAIL="$summary_fail" RERUN_EXIT="$rerun_exit" ENVVARS_EXIT="$envvars_exit" SKIP_PORTABILITY_CHECK=1 PATH="$repo/bin:$PATH" \
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
grep -Fq "fast gate compares HEAD against origin/main" "$REPO/hook.out" || fail "expected origin/main as the base"
grep -Fxq "validate:docs-env-vars" "$REPO/pnpm.log" || fail "fast mode must run the documented env-var validator (#4061)"
printf 'PASS: fast mode runs related tests only\n'

# 1a. An undocumented env var rejects the push in fast mode before any test
# runs (issue #4061: it used to reach the train's full suite instead).
run_case fast-envvars fast 0 envvarsfail
[ "$STATUS" -ne 0 ] || fail "a failing validate:docs-env-vars must reject the push"
grep -Fq "Push rejected: documented environment-variable validation failed" "$REPO/hook.out" \
  || fail "expected the env-var validator rejection message"
grep -q "^exec vitest related" "$REPO/pnpm.log" && fail "a failed static check must stop the push before the fast gate"
printf 'PASS: an undocumented env var rejects a fast-mode push\n'

# 1b. A branch cut from origin/staging is compared against staging, not main:
# the commit waiting on staging is not part of its diff (issue #3995).
run_case from-staging fast 0 fromstaging
[ "$STATUS" -eq 0 ] || fail "fast gate from staging should pass (status $STATUS)"
grep -Fxq "exec vitest related --run --passWithNoTests src/index.ts" "$REPO/pnpm.log" \
  || fail "expected only the branch's own change, not src/staged.ts, in the related run"
grep -Fq "fast gate compares HEAD against origin/staging" "$REPO/hook.out" || fail "expected origin/staging as the base"
printf 'PASS: a branch cut from staging is compared against staging\n'

# 1c. origin/staging behind origin/main (the branch is cut from main): its older
# merge base is never used, so main's commits are not tested again.
run_case staging-behind fast 0 stagingbehind
[ "$STATUS" -eq 0 ] || fail "fast gate with staging behind main should pass (status $STATUS)"
grep -Fxq "exec vitest related --run --passWithNoTests src/index.ts" "$REPO/pnpm.log" \
  || fail "expected only the branch's own change, not src/mainonly.ts, in the related run"
grep -Fq "fast gate compares HEAD against origin/main" "$REPO/hook.out" || fail "expected origin/main as the base"
printf 'PASS: a staging branch behind main keeps origin/main as the base\n'

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
grep -Fxq "validate:docs-env-vars" "$REPO/pnpm.log" || fail "full mode must run the documented env-var validator (#4061)"
printf 'PASS: no config keeps the full gate\n'

# 4. Kill switch beats the config.
run_case killswitch fast 0 killswitch
[ "$STATUS" -eq 0 ] || fail "kill-switch run should pass with a green stub (status $STATUS)"
grep -Fxq "test" "$REPO/pnpm.log" || fail "kill switch must force the full suite"
grep -q "^exec vitest related" "$REPO/pnpm.log" && fail "kill switch must disable the fast gate"
printf 'PASS: the kill-switch file forces the full gate\n'

# assert_full: the full lanes ran and the fast gate did not.
assert_full() {
  [ "$STATUS" -eq 0 ] || fail "$1: should pass with a green stub (status $STATUS)"
  grep -Fxq "test" "$REPO/pnpm.log" || fail "$1: must run the full suite"
  grep -Fxq "test:integration" "$REPO/pnpm.log" || fail "$1: must run the integration lane"
  grep -q "^exec vitest related" "$REPO/pnpm.log" && fail "$1: must not run the fast gate"
  return 0
}

# 5. The copy on origin/main is the source of truth: a config that exists only
# on the pushed branch must not turn the fast gate on.
run_case branch-only branch-only 0
assert_full "config only on the pushed branch"
printf 'PASS: a config absent from origin/main keeps the full gate\n'

# 6. A prePushGate other than "fast", or no such key, keeps the full gate.
run_case other-mode other 0
assert_full "prePushGate not fast"
run_case missing-key missing 0
assert_full "prePushGate missing"
printf 'PASS: prePushGate other than fast, or missing, keeps the full gate\n'

# 7. A changed hook file runs its own hook test suite, not the whole lane; a
# failing suite rejects (#3816).
run_case hook-suite fast 0 hookfile=hooks/x.sh hooktest=0
[ "$STATUS" -eq 0 ] || fail "fast gate with a passing hook suite should not reject (status $STATUS)"
grep -Fxq "ran" "$REPO/hooktest.log" || fail "expected .claude/hooks-tests/x.test.sh to run for hooks/x.sh"
grep -Fxq "test:hooks" "$REPO/pnpm.log" && fail "a hook change with its own suite must not run the whole lane"
grep -Fq "[fast-gate] selection: ~" "$REPO/hook.out" || fail "expected the one-line selection summary"
run_case hook-suite-fail fast 0 hookfile=hooks/x.sh hooktest=1
[ "$STATUS" -ne 0 ] || fail "a failing hook suite must reject the push"
grep -Fq "Push rejected: fast-gate tests failed" "$REPO/hook.out" || fail "expected the fast-gate rejection message"
printf 'PASS: a hook change runs its own suite, and a failing suite rejects\n'

# 7b. The hook-test runner or a shared helper adds the pnpm test:hooks lane; a
# failing lane rejects.
run_case hooks-lane fast 0 hookfile=scripts/run-hook-tests.sh
[ "$STATUS" -eq 0 ] || fail "fast gate with a passing hook lane should not reject (status $STATUS)"
grep -Fxq "test:hooks" "$REPO/pnpm.log" || fail "expected the hook-test lane for a changed hook runner"
run_case hooks-lane-fail fast 0 hookfile=scripts/lib/x.sh hooksfail
[ "$STATUS" -ne 0 ] || fail "a failing hook-test lane must reject the push"
grep -Fxq "test:hooks" "$REPO/pnpm.log" || fail "expected the hook-test lane to run"
grep -Fq "Push rejected: fast-gate tests failed" "$REPO/hook.out" || fail "expected the fast-gate rejection message"
printf 'PASS: a failing lane command rejects the push\n'

# 8. Related tests fail and the flaky re-run fails too: rejected. A re-run that
# passes lets the push through.
run_case rerun-fail fast 1 summaryfail rerunfail
[ "$STATUS" -ne 0 ] || fail "a related test failing twice must reject the push"
grep -Fxq "exec vitest run src/flaky.test.ts" "$REPO/pnpm.log" || fail "expected the flaky re-run of the failed file"
grep -Fq "Push rejected: fast-gate tests failed" "$REPO/hook.out" || fail "expected the fast-gate rejection message"
run_case rerun-pass fast 1 summaryfail
[ "$STATUS" -eq 0 ] || fail "a flake that passes on re-run should not reject (status $STATUS)"
grep -Fxq "exec vitest run src/flaky.test.ts" "$REPO/pnpm.log" || fail "expected the flaky re-run of the failed file"
printf 'PASS: the fast gate re-runs failed files once\n'

# 9. Fast mode without an origin/main ref has no merge base: full lanes.
run_case no-origin fast 0 noorigin
assert_full "no origin/main ref"
printf 'PASS: no merge base falls back to the full gate\n'
