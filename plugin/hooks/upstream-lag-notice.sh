#!/usr/bin/env bash
# SessionStart note (issue #3653). Fetches the remote default branch with a
# short timeout and, when the session's checkout is behind it, tells the agent
# by how many commits and to read code from the remote ref or a fresh worktree.
# See upstream-lag-notice.mjs for the rules.
#
# Exit 0 always — a context note must never block or fail a session start.
# Off with KOOKR_UPSTREAM_LAG_SKIP=1.
set -u

payload=$(cat 2>/dev/null || true)

[ "${KOOKR_UPSTREAM_LAG_SKIP:-}" = "1" ] && exit 0
command -v node >/dev/null 2>&1 || exit 0
command -v git >/dev/null 2>&1 || exit 0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
printf '%s' "$payload" | node "$SCRIPT_DIR/upstream-lag-notice.mjs" 2>/dev/null || true
exit 0
