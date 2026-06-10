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

LOG="${KOOKR_SKILL_LOAD_LOG:-$HOME/.claude/kookr-skill-load-log.jsonl}"

payload=$(cat 2>/dev/null) || exit 0
if [ "${#payload}" -gt 65536 ]; then
  exit 0
fi

skill=$(printf '%s' "$payload" | jq -r '.tool_input.skill // empty' 2>/dev/null) || exit 0
[ -n "$skill" ] || exit 0

mkdir -p "$(dirname "$LOG")" 2>/dev/null || exit 0
printf '{"skill":%s,"ts":"%s"}\n' \
  "$(printf '%s' "$skill" | jq -R . 2>/dev/null)" \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$LOG" 2>/dev/null

exit 0
