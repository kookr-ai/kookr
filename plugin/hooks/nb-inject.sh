#!/usr/bin/env bash
# SessionStart hook — inject the Agent Notebook INDEX into context.
#
# Role-agnostic: it injects the `nb list` index (each notebook/shelf and its
# one-line description; grouped by layer when the repo slug is known) for every
# session, and the agent opens the shelves that fit its task. There is no NB_ROLE
# and the hook never opens a shelf for the agent. Delegates the work to
# nb-inject.mjs.
#
# Exit 0 always — a context injector must never block or fail a session start.
set -u

# With `--subagent` (the SubagentStart hook, issue #4231) it prints the short
# notebook contract instead of the index; the event on stdin is passed through so
# the .mjs can read the subagent's agent_type.
#
# SessionStart passes an event on stdin; the index does not need it, but drain it
# so the pipe never blocks.
payload=$(cat 2>/dev/null || true)

if ! command -v node >/dev/null 2>&1; then
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ "${1:-}" = "--subagent" ]; then
  printf '%s' "$payload" | node "$SCRIPT_DIR/nb-inject.mjs" --subagent 2>/dev/null || true
else
  node "$SCRIPT_DIR/nb-inject.mjs" </dev/null 2>/dev/null || true
fi
exit 0
