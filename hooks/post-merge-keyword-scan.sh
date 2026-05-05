#!/usr/bin/env bash
# Post-merge keyword-scan hook
# Claude Code UserPromptSubmit hook
#
# When the user prompt mentions a merge/pull/rebase keyword, scan open PRs
# in the cwd repo and emit a system-reminder for any with stale-base or
# conflicting state. Helps the agent surface follow-up rebase work
# proactively without being asked.
#
# Design: linear, fail-open, no cookie, no fire log. The transcript itself
# records each fire via the hook_success attachment.
#
# See: docs/rfc/rfc-workflow-continuation-hooks.md

# Linear error handling. No `set -e` — we explicitly check returns and
# fail open on any external-call failure (avoids `gh` exit-0-with-malformed
# JSON corner cases that `trap ERR` would not catch).

mkdir -p "$HOME/.kookr" 2>/dev/null || true
ERR_LOG="$HOME/.kookr/hook-errors.log"

log_err() {
  local msg="${1:-unknown}"
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) ERROR post-merge-keyword-scan: $msg" \
    >> "$ERR_LOG" 2>/dev/null || true
}

# Read stdin payload
INPUT=$(cat)
[ -z "$INPUT" ] && exit 0

PROMPT=$(echo "$INPUT" | jq -r '.prompt // empty' 2>/dev/null)
CWD=$(echo "$INPUT" | jq -r '.cwd // empty' 2>/dev/null)
[ -z "$PROMPT" ] || [ -z "$CWD" ] && exit 0

# Trigger filter — narrow on purpose. Bound false positives to a small set.
if ! echo "$PROMPT" | grep -qiE '\b(merged|merge it|rebased|pulled main|gh pr merge)\b'; then
  exit 0
fi

# Determine repo. Bail if cwd is not a git repo.
REPO_ROOT=$(git -C "$CWD" rev-parse --show-toplevel 2>/dev/null) || exit 0
REPO_NAME=$(basename "$REPO_ROOT")

# Fetch open PRs as raw JSON, then filter locally with jq. We do NOT
# delegate the filter to gh's `--jq` flag because that couples the hook's
# correctness to gh-version-specific server-side jq behavior, and makes
# the hook untestable with a simple `gh` shim that only echoes a fixture.
RAW=$(gh pr list \
        --repo "$REPO_ROOT" \
        --limit 200 \
        --state open \
        --json number,headRefName,mergeStateStatus,mergeable,title \
        2>>"$ERR_LOG")

# Empty/null input → silent. Defends against gh returning empty stdout
# on auth failure (the gh shim does this for `fail_pr_list`).
if [ -z "$RAW" ] || [ "$RAW" = "null" ]; then
  exit 0
fi

# Filter locally. Excludes UNKNOWN — empirically that is the dominant
# state for any not-recently-polled PR (78% on dify, 37% on n8n) and
# including it would emit reminders for healthy PRs.
PRS=$(echo "$RAW" | jq '[.[] | select(.mergeStateStatus == "BEHIND"
                                   or .mergeStateStatus == "DIRTY"
                                   or .mergeable == "CONFLICTING")]' 2>/dev/null) \
  || { log_err "jq filter failure"; exit 0; }

if [ -z "$PRS" ] || [ "$PRS" = "[]" ]; then
  exit 0
fi

# Format reminder. No truncation; emit all matching PRs.
COUNT=$(echo "$PRS" | jq 'length' 2>/dev/null) || exit 0
[ "$COUNT" = "0" ] && exit 0

LIST=$(echo "$PRS" | jq -r '.[] | "  #\(.number)  \(.headRefName)  \(.mergeStateStatus // "?")"' 2>/dev/null) \
  || { log_err "jq format failure"; exit 0; }

cat <<EOF
<system-reminder>
[hook: post-merge-keyword-scan] You mentioned a merge/pull. ${COUNT} open PR(s) in ${REPO_NAME} need rebase or have conflicts:
${LIST}
Per ~/.claude/CLAUDE.md: rebase them proactively before continuing the current task.
</system-reminder>
EOF
exit 0
