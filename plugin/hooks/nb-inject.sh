#!/usr/bin/env bash
# SessionStart hook — inject the role's Agent Notebook into context.
#
# No-op unless NB_ROLE is set (i.e. the session is running as a specialized
# role). The notebook is injected whole because it is bounded tiny by design,
# so no retrieval is needed. Delegates the work to nb-inject.mjs.
#
# Exit 0 always — a context injector must never block or fail a session start.
set -u

# Nothing to inject for a plain (non-role) session.
[ -n "${NB_ROLE:-}" ] || exit 0

# SessionStart passes an event on stdin; we don't need it, but drain it so the
# pipe never blocks.
cat >/dev/null 2>&1 || true

if ! command -v node >/dev/null 2>&1; then
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
node "$SCRIPT_DIR/nb-inject.mjs" 2>/dev/null || true
exit 0
