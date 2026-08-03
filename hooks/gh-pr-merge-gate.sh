#!/usr/bin/env bash
# GH PR Merge Gate (issue #1968)
# Claude Code PreToolUse hook (matcher: Bash, if: "Bash(gh pr merge*)")
#
# Blocks bare `gh pr merge` from autonomous Kookr-managed sessions when the
# independent-review gate is on (KOOKR_MERGE_REQUIRE_REVIEW default on). Agents
# must use `pnpm merge <PR>` / `bash scripts/kookr-merge.sh <PR>`, which enforces
# the independent-merge-review verdict contract (issue #1717).
#
# Scope:
#   - Active only when KOOKR_TASK_ID is set (Kookr-launched agent session).
#   - Disabled when KOOKR_MERGE_REQUIRE_REVIEW is 0/false (manual merges).
#   - Fail-open on parse errors so a hook crash does not brick all Bash.

set -euo pipefail

fail_open() {
  local msg="${1:-unknown error}"
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) ERROR gh-pr-merge-gate: $msg" \
    >> "$HOME/.kookr/hook-errors.log" 2>/dev/null || true
  exit 0
}
trap 'fail_open "unexpected crash at line $LINENO"' ERR

mkdir -p "$HOME/.kookr" 2>/dev/null || true

# --- Only gate Kookr-managed agent sessions --------------------------------
if [ -z "${KOOKR_TASK_ID:-}" ]; then
  exit 0
fi

# --- Align with kookr-merge.sh independent-review kill-switch --------------
require="${KOOKR_MERGE_REQUIRE_REVIEW:-1}"
if [ "$require" = "0" ] || [ "$require" = "false" ]; then
  exit 0
fi

INPUT=$(cat)
COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null) \
  || fail_open "failed to parse input JSON"

if [ -z "$COMMAND" ]; then
  exit 0
fi

# Defense-in-depth — the `if` matcher already filters, but agents compose
# wrappers (`env FOO=1 gh pr merge`, `command gh pr merge`, etc.).
if ! printf '%s' "$COMMAND" | grep -qE '(^|[[:space:];|&])gh[[:space:]]+pr[[:space:]]+merge([[:space:]]|$)'; then
  exit 0
fi

# Allow explicit sanctioned wrappers if an agent somehow inlines them in the
# same Bash tool call (rare; normally pnpm merge is a separate command that
# does not match the `gh pr merge*` if-filter).
if printf '%s' "$COMMAND" | grep -qE '(pnpm[[:space:]]+merge|scripts/kookr-merge\.sh|bash[[:space:]]+[^;|&]*kookr-merge\.sh)'; then
  # Only allow if the gh pr merge is clearly nested inside kookr-merge — not
  # a chained `gh pr merge ... && pnpm merge`. Deny pure bare merges only.
  if printf '%s' "$COMMAND" | grep -qE 'kookr-merge\.sh'; then
    exit 0
  fi
fi

REASON='Bare `gh pr merge` is blocked in Kookr-managed sessions while KOOKR_MERGE_REQUIRE_REVIEW is on. Use `pnpm merge <PR>` (or `bash scripts/kookr-merge.sh <PR>`) so the independent-merge-review verdict is enforced. For a deliberate human-driven merge only: KOOKR_MERGE_REQUIRE_REVIEW=0 gh pr merge ...'

if ! jq -n --arg r "$REASON" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: $r
  }
}' 2>/dev/null; then
  printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Bare gh pr merge is blocked in Kookr sessions. Use pnpm merge instead."}}'
fi
exit 0
