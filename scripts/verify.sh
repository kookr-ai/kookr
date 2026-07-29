#!/usr/bin/env bash
# Local mirror of the CI + pre-push verification lanes, so `pnpm verify` green
# implies both `.hooks/pre-push` green and CI green.
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

# --- Lanes shared with the pre-push gate (same relative order) --------------
run_lane "Type-checking server" pnpm build:server
run_lane "Type-checking E2E tests" pnpm check:e2e
run_lane "Validating skill frontmatter" pnpm validate:skills
run_lane "Validating bundled playbooks parse" pnpm validate:playbooks
run_lane "Validating documented commands" pnpm validate:docs-commands
run_lane "Validating rerun-bound docs" pnpm validate:rerun-bound
run_lane "Rehearsing delivery-ownership invariant" pnpm validate:delivery-ownership
run_lane "Rehearsing parent-implementer fallback" pnpm validate:parent-fallback
run_lane "Validating documented environment variables" pnpm validate:docs-env-vars
run_lane "Validating requirements status matrix" pnpm validate:requirements
run_lane "Running tests" pnpm test

# --- CI lanes not on the pre-push hot path (kept local so verify == CI) -----
run_lane "Running local-only smoke gates" pnpm test:smoke
run_lane "Running hook regression tests" pnpm test:hooks
run_lane "Running stt sidecar tests" pnpm test:stt
