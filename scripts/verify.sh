#!/usr/bin/env bash
# Required local verification combines the pre-push lanes and the retained CI
# reference lanes. Hosted Actions is disabled; passing local checks is the gate.
#
# Two guards keep this list honest — edit them together, never let them drift:
#   - scripts/lane-parity.test.ts asserts the `pnpm <script>` set here matches
#     the CI `test` job in .github/workflows/ci.yml (modulo an explicit
#     CI-only / local-only allowlist).
#   - .claude/hooks-tests/verify-script.test.sh asserts every lane the
#     `.hooks/pre-push` gate runs appears here, in the same relative order.
# If either fails, a lane was added to one place without the other — fix the
# lane list, don't weaken the guard.

set -euo pipefail

run_lane() {
  local label=$1
  shift

  printf '==> %s\n' "$label"
  "$@"
}

# The unit lane. A developer's `pnpm verify` runs it plainly. With
# KOOKR_VERIFY_FLAKY_RERUN=1 (the integration train sets it) it applies the
# pre-push hook's flaky policy: when at most five test files fail, re-run only
# those once. A pass continues and is appended to the flaky log shared by every
# worktree (<git common dir>/kookr-flaky-tests.log); a second failure, more
# files, unhandled errors or a crashed worker fail the lane
# (scripts/flaky-rerun-files.mjs lists every case).
unit_tests() {
  if [ "${KOOKR_VERIFY_FLAKY_RERUN:-}" != "1" ]; then
    pnpm test
    return
  fi
  local script_dir report rerun_files log head branch f
  script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
  report=$(mktemp "${TMPDIR:-/tmp}/kookr-verify-vitest.XXXXXX")
  if VITEST_RERUN_SUMMARY_FILE="$report" pnpm test; then
    rm -f "$report"
    return 0
  fi
  rerun_files=$(node "$script_dir/flaky-rerun-files.mjs" "$report" --max-files 5) || rerun_files=""
  rm -f "$report"
  [ -n "$rerun_files" ] || return 1
  set --
  while IFS= read -r f; do
    [ -n "$f" ] && set -- "$@" "$f"
  done <<< "$rerun_files"
  echo ""
  echo "[verify] $# test file(s) failed; re-running only those once to tell a flake from a real failure:"
  printf '  %s\n' "$@"
  pnpm exec vitest run "$@" || return 1
  log="$(git rev-parse --git-common-dir 2>/dev/null)/kookr-flaky-tests.log"
  head=$(git rev-parse HEAD 2>/dev/null || echo unknown)
  branch=$(git symbolic-ref --short HEAD 2>/dev/null || echo detached)
  for f in "$@"; do
    printf '%s\t%s\t%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$branch" "$head" "$f" >> "$log" 2>/dev/null || true
  done
  echo "[verify] FLAKY: the file(s) above failed in the full run and passed on re-run. Logged to $log."
}

# Train mode: KOOKR_VERIFY_FLAKY_RERUN=1, which the integration train sets
# (scripts/integration-train.ts). Besides the flaky re-run above it changes two
# things, and never what is checked (issue #3794):
#   - each test gets a 60 s timeout instead of 15 s (KOOKR_VITEST_TEST_TIMEOUT_MS,
#     read by vitest.config.mts). The timeout is there to catch hangs; a loaded
#     host should not turn a slow test red, and the train has its own cap.
#   - lanes that do not depend on each other run at the same time (see below).
# A developer's plain `pnpm verify` keeps the sequential order.
train_mode() {
  [ "${KOOKR_VERIFY_FLAKY_RERUN:-}" = "1" ]
}

# --- Lanes shared with the pre-push gate (same relative order) --------------
static_checks() {
  run_lane "Type-checking server" pnpm build:server
  run_lane "Type-checking E2E tests" pnpm check:e2e
  run_lane "Checking for import cycles" pnpm check:cycles
  run_lane "Validating skill frontmatter" pnpm validate:skills
  run_lane "Validating bundled playbooks parse" pnpm validate:playbooks
  run_lane "Validating documented commands" pnpm validate:docs-commands
  run_lane "Validating rerun-bound docs" pnpm validate:rerun-bound
  run_lane "Rehearsing delivery-ownership invariant" pnpm validate:delivery-ownership
  run_lane "Rehearsing parent-implementer fallback" pnpm validate:parent-fallback
  run_lane "Validating documented environment variables" pnpm validate:docs-env-vars
  run_lane "Validating documented API routes" pnpm validate:docs-api-routes
  run_lane "Validating requirements status matrix" pnpm validate:requirements
}
unit_lane() { run_lane "Running tests" unit_tests; }
integration_lane() { run_lane "Running self-contained integration tests" pnpm test:integration; }
faa_lane() { run_lane "Checking FAA mitigation evidence" pnpm check:faa-gate; }

# --- Retained CI reference lanes not on the pre-push hot path --------------
smoke_lane() { run_lane "Running local-only smoke gates" pnpm test:smoke; }
hooks_lane() { run_lane "Running hook regression tests" pnpm test:hooks; }
stt_lane() { run_lane "Running stt sidecar tests" pnpm test:stt; }

# run_concurrently <function>... runs each lane function in the background with
# its output in its own file, waits for all of them, then prints the outputs:
# passing lanes first, failing ones last, so the tail of the log (what the train
# quotes in an issue comment) shows the failure. Returns the exit status of the
# first failing lane in argument order, or 0.
run_concurrently() {
  local dir fn i status=0
  local -a pids=() codes=()
  dir=$(mktemp -d "${TMPDIR:-/tmp}/kookr-verify-lanes.XXXXXX")
  printf '==> Running concurrently: %s\n' "$*"
  for fn in "$@"; do
    ( set -e; "$fn" ) > "$dir/$fn.log" 2>&1 &
    pids+=("$!")
  done
  for i in "${!pids[@]}"; do
    codes[i]=0
    wait "${pids[i]}" || codes[i]=$?
  done
  i=0
  for fn in "$@"; do
    [ "${codes[i]}" -eq 0 ] && cat "$dir/$fn.log"
    i=$((i + 1))
  done
  i=0
  for fn in "$@"; do
    if [ "${codes[i]}" -ne 0 ]; then
      cat "$dir/$fn.log"
      printf '==> FAILED (exit %s): %s\n' "${codes[i]}" "$fn"
      [ "$status" -ne 0 ] || status=${codes[i]}
    fi
    i=$((i + 1))
  done
  rm -rf "$dir"
  return "$status"
}

if train_mode; then
  export KOOKR_VITEST_TEST_TIMEOUT_MS="${KOOKR_VITEST_TEST_TIMEOUT_MS:-60000}"
  # The unit suite runs beside the lanes that start no root-config Vitest: the
  # static checks, the hook tests and the STT sidecar (its own Vitest project,
  # without the root global setup). test:integration and test:smoke stay after
  # it, because the root global setup's teardown reaps every test-suite relay
  # and dtach master on the host (test/*-reaper.global.ts), including ones a
  # concurrent unit run is still using.
  run_concurrently static_checks unit_lane hooks_lane stt_lane
  integration_lane
  faa_lane
  smoke_lane
else
  static_checks
  unit_lane
  integration_lane
  faa_lane
  smoke_lane
  hooks_lane
  stt_lane
fi
