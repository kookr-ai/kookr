#!/usr/bin/env bash
# Kookr Prod Kill Guard
# Claude Code PreToolUse hook (matcher: Bash)
#
# Blocks ad hoc Bash snippets that kill or replace Kookr's stable production
# server. The protected port follows KOOKR_PORT, then the repo's .env, and
# defaults to 4800. Agents should use `pnpm prod:update` or
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

resolve_guarded_port() {
  local port="${KOOKR_PORT:-}"
  local repo_dir config_dir common_dir env_file line value

  repo_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P) \
    || fail_open "failed to resolve repository directory"
  config_dir="$repo_dir"

  # Feature worktrees do not carry the ignored .env file. Resolve their shared
  # git directory back to the main checkout, which is also where prod-update
  # sources the production configuration.
  common_dir="${KOOKR_GIT_COMMON_DIR:-}"
  if [ -z "$common_dir" ]; then
    common_dir=$(git -C "$repo_dir" rev-parse --git-common-dir 2>/dev/null) \
      || common_dir=""
  fi
  if [ -n "$common_dir" ]; then
    case "$common_dir" in
      /*) ;;
      *) common_dir="$repo_dir/$common_dir" ;;
    esac
    config_dir=$(cd "$(dirname "$common_dir")" && pwd -P) \
      || fail_open "failed to resolve main checkout directory"
  fi
  env_file="$config_dir/.env"

  if [ -z "$port" ] && [ -f "$env_file" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      if [[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?KOOKR_PORT[[:space:]]*= ]]; then
        value="${line#*=}"
        value="${value%%#*}"
        value=$(printf '%s' "$value" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//') \
          || fail_open "failed to parse KOOKR_PORT from .env"
        case "$value" in
          \"*\"|\'*\') value="${value#?}"; value="${value%?}" ;;
        esac
        port="$value"
      fi
    done < "$env_file" || fail_open "failed to read .env"
  fi

  [ -n "$port" ] || port=4800
  if [[ ! "$port" =~ ^[0-9]+$ ]] \
    || [ "${#port}" -gt 5 ] \
    || (( 10#$port < 1 || 10#$port > 65535 )); then
    fail_open "KOOKR_PORT does not identify a fixed valid port"
  fi

  GUARDED_PORT="$((10#$port))"
}

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

GUARDED_PORT=""
resolve_guarded_port

# Keep an exact port check here so direct script execution and unrelated Bash
# commands stay quiet.
printf '%s' "$COMMAND" | grep -Eq "(^|[^0-9])${GUARDED_PORT}([^0-9]|$)" || exit 0

# Normalize whitespace so multi-line snippets match the same patterns as
# one-liners from hook logs.
COMPACT=$(printf '%s' "$COMMAND" | tr '\n\r\t' '   ')

DENY_REASON="Kookr production port ${GUARDED_PORT} is protected. Do not run ad hoc lsof/xargs/kill or manual server start commands against prod. Use pnpm prod:update for deploys, or pnpm prod:restart for an intentional restart."

if printf '%s' "$COMPACT" | grep -Eq "lsof[[:space:]][^|;&]*-t[^|;&]*(:( )?|[[:space:]])${GUARDED_PORT}([[:space:]][^|;&]*)?[|;&].*\\b(xargs[[:space:]][^|;&]*kill|kill)\\b"; then
  emit_deny "$DENY_REASON"
fi

if printf '%s' "$COMPACT" | grep -Eq "\\bkill\\b[^|;&]*\\\$\\([^)]*lsof[^)]*-t[^)]*(:( )?|[[:space:]])${GUARDED_PORT}([[:space:]][^)]*)?\\)"; then
  emit_deny "$DENY_REASON"
fi

if printf '%s' "$COMPACT" | grep -Eq "\\bfuser\\b[^|;&]*-k[^|;&]*(${GUARDED_PORT}/tcp|[[:space:]]${GUARDED_PORT}([^0-9]|$))"; then
  emit_deny "$DENY_REASON"
fi

if printf '%s' "$COMPACT" | grep -Eq "(^|[[:space:];])((KOOKR_)?PORT=${GUARDED_PORT}[[:space:]]+)?node\\b.*(dist/server/start\\.js|src/server/(start|index)\\.ts)"; then
  emit_deny "$DENY_REASON"
fi

exit 0
