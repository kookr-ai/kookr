#!/usr/bin/env bash
# Shared Chrome notice (PostToolUse, matcher: mcp__claude-in-chrome__.*).
#
# Claude in Chrome drives the operator's real Chrome profile, and several
# Kookr agents can drive it at the same time. The extension already gives each
# Claude Code session a private tab group, so the hook does not need to tell
# sessions apart by tab. What agents can still trample is everything else the
# profile shares: sign-ins, the state of the accounts behind them, the
# downloads folder, and modal dialogs. The first time an agent uses a Chrome
# tool, this hook adds a short notice saying so to that agent's context; its
# later Chrome calls stay silent.
#
# "An agent" is a session's main agent or one of its subagents. Subagents share
# their parent's session_id but each has its own context, so the hook tracks
# every (session_id, agent_id) pair separately.
#
# It never blocks a tool call: every failure path exits 0 with no output.

set -u

if [ "${KOOKR_SHARED_CHROME_NOTICE_SKIP:-}" = "1" ]; then
  exit 0
fi

command -v jq >/dev/null 2>&1 || exit 0

# jq reads stdin directly: this runs, and blocks the agent, on every Chrome
# call, and a screenshot payload can be several megabytes.
key=$(jq -r 'select((.session_id // "") != "")
  | .session_id + (if (.agent_id // "") != "" then "-" + .agent_id else "" end)' 2>/dev/null) || exit 0

# Ids are UUID-like. Anything else (a slash, a dot, the newline that several
# JSON values would produce) could escape the marker directory.
case "$key" in
  '' | *[!A-Za-z0-9_-]*) exit 0 ;;
esac

# Per-user default, so on a shared Linux /tmp one user's directory does not
# accidentally lock another user out of the notice.
MARKER_DIR="${KOOKR_SHARED_CHROME_NOTICE_DIR:-${TMPDIR:-/tmp}/kookr-shared-chrome-notice-$(id -u 2>/dev/null)}"
mkdir -p "$MARKER_DIR" 2>/dev/null || exit 0
# mkdir is atomic, so when an agent fires several Chrome tools in parallel,
# exactly one call claims the marker and emits the notice.
mkdir "$MARKER_DIR/$key" 2>/dev/null || exit 0

notice='Shared browser notice (shown once). This Chrome is the operator'"'"'s real profile, and other Kookr agents or the operator may be using it at the same time as you.

- Tabs: each Claude Code session has its own tab group that other sessions cannot see, but subagents share their parent session'"'"'s group. Work only in tabs you opened yourself and always pass their tabId: navigate without a tabId drives the group'"'"'s first tab, which may belong to another agent. Close your tabs before you finish.
- Sign-ins: sites where the operator is signed in see you as the operator. Never log out, switch accounts, or clear cookies or site data; that would sign out the other sessions too.
- Account data: carts, drafts, messages, favorites and settings live on the site'"'"'s server and are shared with any other agent using the same account. Change only what your task requires, and do not delete or overwrite items you did not create.
- Downloads: every agent saves to the same folder. Do not assume the newest file is yours; identify it by its exact name, and pick a distinctive name when the site lets you choose.
- Dialogs: avoid actions that open JavaScript alerts, confirmations or "leave this page?" prompts (for example, a Delete button that asks "Are you sure?"). An open dialog can stop the extension from responding, possibly for every agent.

If your task needs something forbidden above (logging out, switching accounts, deleting existing data), stop and report it to the operator instead of proceeding.'

jq -n --arg ctx "$notice" \
  '{hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: $ctx}}' 2>/dev/null

exit 0
