#!/usr/bin/env bash
# Stop / SubagentStop hook — nudge the Agent Notebook retrospective once.
#
# Role-agnostic: it fires for every session (no NB_ROLE gate). Delegates to
# nb-retro.mjs, which blocks the first Stop of the session (exit 2) to instruct
# the vote/curate retrospective, then allows subsequent stops (fires once per
# session via a per-session sentinel).
#
# Exit codes pass through from the .mjs: 0 = allow stop, 2 = block with reason.
# Fail-open on a missing node so a session can always end.
set -u

payload=$(cat)

if ! command -v node >/dev/null 2>&1; then
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
printf '%s' "$payload" | node "$SCRIPT_DIR/nb-retro.mjs"
