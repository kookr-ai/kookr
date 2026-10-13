#!/usr/bin/env bash
# Tests for plugin/hooks/shared-chrome-notice.sh.
#
# The hook's contract: on an agent's first Chrome tool call, print exactly one
# PostToolUse additionalContext JSON object; stay silent on that agent's later
# Chrome calls; treat each subagent (same session_id, own agent_id) as a
# separate agent; and NEVER block — every failure path exits 0 with no output.

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
HOOK="$REPO_ROOT/plugin/hooks/shared-chrome-notice.sh"
HOOKS_JSON="$REPO_ROOT/plugin/hooks/hooks.json"

PASS=0
FAIL=0

TMP=$(mktemp -d)
trap "rm -rf '$TMP'" EXIT

MARKERS="$TMP/markers"

run_hook() {
  KOOKR_SHARED_CHROME_NOTICE_DIR="$MARKERS" "$HOOK"
}

check() {
  local label="$1"
  shift
  if "$@"; then
    PASS=$((PASS + 1))
    printf 'PASS: %s\n' "$label"
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL: %s\n' "$label" >&2
  fi
}

# Exit 0 with no output: the hook's contract for every failure path.
silent_ok() {
  [ "$1" -eq 0 ] && [ -z "$2" ]
}

# Exactly one JSON value on stdout, shaped as a PostToolUse context injection.
is_one_notice() {
  printf '%s' "$1" | jq -e -s 'length == 1
    and .[0].hookSpecificOutput.hookEventName == "PostToolUse"
    and (.[0].hookSpecificOutput.additionalContext | type == "string")' >/dev/null 2>&1
}

contains() {
  case "$1" in *"$2"*) return 0 ;; *) return 1 ;; esac
}

# payload SESSION_ID [TOOL_NAME] [AGENT_ID]
payload() {
  local tool="${2:-mcp__claude-in-chrome__navigate}"
  if [ -n "${3:-}" ]; then
    printf '{"session_id":"%s","agent_id":"%s","tool_name":"%s","tool_input":{}}' "$1" "$3" "$tool"
  else
    printf '{"session_id":"%s","tool_name":"%s","tool_input":{}}' "$1" "$tool"
  fi
}

# --- registration: the real hooks.json wires this script to Chrome tools only ---

entry=$(jq -c '[.hooks.PostToolUse[]? | select(any(.hooks[]; .command | endswith("/hooks/shared-chrome-notice.sh")))] | first // empty' "$HOOKS_JSON")
check "hooks.json registers the hook under PostToolUse" [ -n "$entry" ]
matcher=$(printf '%s' "$entry" | jq -r '.matcher // empty')
for tool in mcp__claude-in-chrome__navigate mcp__claude-in-chrome__computer mcp__claude-in-chrome__tabs_context_mcp; do
  check "matcher matches $tool" jq -e -n --arg m "$matcher" --arg t "$tool" '$t | test($m)'
done
for tool in Bash mcp__n8n__get_node mcp__claude_ai_Gmail__authenticate; do
  check "matcher does not match $tool" jq -e -n --arg m "$matcher" --arg t "$tool" '$t | test($m) | not'
done
command_path=$(printf '%s' "$entry" | jq -r '.hooks[0].command' | sed "s|\${CLAUDE_PLUGIN_ROOT}|$REPO_ROOT/plugin|")
check "registered command resolves to an executable" [ -x "$command_path" ]

# --- first call of an agent: one valid notice covering every rule ---

rc=0; out=$(payload sess-a | run_hook) || rc=$?
check "first call exits 0" [ "$rc" -eq 0 ]
check "first call emits exactly one PostToolUse notice" is_one_notice "$out"
text=$(printf '%s' "$out" | jq -r '.hookSpecificOutput.additionalContext' 2>/dev/null || true)
for phrase in 'Shared browser notice' 'Tabs:' 'Sign-ins:' 'Account data:' 'Downloads:' 'Dialogs:' 'stop and report'; do
  check "notice mentions '$phrase'" contains "$text" "$phrase"
done

# --- later calls of the same agent, with any Chrome tool: silent ---

rc=0; out=$(payload sess-a mcp__claude-in-chrome__computer | run_hook) || rc=$?
check "same agent, other Chrome tool, prints nothing" silent_ok "$rc" "$out"

# --- another session, and each subagent, gets its own notice ---

rc=0; out=$(payload sess-b | run_hook) || rc=$?
check "other session gets the notice" is_one_notice "$out"

rc=0; out=$(payload sess-a mcp__claude-in-chrome__navigate agent-1 | run_hook) || rc=$?
check "subagent of a notified session gets its own notice" is_one_notice "$out"
rc=0; out=$(payload sess-a mcp__claude-in-chrome__computer agent-1 | run_hook) || rc=$?
check "same subagent's later call prints nothing" silent_ok "$rc" "$out"
rc=0; out=$(payload sess-a mcp__claude-in-chrome__navigate agent-2 | run_hook) || rc=$?
check "sibling subagent gets its own notice" is_one_notice "$out"

# --- parallel first calls: exactly one notice ---

for i in 1 2 3 4 5; do
  (payload sess-par | run_hook > "$TMP/par-$i.out") &
done
wait
notices=$(cat "$TMP"/par-*.out | grep -c 'hookSpecificOutput' || true)
check "parallel first calls emit exactly one notice" [ "$notices" -eq 1 ]

# --- production default marker directory: per-user, under TMPDIR ---

mkdir -p "$TMP/tmpdir"
rc=0; out=$(payload sess-default | env -u KOOKR_SHARED_CHROME_NOTICE_DIR TMPDIR="$TMP/tmpdir" "$HOOK") || rc=$?
check "default marker dir: notice emitted" is_one_notice "$out"
check "default marker dir: marker is per-user under TMPDIR" [ -d "$TMP/tmpdir/kookr-shared-chrome-notice-$(id -u)/sess-default" ]

# --- failure paths: exit 0, no output ---

rc=0; out=$(run_hook </dev/null) || rc=$?
check "empty stdin exits 0 silently" silent_ok "$rc" "$out"

rc=0; out=$(printf 'not json at all' | run_hook) || rc=$?
check "malformed JSON exits 0 silently" silent_ok "$rc" "$out"

rc=0; out=$(printf '{"tool_input":{}}' | run_hook) || rc=$?
check "payload without session_id exits 0 silently" silent_ok "$rc" "$out"

rc=0; out=$(printf '{"session_id":"a"}{"session_id":"b"}' | run_hook) || rc=$?
check "several JSON values exit 0 silently" silent_ok "$rc" "$out"

# $MARKERS/../escape is $TMP/escape, inside the trap's cleanup.
rc=0; out=$(payload '../escape' | run_hook) || rc=$?
check "path-like session_id exits 0 silently" silent_ok "$rc" "$out"
check "path-like session_id creates nothing outside the marker dir" [ ! -e "$TMP/escape" ]

# A dot is outside the allowed id characters; without the sanitizer this
# agent_id would form a valid directory name and print a notice.
rc=0; out=$(payload sess-x mcp__claude-in-chrome__navigate 'a.b' | run_hook) || rc=$?
check "agent_id outside the allowed characters exits 0 silently" silent_ok "$rc" "$out"

touch "$TMP/not-a-dir"
rc=0; out=$(payload sess-c | KOOKR_SHARED_CHROME_NOTICE_DIR="$TMP/not-a-dir/markers" "$HOOK") || rc=$?
check "unwritable marker dir exits 0 silently" silent_ok "$rc" "$out"

rc=0; out=$(payload sess-d | KOOKR_SHARED_CHROME_NOTICE_SKIP=1 run_hook) || rc=$?
check "KOOKR_SHARED_CHROME_NOTICE_SKIP=1 exits 0 silently" silent_ok "$rc" "$out"

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
