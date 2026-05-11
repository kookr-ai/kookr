#!/usr/bin/env bash
# OSS Contribution Safety Gate
# Claude Code PreToolUse hook (matcher: Bash)
#
# Enforces:
#   1. Blocked repository list — hard ban on repos with anti-AI policies
#   2. Per-repo daily PR rate limits — default 1 PR/day/repo
#
# Design: fail-open on any error. A crash degrades to no rate limiting.
# See: docs/rfc/rfc-oss-contribution-safety-gates.md

set -euo pipefail

# --- Configuration paths ---
CONFIG_DIR="$HOME/.kookr"
CONFIG_FILE="$CONFIG_DIR/rate-limits.json"
LEDGER_FILE="$CONFIG_DIR/contribution-ledger.jsonl"
HEARTBEAT_FILE="$CONFIG_DIR/gate-heartbeat"
ERROR_LOG="$CONFIG_DIR/hook-errors.log"
LOCKDIR="$CONFIG_DIR/gate.lock"

# --- Fail-open wrapper ---
# If anything goes wrong, allow the command through and log the error.
fail_open() {
  local msg="${1:-unknown error}"
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) ERROR: $msg" >> "$ERROR_LOG" 2>/dev/null || true
  exit 0
}
trap 'fail_open "unexpected crash at line $LINENO"' ERR

# --- Ensure config directory exists ---
mkdir -p "$CONFIG_DIR" 2>/dev/null || fail_open "cannot create $CONFIG_DIR"

# --- Write heartbeat (timestamp overwrite, not ledger append) ---
date -u +%Y-%m-%dT%H:%M:%SZ > "$HEARTBEAT_FILE" 2>/dev/null || true

# --- Read hook input from stdin ---
INPUT=$(cat)

# Extract the command from Claude Code's PreToolUse payload
# Format: {"tool_name": "Bash", "tool_input": {"command": "..."}}
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null) || fail_open "failed to parse input JSON"
CWD=$(echo "$INPUT" | jq -r '.cwd // empty' 2>/dev/null) || true

if [ -z "$COMMAND" ]; then
  # No command to check — allow
  exit 0
fi

# --- Check if this is a PR creation command ---
# Only match `gh pr create` — not curl, not gh api.
# Other bypass vectors are handled by agent instructions, not this hook.
if ! echo "$COMMAND" | grep -qE '\bgh\s+pr\s+create\b'; then
  # Not a PR creation command — allow silently
  exit 0
fi

# --- Extract target repository ---
# Try --repo or -R flag (handles --repo=owner/repo and --repo owner/repo)
REPO=""

repo_from_git_dir() {
  local dir="${1:-}"
  [ -n "$dir" ] || return 1
  [ -d "$dir" ] || return 1

  local remote_url
  remote_url=$(git -C "$dir" remote get-url origin 2>/dev/null) || return 1
  [ -n "$remote_url" ] || return 1

  echo "$remote_url" | sed -E 's#.*github\.com[:/]##; s#\.git$##'
}

# --repo=value or -R=value
REPO=$(echo "$COMMAND" | grep -oP '(?:--repo[= ]|-R[= ])\K[^\s"'"'"']+' 2>/dev/null | head -1) || true

# If no explicit repo flag, try to recover the real repo from an inline `cd`.
# This is common for playbooks launched from Kookr that shell into another repo
# before running `gh pr create`.
if [ -z "$REPO" ]; then
  COMMAND_CWD=$(printf '%s\n' "$COMMAND" | sed -nE 's/.*(^|[;&]|&&|\|\|)[[:space:]]*cd[[:space:]]+["'"'"']?([^"'"'"'[:space:];&|]+)["'"'"']?.*/\2/p' | head -1) || true
  if [ -n "$COMMAND_CWD" ]; then
    if [ "${COMMAND_CWD#/}" = "$COMMAND_CWD" ] && [ -n "$CWD" ] && [ -d "$CWD" ]; then
      COMMAND_CWD=$(cd "$CWD" 2>/dev/null && cd "$COMMAND_CWD" 2>/dev/null && pwd -P) || COMMAND_CWD=""
    fi
    REPO=$(repo_from_git_dir "$COMMAND_CWD") || true
  fi
fi

# Fall back to the session payload CWD only if the command itself didn't tell us.
if [ -z "$REPO" ]; then
  if [ -n "$CWD" ] && [ -d "$CWD" ]; then
    REPO=$(repo_from_git_dir "$CWD") || true
  fi
fi

if [ -z "$REPO" ]; then
  # Can't determine repo — allow with warning
  ENTRY="{\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"repo\":\"unknown\",\"action\":\"pr_allowed\",\"command\":\"$(echo "$COMMAND" | head -c 200 | jq -Rs '.' | sed 's/^"//;s/"$//')\"}"
  echo "$ENTRY" >> "$LEDGER_FILE" 2>/dev/null || true
  fail_open "could not determine target repo from command"
fi

# Normalize repo: strip leading/trailing whitespace, lowercase
REPO=$(echo "$REPO" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')

# --- Load config ---
if [ ! -f "$CONFIG_FILE" ]; then
  # No config file — use defaults (maxPrsPerDay=1, no blocked repos)
  DEFAULT_MAX=1
  BLOCKED_REPOS=""
else
  DEFAULT_MAX=$(jq -r '.defaults.maxPrsPerDay // 1' "$CONFIG_FILE" 2>/dev/null) || DEFAULT_MAX=1
  BLOCKED_REPOS=$(jq -r '.blocked[]? // empty' "$CONFIG_FILE" 2>/dev/null) || BLOCKED_REPOS=""
fi

# --- Check blocked list ---
if [ -n "$BLOCKED_REPOS" ]; then
  while IFS= read -r blocked; do
    blocked_lower=$(echo "$blocked" | tr '[:upper:]' '[:lower:]')
    if [ "$REPO" = "$blocked_lower" ]; then
      # BLOCKED — record in ledger and reject
      ENTRY="{\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"repo\":\"$REPO\",\"action\":\"pr_blocked_blocked_repo\",\"blockReason\":\"Repository is blocked for AI contributions\",\"command\":\"$(echo "$COMMAND" | head -c 200 | jq -Rs '.' | sed 's/^"//;s/"$//')\"}"
      echo "$ENTRY" >> "$LEDGER_FILE" 2>/dev/null || true
      echo "{\"decision\":\"block\",\"reason\":\"Repository $REPO is blocked for AI contributions. This repo has anti-AI-generated-PR policies. Do not submit PRs here.\"}"
      exit 0
    fi
  done <<< "$BLOCKED_REPOS"
fi

# --- Check OSS repo registry (anti-ai / blocked status) ---
# This is the backstop for Codex CLI agents that can't run Phase 0 skill gates.
# Fail-open: if registry is unreadable, proceed (rate-limits.json checks still apply).
if [ -f "$HOME/.kookr/oss-repos.json" ]; then
  REG_ENTRY=$(jq -r --arg repo "$REPO" \
    '(.repos[$repo] // {}) | "\(.status // "unknown")\t\(.note // "")"' \
    "$HOME/.kookr/oss-repos.json" 2>/dev/null || echo "unknown\t")
  REG_STATUS=$(printf '%s' "$REG_ENTRY" | cut -f1)
  if [[ "$REG_STATUS" == "anti-ai" || "$REG_STATUS" == "blocked" ]]; then
    REG_NOTE=$(printf '%s' "$REG_ENTRY" | cut -f2-)
    ENTRY="{\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"repo\":\"$REPO\",\"action\":\"pr_blocked_registry\",\"blockReason\":\"Registry status: ${REG_STATUS}\",\"taskId\":\"${KOOKR_TASK_ID:-unknown}\",\"command\":\"$(echo "$COMMAND" | head -c 200 | jq -Rs '.' | sed 's/^"//;s/"$//')\"}"
    echo "$ENTRY" >> "$LEDGER_FILE" 2>/dev/null || true
    echo "{\"decision\":\"block\",\"reason\":\"Repository $REPO is ${REG_STATUS} in the OSS repo registry. ${REG_NOTE}\"}"
    exit 0
  fi
fi

# --- Get per-repo limit ---
MAX_PRS_PER_DAY="$DEFAULT_MAX"
if [ -f "$CONFIG_FILE" ]; then
  OVERRIDE=$(jq -r ".overrides[\"$REPO\"].maxPrsPerDay // empty" "$CONFIG_FILE" 2>/dev/null) || true
  if [ -n "$OVERRIDE" ]; then
    MAX_PRS_PER_DAY="$OVERRIDE"
  fi
fi

# --- Acquire lock ---
acquire_lock() {
  local attempts=0
  while ! mkdir "$LOCKDIR" 2>/dev/null; do
    attempts=$((attempts + 1))
    if [ $attempts -ge 50 ]; then
      # Stale lock detection: if lockdir is older than 30 seconds, remove it
      if [ -d "$LOCKDIR" ]; then
        local lock_age
        # Portable stat: try GNU format first, then BSD format
        lock_age=$(( $(date +%s) - $(stat -c %Y "$LOCKDIR" 2>/dev/null || stat -f %m "$LOCKDIR" 2>/dev/null || echo 0) ))
        if [ "$lock_age" -gt 30 ]; then
          rmdir "$LOCKDIR" 2>/dev/null || true
          # Loop back to retry mkdir — don't fall through
          continue
        fi
      fi
      return 1  # fail-open: can't acquire lock after 5 seconds
    fi
    sleep 0.1
  done
}
release_lock() { rmdir "$LOCKDIR" 2>/dev/null || true; }

if ! acquire_lock; then
  fail_open "could not acquire lock after 5 seconds"
fi
trap 'release_lock' EXIT

# --- Count today's PRs for this repo ---
TODAY=$(date -u +%Y-%m-%d)

# Count pr_created entries, subtract slot_reset entries
CREATED_COUNT=0
RESET_COUNT=0
if [ -f "$LEDGER_FILE" ]; then
  # Read line by line, skip malformed lines
  while IFS= read -r line; do
    line_date=$(echo "$line" | jq -r '.timestamp // empty' 2>/dev/null | cut -c1-10) || continue
    line_repo=$(echo "$line" | jq -r '.repo // empty' 2>/dev/null) || continue
    line_action=$(echo "$line" | jq -r '.action // empty' 2>/dev/null) || continue

    if [ "$line_date" = "$TODAY" ] && [ "$line_repo" = "$REPO" ]; then
      if [ "$line_action" = "pr_created" ]; then
        CREATED_COUNT=$((CREATED_COUNT + 1))
      elif [ "$line_action" = "slot_reset" ]; then
        RESET_COUNT=$((RESET_COUNT + 1))
      fi
    fi
  done < "$LEDGER_FILE"
fi

EFFECTIVE_COUNT=$((CREATED_COUNT - RESET_COUNT))
if [ "$EFFECTIVE_COUNT" -lt 0 ]; then
  EFFECTIVE_COUNT=0
fi

# --- Check rate limit ---
if [ "$EFFECTIVE_COUNT" -ge "$MAX_PRS_PER_DAY" ]; then
  # RATE LIMITED — record in ledger and reject
  TOMORROW=$(date -u -d "tomorrow" +%Y-%m-%dT00:00:00Z 2>/dev/null || date -u -v+1d +%Y-%m-%dT00:00:00Z 2>/dev/null || echo "tomorrow")
  ENTRY="{\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"repo\":\"$REPO\",\"action\":\"pr_blocked_rate_limit\",\"blockReason\":\"Rate limit exceeded: $EFFECTIVE_COUNT/$MAX_PRS_PER_DAY PRs today\",\"command\":\"$(echo "$COMMAND" | head -c 200 | jq -Rs '.' | sed 's/^"//;s/"$//')\"}"
  echo "$ENTRY" >> "$LEDGER_FILE" 2>/dev/null || true
  release_lock
  echo "{\"decision\":\"block\",\"reason\":\"Rate limit exceeded for $REPO: $EFFECTIVE_COUNT/$MAX_PRS_PER_DAY PRs today. Next slot opens at $TOMORROW. Use 'oss-gate reset $REPO' if the last PR failed and you need to free the slot.\"}"
  exit 0
fi

# --- Cross-hook coordination with pr-workflow-gate ---
# Both hooks run in parallel. If the quality gate's state file doesn't exist,
# the quality gate will block this command. Don't consume a rate-limit slot.
if [ -n "$CWD" ] && [ -d "$CWD" ]; then
  QG_REPO_ROOT=$(git -C "$CWD" rev-parse --show-toplevel 2>/dev/null) || true
  if [ -n "$QG_REPO_ROOT" ]; then
    QG_REPO_NAME=$(basename "$QG_REPO_ROOT")
    QG_BRANCH=$(git -C "$CWD" rev-parse --abbrev-ref HEAD 2>/dev/null) || true
    if [ -n "$QG_BRANCH" ]; then
      QG_SAFE_BRANCH=$(echo "$QG_BRANCH" | tr '/' '-')
      QG_STATE_FILE="/dev/shm/.pr-gate-${QG_REPO_NAME}-${QG_SAFE_BRANCH}-pre-done"
      QG_BYPASS_FILE="/dev/shm/.pr-gate-${QG_REPO_NAME}-${QG_SAFE_BRANCH}-bypass"
      if [ ! -f "$QG_STATE_FILE" ] && [ ! -f "$QG_BYPASS_FILE" ]; then
        # Quality gate will block — skip ledger write to preserve rate-limit slot
        release_lock
        exit 0
      fi
    fi
  fi
fi

# --- ALLOW: record pr_created BEFORE the command runs (accepted tradeoff: over-counting) ---
ENTRY="{\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"repo\":\"$REPO\",\"action\":\"pr_created\",\"command\":\"$(echo "$COMMAND" | head -c 200 | jq -Rs '.' | sed 's/^"//;s/"$//')\"}"
echo "$ENTRY" >> "$LEDGER_FILE" 2>/dev/null || true

release_lock

# Allow — no output, exit 0
exit 0
