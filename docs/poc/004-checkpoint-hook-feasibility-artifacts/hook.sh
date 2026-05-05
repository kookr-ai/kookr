#!/usr/bin/env bash
# PreToolUse hook for Kookr checkpointing POC.
#
# Modes (read from state.json):
#   t1 — allow all (control / baseline)
#   t2 — block first non-Write tool, ask agent to use Write to create
#        /tmp/kookr-hook-poc/acknowledge.txt. Tests whether hook feedback
#        messages reliably steer agent behavior.
#   t3 — block first tool, ask agent to run /compact. Tests whether agent
#        can invoke a slash command from within a turn.
#
# Every invocation is logged to /tmp/kookr-hook-poc/hook.log for later review.
# Every invocation increments state.json's call_count.

set -euo pipefail

POC_DIR="/tmp/kookr-hook-poc"
LOG="$POC_DIR/hook.log"
STATE="$POC_DIR/state.json"

# --- 1. Read and log payload ------------------------------------------------

INPUT=$(cat)
TOOL_NAME=$(printf '%s' "$INPUT" | jq -r '.tool_name // "unknown"' 2>/dev/null || echo "unknown")
SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // "unknown"' 2>/dev/null || echo "unknown")

MODE=$(jq -r '.mode // "t1"' "$STATE" 2>/dev/null || echo "t1")
COUNT=$(jq -r '.call_count // 0' "$STATE" 2>/dev/null || echo 0)
NEW_COUNT=$((COUNT + 1))

# Atomic-ish state update.
jq -n --arg mode "$MODE" --argjson count "$NEW_COUNT" \
  '{mode: $mode, call_count: $count}' > "$STATE.tmp" && mv "$STATE.tmp" "$STATE"

{
  printf '[%s] mode=%s call=%d tool=%s session=%s\n' \
    "$(date -u +%H:%M:%S)" "$MODE" "$NEW_COUNT" "$TOOL_NAME" "${SESSION_ID:0:8}"
  printf '  input_preview: %s\n' \
    "$(printf '%s' "$INPUT" | jq -c '.tool_input // null' 2>/dev/null | head -c 200)"
} >> "$LOG"

# --- 2. Mode dispatch -------------------------------------------------------

case "$MODE" in
  t1)
    # Control: allow everything.
    exit 0
    ;;

  t2)
    # Block first non-Write call with an instruction to Write a file first.
    # Once call_count > 1, allow everything. This lets the agent satisfy the
    # block by issuing Write → the next call passes through.
    if [ "$NEW_COUNT" -eq 1 ] && [ "$TOOL_NAME" != "Write" ]; then
      printf '  -> DENY (t2: steer via Write instruction)\n' >> "$LOG"
      jq -n '{
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "POC TEST T2: Before using any tool, you MUST first use the Write tool to create a file at /tmp/kookr-hook-poc/acknowledge.txt with contents \"acknowledged\". This is a test of whether hook feedback reliably steers agent behavior. After you create that file, subsequent tool calls will be allowed."
        }
      }'
      exit 0
    fi
    exit 0
    ;;

  t3)
    # Block first tool call with an instruction to run /compact.
    # Tests whether the agent can invoke a slash command from its turn.
    if [ "$NEW_COUNT" -eq 1 ]; then
      printf '  -> DENY (t3: request /compact)\n' >> "$LOG"
      jq -n '{
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "POC TEST T3: Context window is at 80% of the 200000 limit. Before you may use any more tools, please run the /compact command to summarize the session. This is a test of whether an agent can invoke a slash command from within a turn. Once /compact completes, tool calls will be allowed again."
        }
      }'
      exit 0
    fi
    exit 0
    ;;

  *)
    exit 0
    ;;
esac
