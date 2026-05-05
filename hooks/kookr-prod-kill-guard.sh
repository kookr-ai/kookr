#!/usr/bin/env bash
# Kookr Prod Kill Guard
# Claude Code PreToolUse hook (matcher: Bash, if: "Bash(*4800*)")
#
# Blocks ad hoc Bash snippets that kill or replace Kookr's stable production
# server on port 4800. Agents should use `pnpm prod:update` or
# `pnpm prod:restart` instead of composing their own lsof/xargs/kill restart.

set -euo pipefail

KOOKR_DIR="${KOOKR_HOOKS_DIR:-$HOME/.kookr}"
ERROR_LOG="$KOOKR_DIR/hook-errors.log"

mkdir -p "$KOOKR_DIR" 2>/dev/null || true

fail_open() {
  local msg="${1:-unknown error}"
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) prod-kill-guard: $msg" \
    >> "$ERROR_LOG" 2>/dev/null || true
  exit 0
}
trap 'fail_open "unexpected crash at line $LINENO"' ERR

emit_deny() {
  local reason="$1"
  jq -n --arg r "$reason" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $r
    }
  }'
  exit 0
}

INPUT=$(cat)
COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null) \
  || fail_open "failed to parse payload JSON"

[ -z "$COMMAND" ] && exit 0

# The installer already narrows this hook to Bash commands containing 4800.
# Keep a defense-in-depth check here so direct script execution is quiet.
printf '%s' "$COMMAND" | grep -q '4800' || exit 0

# Normalize whitespace so multi-line snippets match the same patterns as
# one-liners from hook logs.
COMPACT=$(printf '%s' "$COMMAND" | tr '\n\r\t' '   ')

DENY_REASON="Kookr production port 4800 is protected. Do not run ad hoc lsof/xargs/kill or manual server start commands against prod. Use pnpm prod:update for deploys, or pnpm prod:restart for an intentional restart."

if printf '%s' "$COMPACT" | grep -Eq 'lsof[[:space:]][^|;&]*-t[^|;&]*(:( )?|[[:space:]])4800[^|;&]*[|;&].*\b(xargs[[:space:]][^|;&]*kill|kill)\b'; then
  emit_deny "$DENY_REASON"
fi

if printf '%s' "$COMPACT" | grep -Eq '\bkill\b[^|;&]*\$\([^)]*lsof[^)]*-t[^)]*(:( )?|[[:space:]])4800[^)]*\)'; then
  emit_deny "$DENY_REASON"
fi

if printf '%s' "$COMPACT" | grep -Eq '\bfuser\b[^|;&]*-k[^|;&]*(4800/tcp|[[:space:]]4800\b)'; then
  emit_deny "$DENY_REASON"
fi

if printf '%s' "$COMPACT" | grep -Eq '(^|[[:space:];])((KOOKR_)?PORT=4800[[:space:]]+)?node\b.*(dist/server/start\.js|src/server/(start|index)\.ts)'; then
  emit_deny "$DENY_REASON"
fi

exit 0
