#!/usr/bin/env bash
# PR Workflow Gate
# Claude Code PreToolUse hook (matcher: Bash, if: "Bash(gh pr create*)")
#
# Blocks gh pr create unless pre-PR checks have been completed.
# The pre-pr-review skill creates a state file after all checks pass.
# This hook checks for that file and blocks if missing.
#
# It ALSO runs an independent, opt-in "PR checklist gate" (P3,
# rfc-pr-checklist-contract): when enabled (KOOKR_PR_CHECKLIST=1 and/or a
# ~/.kookr/pr-checklist-repos.json scope list), it machine-verifies the PR
# body's anti-drift checklist against the diff via `kookr pr-checklist verify`.
# That gate is default-OFF and fails CLOSED on a real verification failure but
# OPEN (logged) on kookr-internal faults — see the block below.
#
# Design: the pre-PR-review gate fails open on any error (a crash degrades to no
# quality gate). See: docs/rfc/rfc-pr-workflow-hooks.md and
# docs/rfc/rfc-pr-checklist-contract.md.

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
CWD=$(echo "$INPUT" | jq -r '.cwd // empty' 2>/dev/null) || CWD=""

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

worktree_for_branch() {
  local cwd="$1"
  local branch="$2"
  [ -n "$cwd" ] && [ -d "$cwd" ] || return 1

  git -C "$cwd" worktree list --porcelain 2>/dev/null \
    | awk -v target="refs/heads/$branch" '
        /^worktree / { current = substr($0, 10) }
        /^branch / && $2 == target { print current; exit }
      '
}

# Parse -R owner/repo or --repo owner/repo (quotes optional).
REPO_FLAG=$(printf '%s\n' "$COMMAND" | sed -nE 's/.*(-R|--repo)[[:space:]]+"?'"'"'?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+).*/\2/p' | head -1)
if [ -n "$REPO_FLAG" ]; then
  REPO_FLAG=$(strip_quotes "$REPO_FLAG")
  REPO_NAME="${REPO_FLAG#*/}"
fi

# Parse --head [user:]branch (strip user: prefix). Handle the raw command
# substitution form used by the OSS playbooks before the simpler token form;
# otherwise a PreToolUse payload captures only $(gh before the first space.
HEAD_FLAG=$(printf '%s\n' "$COMMAND" | sed -nE 's/.*--head[=[:space:]]+"?\$\([^)]*\):([^"[:space:]]+)"?.*/\1/p' | head -1) || true
if [ -z "$HEAD_FLAG" ]; then
  HEAD_FLAG=$(printf '%s\n' "$COMMAND" | sed -nE 's/.*--head[=[:space:]]+"?'"'"'?([^"'"'"'[:space:]]+).*/\1/p' | head -1) || true
fi
if [ -n "$HEAD_FLAG" ]; then
  HEAD_FLAG=$(strip_quotes "$HEAD_FLAG")
  BRANCH="${HEAD_FLAG##*:}"
  case "$BRANCH" in
    refs/heads/*) BRANCH="${BRANCH#refs/heads/}" ;;
  esac
fi

# Detect file-backed PR bodies separately. Inline bodies do not need a cwd
# lookup, while relative --body-file paths must use a proven worktree.
BODY_FILE_PRESENT=0
if printf '%s\n' "$COMMAND" | grep -qE '(^|[[:space:]])--body-file([=[:space:]])'; then
  BODY_FILE_PRESENT=1
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

# A managed agent can report the launcher checkout as hook cwd while --head
# names a sibling linked worktree. Use Git's worktree registry for the
# checklist engine's cwd; if the mapping cannot be proven, leave it empty so
# the opt-in checklist gate fails open instead of reading another checkout.
CHECKLIST_CWD="$CWD"
if [ -n "$HEAD_FLAG" ] && [ "$BODY_FILE_PRESENT" -eq 1 ]; then
  CHECKLIST_CWD=""
  HEAD_WORKTREE=$(worktree_for_branch "$CWD" "$BRANCH" || true)
  if [ -n "$HEAD_WORKTREE" ]; then
    CHECKLIST_CWD="$HEAD_WORKTREE"
  fi
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

# ===========================================================================
# PR checklist gate (P3 — rfc-pr-checklist-contract). Opt-in, default OFF.
# Machine-verifies the anti-drift checklist markers in the PR body against the
# diff via the shared `kookr pr-checklist` engine. INDEPENDENT of the pre-PR
# review state gate below (its own scope list: pr-checklist-repos.json).
#
# Fail model (S2/S7): fail-CLOSED (deny) on a real verification failure or
# repo-input error (exit 2); fail-OPEN (allow) only on kookr-internal faults
# (missing binary / exit 70 / a bad invocation), always with a visible in-band
# line AND a JSONL degrade record so `kookr pr-checklist doctor` can surface a
# silent long-term fail-open. Every command is if/||-guarded so a stray
# non-zero can't abort the hook via `set -e` mid-gate. (The functions below
# don't inherit the `trap … ERR fail_open` — no `set -E`/errtrace — so an
# unguarded failure would `set -e`-exit nonzero rather than silently allow;
# we guard anyway so exit codes are handled explicitly and intentionally.)
# ===========================================================================
checklist_fail_open() {
  local reason="$1"
  # In-band, visible — never a silent degrade (failure-critic M4).
  echo "kookr pr-checklist: checklist gate degraded (${reason}) — CI is authoritative" >&2
  # Append a JSONL degrade record for `kookr pr-checklist doctor`.
  local ts
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null) || ts="unknown"
  printf '%s' "$reason" \
    | jq -Rc --arg ts "$ts" '{at:$ts,event:"fail-open",reason:.}' \
      >> "$HOME/.kookr/pr-checklist-degrade.log" 2>/dev/null || true
}

checklist_deny() {
  local findings="$1"
  local reason
  reason="PR checklist verification failed — the anti-drift checklist in the PR body does not match the diff. Fix the items, or strike genuinely-N/A boxes with a one-line reason, then retry gh pr create. Details:
${findings}"
  # Fail CLOSED: if jq can't render the reason for any reason, emit a STATIC
  # deny instead — this path must never degrade to an empty stdout / allow
  # (failure-critic: `|| true` here would be a fail-open on a fail-closed path).
  if ! jq -n --arg r "$reason" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $r
    }
  }' 2>/dev/null; then
    printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"PR checklist verification failed and the gate could not render the details. Fix the checklist, or strike genuinely-N/A boxes with a reason, then retry gh pr create."}}'
  fi
  exit 0
}

pr_checklist_gate() {
  # --- Bash-side fast-exit BEFORE spawning Node (S3). ---
  # Kill-switch first: KOOKR_PR_CHECKLIST=0 force-disables regardless of scope.
  if [ "${KOOKR_PR_CHECKLIST:-}" = "0" ]; then
    return 0
  fi
  # Enabled iff env opt-in OR the repo is listed in the checklist scope file.
  local enabled=0
  if [ "${KOOKR_PR_CHECKLIST:-}" = "1" ]; then
    enabled=1
  fi
  local cl_scope_file="$HOME/.kookr/pr-checklist-repos.json"
  if [ "$enabled" -eq 0 ] && [ -n "$OWNER_REPO" ] && [ -f "$cl_scope_file" ]; then
    local cl_key cl_in
    cl_key=$(printf '%s' "$OWNER_REPO" | tr '[:upper:]' '[:lower:]')
    cl_in=$(
      jq --arg k "$cl_key" -r '
        if type == "array" and all(.[]; type == "string")
        then (if ([.[] | ascii_downcase] | index($k)) != null then "in" else "out" end)
        else "out" end
      ' "$cl_scope_file" 2>/dev/null
    ) || cl_in="out"
    if [ "$cl_in" = "in" ]; then
      enabled=1
    fi
  fi
  if [ "$enabled" -ne 1 ]; then
    return 0
  fi

  # --- Binary guard: no kookr on PATH → fail-OPEN with a degrade record. ---
  if ! command -v kookr >/dev/null 2>&1; then
    checklist_fail_open "kookr binary not on PATH"
    return 0
  fi

  # --- Resolve the repo dir to verify (effective linked-worktree cwd). ---
  local cl_cwd="$CHECKLIST_CWD"
  if [ -z "$cl_cwd" ] || [ ! -d "$cl_cwd" ]; then
    checklist_fail_open "effective checklist cwd unavailable — cannot resolve the diff"
    return 0
  fi

  # --- Run the engine. `… || cl_rc=$?` keeps a legitimate non-zero from
  #     aborting the hook via set -e — we branch on the code below, never
  #     let a bare non-zero decide (delivery-critic silent-fail-open bug). ---
  local cl_out cl_rc=0
  cl_out=$(cd "$cl_cwd" && kookr pr-checklist verify \
      --from-command "$COMMAND" --run-commands none 2>&1) || cl_rc=$?

  case "$cl_rc" in
    0)
      # Pass, or attest-unverified (the CLI already printed the degrade note).
      return 0
      ;;
    2)
      # Verification failure or repo-input error → fail CLOSED (deny).
      checklist_deny "$cl_out"
      ;;
    *)
      # 64 (bad invocation) / 70 (internal) / anything else → fail OPEN.
      checklist_fail_open "kookr pr-checklist exited ${cl_rc}"
      return 0
      ;;
  esac
}

pr_checklist_gate

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

# --- Check if pre-PR review was completed (producer-token required, #1968) ---
# A raw `touch /dev/shm/.pr-gate-*-pre-done` is no longer enough: the state
# file must be JSON minted by scripts/write-pr-gate-marker.sh (HMAC token).
if [ -f "$STATE_FILE" ]; then
  AUTH_LIB=""
  # Prefer repo-local auth lib when cwd is a kookr checkout; fall back to the
  # install-hooks symlink target next to this script (user-global install).
  if [ -n "${CWD:-}" ] && [ -d "${CWD:-}" ]; then
    _cwd_root=$(git -C "$CWD" rev-parse --show-toplevel 2>/dev/null || true)
    if [ -n "$_cwd_root" ] && [ -f "$_cwd_root/scripts/lib/review-marker-auth.sh" ]; then
      AUTH_LIB="$_cwd_root/scripts/lib/review-marker-auth.sh"
    fi
  fi
  if [ -z "$AUTH_LIB" ]; then
    _hook_src=$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null || printf '%s' "${BASH_SOURCE[0]}")
    _hook_repo=$(cd "$(dirname "$_hook_src")/.." 2>/dev/null && pwd -P) || _hook_repo=""
    if [ -n "$_hook_repo" ] && [ -f "$_hook_repo/scripts/lib/review-marker-auth.sh" ]; then
      AUTH_LIB="$_hook_repo/scripts/lib/review-marker-auth.sh"
    fi
  fi

  if [ -n "$AUTH_LIB" ]; then
    # shellcheck disable=SC1090
    . "$AUTH_LIB"
    # SAFE_BRANCH already flattened; pr-gate material uses the same key parts.
    if validate_pr_gate_pre_done_file "$STATE_FILE" "$REPO_NAME" "$SAFE_BRANCH"; then
      exit 0
    fi
    # File present but forged / stale / empty — fall through to deny with a
    # specific reason so agents stop touching empty files.
    cat <<'HOOKOUTPUT'
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Pre-PR gate marker is missing a valid producer token (raw touch/forgery is rejected). After pre-pr-review checks pass, run: bash scripts/write-pr-gate-marker.sh — then retry gh pr create. One-time human bypass: touch /dev/shm/.pr-gate-<repo>-<branch>-bypass"
  }
}
HOOKOUTPUT
    exit 0
  fi

  # Auth lib unavailable (non-kookr install without the script tree) — fail
  # open to existence-only check so we do not brick external installs mid-rollout.
  exit 0
fi

# --- BLOCK: pre-PR review not completed ---
cat <<'HOOKOUTPUT'
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Pre-PR review has not been completed for this branch. Run the pre-pr-review skill first (it writes the producer-token gate marker via scripts/write-pr-gate-marker.sh), then retry gh pr create. To exempt this repo from the gate, remove it from ~/.kookr/pr-gated-repos.json (or delete the file to fall back to gate-everything)."
  }
}
HOOKOUTPUT
