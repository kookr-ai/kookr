#!/usr/bin/env bash
# SessionStart hook — inject the Agent Notebook INDEX into context.
#
# Role-agnostic: it injects `nb list` (every notebook/shelf and its one-line
# description) for every session, and the agent opens the shelves that fit its
# task. There is no NB_ROLE and nothing guesses a per-repo shelf. Delegates the
# work to nb-inject.mjs.
#
# Exit 0 always — a context injector must never block or fail a session start.
set -u

# SessionStart passes an event on stdin; we don't need it, but drain it so the
# pipe never blocks.
cat >/dev/null 2>&1 || true

if ! command -v node >/dev/null 2>&1; then
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
node "$SCRIPT_DIR/nb-inject.mjs" 2>/dev/null || true
exit 0
