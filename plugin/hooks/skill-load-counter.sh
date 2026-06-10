#!/usr/bin/env bash
# Append-only skill-load telemetry (PreToolUse, matcher: Skill).
#
# Records which skills actually get invoked so quality-pass scope decisions
# (RFC plugin-skill-improvements, Phases 2-3) can be informed by load data
# instead of guesses. Telemetry must never block a skill invocation: every
# failure path exits 0 silently.

set -u

if [ "${KOOKR_SKILL_LOAD_COUNTER_SKIP:-}" = "1" ]; then
  exit 0
fi

command -v jq >/dev/null 2>&1 || exit 0

LOG="${KOOKR_SKILL_LOAD_LOG:-${HOME:-}/.claude/kookr-skill-load-log.jsonl}"
case "$LOG" in
  /*) ;;
  *) exit 0 ;; # HOME unset and no override — nowhere sane to write
esac

payload=$(cat 2>/dev/null) || exit 0
if [ "${#payload}" -gt 65536 ]; then
  exit 0
fi

mkdir -p "$(dirname "$LOG")" 2>/dev/null || exit 0

# Single jq pass: select guards against a missing/empty skill name, and jq's
# own string encoding handles any content (newlines included) without ever
# emitting a malformed line.
printf '%s' "$payload" | jq -c \
  --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  'select((.tool_input.skill // "") != "") | {skill: .tool_input.skill, ts: $ts}' \
  >> "$LOG" 2>/dev/null

exit 0
