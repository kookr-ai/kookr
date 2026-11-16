#!/usr/bin/env bash
# Stop hook — a self-continuation chain task must spawn its successor or record
# a stop reason before it ends its turn (issue #3678).
# Delegates to chain-handoff-stop.mjs (exit 0 = allow, 2 = block with reason).
# Fail-open on a missing node so a session can always end.
set -u
payload=$(cat)
command -v node >/dev/null 2>&1 || exit 0
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
printf '%s' "$payload" | node "$SCRIPT_DIR/chain-handoff-stop.mjs"
