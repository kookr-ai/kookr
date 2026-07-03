#!/usr/bin/env bash
# Run the local verification lanes in the same order as .hooks/pre-push.

set -euo pipefail

run_lane() {
  local label=$1
  shift

  printf '==> %s\n' "$label"
  "$@"
}

run_lane "Type-checking server" pnpm build:server
run_lane "Type-checking E2E tests" pnpm check:e2e
run_lane "Validating skill frontmatter" pnpm validate:skills
run_lane "Validating documented commands" pnpm validate:docs-commands
run_lane "Validating requirements status matrix" pnpm validate:requirements
run_lane "Running tests" pnpm test
