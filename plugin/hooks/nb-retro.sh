#!/usr/bin/env bash
# Stop hook — guarantee the Agent Notebook retrospective for a role session.
#
# No-op unless NB_ROLE is set. Delegates to nb-retro.mjs, which blocks the first
# Stop of the session (exit 2) to instruct the vote/curate retrospective, then
# allows subsequent stops (fires once per session).
#
# Exit codes pass through from the .mjs: 0 = allow stop, 2 = block with reason.
# Fail-open on a missing node so a session can always end.
set -u

[ -n "${NB_ROLE:-}" ] || { cat >/dev/null 2>&1 || true; exit 0; }

payload=$(cat)

if ! command -v node >/dev/null 2>&1; then
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
printf '%s' "$payload" | node "$SCRIPT_DIR/nb-retro.mjs"
