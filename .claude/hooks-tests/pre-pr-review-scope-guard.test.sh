#!/usr/bin/env bash
# Regression test for issue #1201: pre-pr-review must keep an explicit
# scope guard that surfaces out-of-scope reversions/deletions to the agent
# before PR creation.
#
# Run: bash .claude/hooks-tests/pre-pr-review-scope-guard.test.sh
# Or:  pnpm test:hooks

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
SKILL="$REPO_ROOT/plugin/skills/pre-pr-review/SKILL.md"

if [ ! -f "$SKILL" ]; then
  printf 'FAIL: skill not found at %s\n' "$SKILL" >&2
  exit 1
fi

require_text() {
  local pattern="$1"
  local description="$2"
  if ! grep -Eq "$pattern" "$SKILL"; then
    printf 'FAIL: pre-pr-review scope guard is missing %s\n' "$description" >&2
    exit 1
  fi
}

require_text '^### 4a\. Scope Guard$' 'the Scope Guard section'
require_text 'agent self-check' 'agent-facing framing'
require_text 'BASE_REF=\$\{BASE_REF:-origin/main\}' 'configurable base ref'
require_text 'git diff --name-status "\$BASE_REF"\.\.\.HEAD' 'changed-path inspection'
require_text 'git diff --diff-filter=D --name-only "\$BASE_REF"\.\.\.HEAD' 'deletion inspection'
require_text 'out-of-scope reversions/deletions|Reversions of existing behavior' 'reversion/deletion guidance'
require_text 'Files or directories that do not directly serve the PR goal' 'out-of-goal blocking criterion'
require_text 'Deleted files outside the issue'\''s stated scope' 'out-of-scope deletion criterion'
require_text 'remove them from the branch before creating the PR' 'remove-or-justify remediation'
require_text 'scope guard: clean / flagged' 'output contract status'

printf 'PASS: pre-pr-review includes the pre-PR scope guard\n'
