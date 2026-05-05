#!/usr/bin/env bash
# PR Workflow Gate
# Claude Code PreToolUse hook (matcher: Bash, if: "Bash(gh pr create*)")
#
# Blocks gh pr create unless pre-PR checks have been completed.
# The pre-pr-review skill creates a state file after all checks pass.
# This hook checks for that file and blocks if missing.
#
# Design: fail-open on any error. A crash degrades to no quality gate.
# See: docs/rfc/rfc-pr-workflow-hooks.md

set -euo pipefail

STATE_DIR="/dev/shm"

# --- Fail-open wrapper ---
fail_open() {
  local msg="${1:-unknown error}"
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) ERROR pr-workflow-gate: $msg" \
    >> "$HOME/.kookr/hook-errors.log" 2>/dev/null || true
  exit 0
}
trap 'fail_open "unexpected crash at line $LINENO"' ERR

# --- Ensure kookr dir exists for error logging ---
mkdir -p "$HOME/.kookr" 2>/dev/null || true

# --- Read hook input from stdin ---
INPUT=$(cat)

# Extract the command from Claude Code's PreToolUse payload
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null) || fail_open "failed to parse input JSON"

if [ -z "$COMMAND" ]; then
  exit 0
fi

# --- Only match gh pr create (defense-in-depth — the `if` matcher already filters) ---
if ! echo "$COMMAND" | grep -qE '\bgh\s+pr\s+create\b'; then
  exit 0
fi

# --- Determine target repo and branch ---
# Prefer canonical values from the command itself: `-R owner/repo` and `--head [user:]branch`.
# This is correct even when the session cwd differs from the target repo (common when an
# agent runs `cd /path/to/other/repo && gh pr create -R upstream/repo ...`). Falls back to
# session-cwd git detection only when one of the flags is absent (e.g. gh infers both from
# the current dir's remote).
REPO_NAME=""
BRANCH=""

# Strip surrounding single/double quotes from a token
strip_quotes() {
  local s="$1"
  s="${s#\"}"; s="${s%\"}"
  s="${s#\'}"; s="${s%\'}"
  printf '%s' "$s"
}

# Parse -R owner/repo or --repo owner/repo (quotes optional).
REPO_FLAG=$(printf '%s\n' "$COMMAND" | sed -nE 's/.*(-R|--repo)[[:space:]]+"?'"'"'?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+).*/\2/p' | head -1)
if [ -n "$REPO_FLAG" ]; then
  REPO_FLAG=$(strip_quotes "$REPO_FLAG")
  REPO_NAME="${REPO_FLAG#*/}"
fi

# Parse --head [user:]branch (strip user: prefix).
HEAD_FLAG=$(printf '%s\n' "$COMMAND" | sed -nE 's/.*--head[[:space:]]+"?'"'"'?([^"'"'"'[:space:]]+).*/\1/p' | head -1)
if [ -n "$HEAD_FLAG" ]; then
  HEAD_FLAG=$(strip_quotes "$HEAD_FLAG")
  BRANCH="${HEAD_FLAG##*:}"
fi

# Fall back to session-cwd git detection if the command didn't specify both
if [ -z "$REPO_NAME" ] || [ -z "$BRANCH" ]; then
  CWD=$(echo "$INPUT" | jq -r '.cwd // empty' 2>/dev/null) || fail_open "no cwd in payload"

  if [ -z "$CWD" ] || [ ! -d "$CWD" ]; then
    fail_open "cwd is empty or not a directory: $CWD"
  fi

  REPO_ROOT=$(git -C "$CWD" rev-parse --show-toplevel 2>/dev/null) || fail_open "not in a git repo: $CWD"
  [ -z "$REPO_NAME" ] && REPO_NAME=$(basename "$REPO_ROOT")
  [ -z "$BRANCH" ] && { BRANCH=$(git -C "$CWD" rev-parse --abbrev-ref HEAD 2>/dev/null) || fail_open "cannot determine branch"; }
fi

# --- Scope check (issue #405 / rfc-oss-extension-distribution) ---
# Derive the full owner/repo for scope-list lookup. This is SEPARATE from
# REPO_NAME above (a bare repo name used for the state-file key). A
# scope-list entry is always "owner/repo"; if we cannot resolve that, fall
# through to the existing gate-everything behavior rather than silently
# allowing.
OWNER_REPO=""
if [ -n "$REPO_FLAG" ]; then
  # Step 1: -R owner/repo was on the command line — canonical.
  OWNER_REPO="$REPO_FLAG"
elif [ -n "${CWD:-}" ] && [ -d "${CWD:-}" ]; then
  # Step 2: prefer gh's persisted default remote (gh repo set-default).
  RESOLVED_REMOTE=$(
    git -C "$CWD" config --get-regexp '^remote\..*\.gh-resolved$' 2>/dev/null \
      | head -1 \
      | sed -E 's/^remote\.([^.]+)\.gh-resolved .*$/\1/'
  )
  URL=""
  if [ -n "$RESOLVED_REMOTE" ]; then
    URL=$(git -C "$CWD" remote get-url "$RESOLVED_REMOTE" 2>/dev/null || true)
  fi
  # Step 3: fall back to upstream, then origin.
  if [ -z "$URL" ]; then
    URL=$(git -C "$CWD" remote get-url upstream 2>/dev/null || true)
  fi
  if [ -z "$URL" ]; then
    URL=$(git -C "$CWD" remote get-url origin 2>/dev/null || true)
  fi
  if [ -n "$URL" ]; then
    # Parse owner/repo from both git@host:owner/repo(.git)? and
    # https://host/owner/repo(.git)? forms.
    CLEAN_URL="${URL%.git}"
    if [[ "$CLEAN_URL" =~ [:/]([^/:]+)/([^/]+)$ ]]; then
      OWNER_REPO="${BASH_REMATCH[1]}/${BASH_REMATCH[2]}"
    fi
  fi
fi

# Consult the scope list iff we resolved an owner/repo AND the file exists.
# Otherwise the scope check is inconclusive and we fall through to the
# existing state-file / bypass-file gate — preserving "gate everything" as
# the safe default.
SCOPE_LIST_FILE="$HOME/.kookr/pr-gated-repos.json"
if [ -n "$OWNER_REPO" ] && [ -f "$SCOPE_LIST_FILE" ]; then
  OWNER_REPO_LC=$(printf '%s' "$OWNER_REPO" | tr '[:upper:]' '[:lower:]')
  SCOPE_RESULT=$(
    jq --arg k "$OWNER_REPO_LC" -r '
      if type == "array" and all(.[]; type == "string")
      then (if ([.[] | ascii_downcase] | index($k)) != null then "in" else "out" end)
      else "INVALID" end
    ' "$SCOPE_LIST_FILE" 2>/dev/null
  ) || SCOPE_RESULT="INVALID"

  case "$SCOPE_RESULT" in
    out)
      # Out of scope — hook has no opinion on this PR.
      exit 0
      ;;
    in)
      # In scope — fall through to state-file / bypass-file check.
      ;;
    *)
      # Malformed or unreadable — log and fall through to gate-everything.
      echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) ERROR pr-workflow-gate: scope list malformed or unreadable at $SCOPE_LIST_FILE" \
        >> "$HOME/.kookr/hook-errors.log" 2>/dev/null || true
      ;;
  esac
fi

# Sanitize for filename (replace / with -)
SAFE_BRANCH=$(echo "$BRANCH" | tr '/' '-')
STATE_KEY="${REPO_NAME}-${SAFE_BRANCH}"
STATE_FILE="${STATE_DIR}/.pr-gate-${STATE_KEY}-pre-done"

# --- Check for developer bypass file (created manually, not by agent) ---
BYPASS_FILE="${STATE_DIR}/.pr-gate-${STATE_KEY}-bypass"
if [ -f "$BYPASS_FILE" ]; then
  # Consume the bypass (one-time use)
  rm -f "$BYPASS_FILE"
  exit 0
fi

# --- Check if pre-PR review was completed ---
if [ -f "$STATE_FILE" ]; then
  # State file exists — pre-PR review was done. Allow.
  exit 0
fi

# --- BLOCK: pre-PR review not completed ---
cat <<'HOOKOUTPUT'
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Pre-PR review has not been completed for this branch. Run the pre-pr-review skill first, then retry gh pr create. To exempt this repo from the gate, remove it from ~/.kookr/pr-gated-repos.json (or delete the file to fall back to gate-everything)."
  }
}
HOOKOUTPUT
