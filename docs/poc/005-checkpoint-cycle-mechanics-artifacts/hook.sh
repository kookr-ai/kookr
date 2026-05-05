#!/usr/bin/env bash
# POC2 multi-event observer hook.
#
# Logs every hook invocation with timestamp, event name, source/trigger,
# and on first sighting captures the transcript path so we can read token
# usage out-of-band during the session.
#
# Used to validate v5 assumptions about /compact behavior, system-prompt
# survival, and SessionStart(source=compact) firing.

set -euo pipefail

POC_DIR="/tmp/kookr-hook-poc2"
LOG="$POC_DIR/hook.log"
TRANSCRIPT_FILE="$POC_DIR/transcript-path.txt"

INPUT=$(cat)

HOOK_NAME=$(printf '%s' "$INPUT" | jq -r '.hook_event_name // "unknown"' 2>/dev/null || echo "unknown")
SOURCE=$(printf '%s' "$INPUT" | jq -r '.source // ""' 2>/dev/null || echo "")
TRIGGER=$(printf '%s' "$INPUT" | jq -r '.trigger // ""' 2>/dev/null || echo "")
TRANSCRIPT=$(printf '%s' "$INPUT" | jq -r '.transcript_path // ""' 2>/dev/null || echo "")
SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // ""' 2>/dev/null || echo "")

{
  printf '[%s] %s' "$(date -u +%H:%M:%S.%3N)" "$HOOK_NAME"
  [ -n "$SOURCE" ] && printf ' source=%s' "$SOURCE"
  [ -n "$TRIGGER" ] && printf ' trigger=%s' "$TRIGGER"
  [ -n "$SESSION_ID" ] && printf ' session=%s' "${SESSION_ID:0:8}"
  printf '\n'
} >> "$LOG"

# Capture transcript path the first time we see it
if [ -n "$TRANSCRIPT" ] && [ ! -f "$TRANSCRIPT_FILE" ]; then
  echo "$TRANSCRIPT" > "$TRANSCRIPT_FILE"
fi

exit 0
