#!/usr/bin/env bash
# Stop hook — block once while the task owns an actionable delivery step.
# Delegates to delivery-step-stop.mjs (exit 0 = allow, 2 = block with reason).
# Fail-open on a missing node so a session can always end.
set -u
payload=$(cat)
command -v node >/dev/null 2>&1 || exit 0
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
printf '%s' "$payload" | node "$SCRIPT_DIR/delivery-step-stop.mjs"
