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

# --- Lanes shared with the pre-push gate (same relative order) --------------
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
run_lane "Running tests" unit_tests
run_lane "Running self-contained integration tests" pnpm test:integration
run_lane "Checking FAA mitigation evidence" pnpm check:faa-gate

# --- Retained CI reference lanes not on the pre-push hot path --------------
run_lane "Running local-only smoke gates" pnpm test:smoke
run_lane "Running hook regression tests" pnpm test:hooks
run_lane "Running stt sidecar tests" pnpm test:stt
