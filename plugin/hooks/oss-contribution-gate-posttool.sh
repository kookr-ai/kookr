#!/usr/bin/env bash
# OSS Contribution Tracker — PostToolUse capture
# Claude Code + Codex CLI PostToolUse hook (matcher: Bash, filter: gh pr create*)
#
# Runs AFTER `gh pr create` succeeds and captures the created PR into
# ~/.kookr/oss-attempts.json via Kookr's HTTP API.
#
# Design: fire-and-forget. On any failure (bad JSON, no PR URL, HTTP down),
# log and exit 0. Missing captures are recovered by the next UI Refresh
# (which hits `gh pr list --author=@me` authoritatively).
#
# See: docs/rfc/rfc-oss-contribution-tracking.md

set -euo pipefail

CONFIG_DIR="$HOME/.kookr"
ERROR_LOG="$CONFIG_DIR/hook-errors.log"
KOOKR_URL="${KOOKR_API_BASE_URL:-http://localhost:4800}"

fail_open() {
  local msg="${1:-unknown error}"
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [oss-track-posttool] $msg" >> "$ERROR_LOG" 2>/dev/null || true
  exit 0
}
trap 'fail_open "unexpected crash at line $LINENO"' ERR

mkdir -p "$CONFIG_DIR" 2>/dev/null || fail_open "cannot create $CONFIG_DIR"

# --- Read hook payload ---
INPUT=$(cat)

# Claude Code shape: .tool_input.command, .tool_response.stdout
# Codex CLI shape:   .tool_input.command, .tool_response (raw string)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null) || fail_open "failed to parse input JSON"

# Only act on gh pr create commands
if ! echo "$COMMAND" | grep -qE '(^|[[:space:]])gh[[:space:]]+pr[[:space:]]+create([[:space:]]|$)'; then
  exit 0
fi

# Extract stdout; accept both object and raw-string shapes
STDOUT=$(echo "$INPUT" | jq -r '.tool_response.stdout // .tool_response // empty' 2>/dev/null) || fail_open "failed to extract tool_response"
if [ -z "$STDOUT" ]; then
  fail_open "no stdout in tool_response"
fi

# Find the LAST PR URL in stdout (handles chained commands like `git push && gh pr create && gh pr view`)
PR_URL=$(echo "$STDOUT" | grep -oE 'https://github\.com/[^/[:space:]]+/[^/[:space:]]+/pull/[0-9]+' | tail -1 || true)
if [ -z "$PR_URL" ]; then
  fail_open "no PR URL in stdout"
fi

# Parse owner/repo and PR number from the URL
REPO=$(echo "$PR_URL" | sed -E 's|https://github\.com/([^/]+/[^/]+)/pull/[0-9]+|\1|')
PR_NUMBER=$(echo "$PR_URL" | sed -E 's|.*/pull/([0-9]+)$|\1|')

if [ -z "$REPO" ] || [ -z "$PR_NUMBER" ]; then
  fail_open "failed to parse repo/prNumber from URL: $PR_URL"
fi

# Fetch the title + body — best-effort. We parse "Fixes/Closes/Resolves #NNN"
# out of the PR body instead of using the closingIssuesReferences JSON field
# because body is supported by every gh version (including Ubuntu 22.04's
# gh 2.4.0 from apt), while closingIssuesReferences errors with "Unknown JSON
# field" on older installs. Populating ISSUE_NUMBER is what makes the scout's
# (repo, issueNumber) secondary-index dedup work in production (NFM-1 from
# the RFC).
PR_TITLE=""
ISSUE_NUMBER=""
if command -v gh >/dev/null 2>&1; then
  PR_META=$(gh pr view "$PR_URL" --json title,body 2>/dev/null || true)
  if [ -n "$PR_META" ]; then
    PR_TITLE=$(echo "$PR_META" | jq -r '.title // empty' 2>/dev/null || true)
    PR_BODY=$(echo "$PR_META" | jq -r '.body // empty' 2>/dev/null || true)
    # Case-insensitive match on GitHub closing keywords, take the first hit
    ISSUE_NUMBER=$(echo "$PR_BODY" | grep -oiE '\b(fixes|closes|resolves)[[:space:]]+#[0-9]+' | head -1 | grep -oE '[0-9]+$' || true)
  fi
fi

# Build the JSON body safely via jq (escapes quotes/newlines). Omit issueNumber
# entirely when we don't have one, rather than sending null — the server treats
# null as "no linkage" so both paths work, but omission is cleaner.
if [ -n "$ISSUE_NUMBER" ]; then
  BODY=$(jq -n \
    --arg repo "$REPO" \
    --argjson prNumber "$PR_NUMBER" \
    --arg prUrl "$PR_URL" \
    --arg prTitle "$PR_TITLE" \
    --argjson issueNumber "$ISSUE_NUMBER" \
    '{kind: "pr_open", repo: $repo, prNumber: $prNumber, prUrl: $prUrl, prTitle: $prTitle, issueNumber: $issueNumber}')
else
  BODY=$(jq -n \
    --arg repo "$REPO" \
    --argjson prNumber "$PR_NUMBER" \
    --arg prUrl "$PR_URL" \
    --arg prTitle "$PR_TITLE" \
    '{kind: "pr_open", repo: $repo, prNumber: $prNumber, prUrl: $prUrl, prTitle: $prTitle}')
fi

# POST to the Kookr server with a hard 2s timeout
curl -fsS -m 2 -X POST \
  -H "Content-Type: application/json" \
  -d "$BODY" \
  "$KOOKR_URL/api/oss-attempts/events" >/dev/null 2>&1 || fail_open "POST to $KOOKR_URL/api/oss-attempts/events failed"

exit 0
