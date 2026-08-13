#!/usr/bin/env bash
# Soft deny-once reminder on `gh pr create` for isolated Grok sessions
# (kookr-ai/kookr#2455). Not a hard gate: the first attempt is denied with
# instructions; a retry in the same session is allowed even if the agent
# ignores the reminder.
#
# Accepts both Grok camelCase (`toolInput.command`, `sessionId`) and Claude
# snake_case (`tool_input.command`, `session_id`) payloads. Fail-open on any
# parse/IO error so a broken reminder never blocks a PR.
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
if ! printf '%s' "$COMMAND" | grep -qE '\bgh[[:space:]]+pr[[:space:]]+create\b'; then
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

REASON='This is a one-time reminder, not a hard gate — retry gh pr create after the review. A teammate who last touched this weeks ago must understand the change without opening the diff. (1) Load the clear-technical-writing skill (how to lead with intent, not identifiers) if you have not already — ideally before drafting docs or the PR body. (2) Spawn kookr-toolkit:clear-writing-reviewer on the new/changed prose. For a PR body that is more than a one-line rename, also run the pre-pr-review skill (full PR-body writing check). (3) Apply every finding that makes the prose clearer, including small nits — an edit is cheaper than a later reconstruction. Then retry gh pr create.'

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
