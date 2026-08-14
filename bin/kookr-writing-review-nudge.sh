#!/usr/bin/env bash
# Soft deny-once reminder on human-facing publish commands for isolated
# Grok sessions (kookr-ai/kookr#2455, #2461). Not a hard gate: the first
# attempt is denied with instructions; a retry in the same session is
# allowed even if the agent ignores the reminder.
#
# Matches `gh pr create`, `gh issue create`, control-room post-message,
# Discord webhook posts, and last-synthesis.md writes. Isolated GROK_HOME
# never runs the operator's Claude user hooks, so this launch-scoped
# script is the reminder those sessions actually see.
#
# Accepts both Grok camelCase (`toolInput.command`, `sessionId`) and Claude
# snake_case (`tool_input.command`, `session_id`) payloads. Fail-open on any
# parse/IO error so a broken reminder never blocks a publish.
set -u

fail_open() {
  exit 0
}

INPUT=$(cat) || fail_open
if [ -z "${INPUT}" ]; then
  exit 0
fi

COMMAND=$(
  printf '%s' "$INPUT" | jq -r '.toolInput.command // .tool_input.command // empty' 2>/dev/null
) || fail_open
if [ -z "$COMMAND" ]; then
  exit 0
fi
# Publish paths for issue #2461. last-synthesis.md only with a write shape
# (redirect / tee / cp / mv) so a routine `cat` of yesterday's synthesis
# does not spend the session-wide marker before the real post.
# Discord is webhook posts, not every discord.com/api GET.
if ! printf '%s' "$COMMAND" | grep -qE \
  'control-room/api/post-message|discord\.com/api/webhooks|gh[[:space:]]+pr[[:space:]]+create|gh[[:space:]]+issue[[:space:]]+create|(>>?[[:space:]]*|tee[[:space:]]+|[[:space:]](cp|mv)[[:space:]]+)[^;&|]*last-synthesis\.md'; then
  exit 0
fi

SESSION=$(
  printf '%s' "$INPUT" | jq -r '.sessionId // .session_id // empty' 2>/dev/null
) || SESSION=""
SESSION=$(printf '%s' "$SESSION" | tr -cd 'A-Za-z0-9._-')

# Prefer the isolated Grok home so the marker dies with the session and
# never shares a host-wide /tmp lock across launches.
if [ -n "${GROK_HOME:-}" ]; then
  MARKER_DIR="$GROK_HOME"
  [ -n "$SESSION" ] || SESSION="session"
elif [ -n "$SESSION" ]; then
  MARKER_DIR="${TMPDIR:-/tmp}"
else
  # No session id and no isolated home — fail open rather than lock
  # every unknown payload onto one shared file.
  exit 0
fi

MARKER="${MARKER_DIR}/kookr-writing-review-nudge-${SESSION}"

if [ -f "$MARKER" ]; then
  exit 0
fi
# Record the nudge even if the deny JSON fails to render — otherwise a later
# retry would deny forever.
: >"$MARKER" 2>/dev/null || fail_open

REASON='This is a one-time reminder, not a hard gate — retry the same command after the review. A teammate who last touched this weeks ago must understand the prose without opening the diff or reconstructing it from a metric stack. (1) Load the clear-technical-writing skill (how to lead with intent, not identifiers) if you have not already — ideally before drafting Discord/operator reports, issue bodies, PR bodies, or playbook syntheses. (2) Spawn kookr-toolkit:clear-writing-reviewer on the new/changed prose. For a PR body that is more than a one-line rename, also run the pre-pr-review skill (full PR-body writing check). (3) Apply every finding that makes the prose clearer, including small nits — an edit is cheaper than a later reconstruction. Then retry the same command.'

if ! jq -n --arg r "$REASON" '{
  decision: "deny",
  reason: $r,
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: $r
  }
}'; then
  fail_open
fi
exit 0
