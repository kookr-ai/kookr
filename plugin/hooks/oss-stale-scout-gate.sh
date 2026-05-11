#!/usr/bin/env bash
# OSS Stale-Scout Gate
# Claude Code PreToolUse hook (matcher: Bash, if: "Bash(gh pr create*)")
#
# Blocks `gh pr create` when the PR body references an already-closed
# upstream GitHub issue via any closing keyword (close/closed/closes/
# fix/fixed/fixes/resolve/resolved/resolves #NNN). Closes the gap
# between scout-time and push-time for autonomous OSS contributions.
#
# Design: fail-open on parse/network errors, BUT still block on
# confirmed-closed-with-unknown-closing-PR. A crash degrades to no
# stale-scout enforcement, never to a blocked legitimate push.
#
# See: docs/rfc/rfc-oss-stale-scout-gate.md

set -euo pipefail

KOOKR_DIR="${KOOKR_HOOKS_DIR:-$HOME/.kookr}"
LEDGER_FILE="$KOOKR_DIR/contribution-ledger.jsonl"
ERROR_LOG="$KOOKR_DIR/hook-errors.log"
STATE_DIR="/dev/shm"
GH_BIN="${GH_BIN:-gh}"
REST_TIMEOUT="${STALE_SCOUT_REST_TIMEOUT:-5}"
AUTH_TIMEOUT="${STALE_SCOUT_AUTH_TIMEOUT:-2}"
PR_LIST_TIMEOUT="${STALE_SCOUT_PR_LIST_TIMEOUT:-3}"

mkdir -p "$KOOKR_DIR" 2>/dev/null || true

fail_open() {
  local msg="${1:-unknown error}"
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) stale-scout-gate: $msg" \
    >> "$ERROR_LOG" 2>/dev/null || true
  exit 0
}
trap 'fail_open "unexpected crash at line $LINENO"' ERR

log_warning() {
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) stale-scout-gate WARNING: $*" \
    >> "$ERROR_LOG" 2>/dev/null || true
}

# --- Ledger writes (append one JSONL entry) ---
ledger_append() {
  local action="$1"
  local issue="$2"
  local closing_pr="$3"
  local closing_pr_merged_at="$4"
  local state_reason="$5"
  local repo="$6"
  local cmd_snippet
  cmd_snippet=$(printf '%s' "$COMMAND" | head -c 200 | jq -Rs '.')
  local closing_pr_json="null"
  [ -n "$closing_pr" ] && closing_pr_json="$closing_pr"
  local closing_pr_merged_at_json="null"
  [ -n "$closing_pr_merged_at" ] && closing_pr_merged_at_json="$(printf '%s' "$closing_pr_merged_at" | jq -Rs '.')"
  local state_reason_json="null"
  [ -n "$state_reason" ] && state_reason_json="$(printf '%s' "$state_reason" | jq -Rs '.')"
  local issue_json="null"
  [ -n "$issue" ] && issue_json="$issue"
  local task_id="${KOOKR_TASK_ID:-}"
  local task_id_json="null"
  [ -n "$task_id" ] && task_id_json="$(printf '%s' "$task_id" | jq -Rs '.')"
  local entry
  entry=$(cat <<JSON
{"timestamp":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","repo":"$repo","action":"$action","issue":$issue_json,"closing_pr":$closing_pr_json,"closing_pr_merged_at":$closing_pr_merged_at_json,"state_reason":$state_reason_json,"taskId":$task_id_json,"command":$cmd_snippet}
JSON
)
  echo "$entry" >> "$LEDGER_FILE" 2>/dev/null || true
}

emit_deny() {
  local reason="$1"
  jq -n --arg r "$reason" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $r
    }
  }'
  exit 0
}

# --- 1. Read payload ---
INPUT=$(cat)
COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null) \
  || fail_open "failed to parse payload JSON"
CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // empty' 2>/dev/null) || CWD=""

[ -z "$COMMAND" ] && exit 0

# --- 2. Match gh pr create; allow drafts ---
printf '%s' "$COMMAND" | grep -qE '\bgh\s+pr\s+create\b' || exit 0
if printf '%s' "$COMMAND" | grep -qE '(^|[[:space:]])--draft([[:space:]]|$)'; then
  exit 0
fi

# --- 3. Extract PR body ---
# Primary form (100% of Kookr playbook commands in the wild):
#   --body "$(cat <<'EOF' ... EOF)"   or   --body "$(cat <<EOF ... EOF)"
# Secondary forms handled:
#   --body-file <path>  (regular file, <=1 MiB, not stdin `-`)
#   --body "..."        (plain double-quoted string, no embedded quotes)
# Anything else → fail open.
BODY=""

extract_heredoc_body() {
  # Stdin = full COMMAND. Extract the first heredoc body from any
  # `<<'DELIM'` or `<<DELIM` form. Returns 0 on success with body on stdout,
  # 1 on no match.
  awk '
    BEGIN { state=0; delim="" }
    state==0 {
      if (match($0, /<<[\047"]?([A-Za-z_][A-Za-z0-9_]*)[\047"]?/)) {
        raw = substr($0, RSTART, RLENGTH)
        gsub(/^<<[\047"]?/, "", raw)
        gsub(/[\047"]?$/, "", raw)
        delim = raw
        state = 1
        next
      }
    }
    state==1 {
      if ($0 == delim) { state=2; next }
      print
    }
    END { exit (state==2 ? 0 : 1) }
  '
}

read_body_file() {
  local path="$1"
  [ "$path" = "-" ] && return 1
  # Expand a leading ~ (the shell won't have done it — arguments arrive literal)
  case "$path" in
    "~"/*) path="$HOME/${path#\~/}" ;;
    "~") path="$HOME" ;;
  esac
  [ -f "$path" ] || return 1
  local size
  size=$(stat -c %s "$path" 2>/dev/null || stat -f %z "$path" 2>/dev/null || echo 0)
  [ "$size" -gt 1048576 ] && return 1
  head -c 1048576 "$path" 2>/dev/null
}

# Try --body-file first (explicit flag wins over --body heuristics)
BODY_FILE_PATH=$(printf '%s\n' "$COMMAND" | sed -nE "s/.*--body-file[[:space:]]+([^[:space:]\"']+).*/\1/p" | head -1) || true
if [ -n "$BODY_FILE_PATH" ]; then
  if BODY=$(read_body_file "$BODY_FILE_PATH"); then
    :
  else
    fail_open "body-file parse failed: $BODY_FILE_PATH"
  fi
else
  # Heredoc form — match <<DELIM or <<'DELIM' or <<"DELIM"
  if printf '%s' "$COMMAND" | grep -qE "<<['\"]?[A-Za-z_]"; then
    BODY=$(printf '%s\n' "$COMMAND" | extract_heredoc_body) || BODY=""
  fi
  # Plain double-quoted fallback — best effort, only if no heredoc
  if [ -z "$BODY" ]; then
    BODY=$(printf '%s\n' "$COMMAND" | sed -nE 's/.*--body[[:space:]]+"([^"]*)".*/\1/p' | head -1)
    if [ -z "$BODY" ]; then
      BODY=$(printf '%s\n' "$COMMAND" | sed -nE "s/.*-b[[:space:]]+\"([^\"]*)\".*/\1/p" | head -1)
    fi
  fi
fi

[ -z "$BODY" ] && fail_open "body parse fallthrough: no body extracted"

# --- 4. Pre-process: strip fenced code blocks and quoted lines ---
# Approximate — does not handle nested fences, indented code blocks, or
# inline single-backtick spans. False positives are caught by the bypass
# file; this is documented in the RFC's Known Limitations.
STRIPPED=$(printf '%s\n' "$BODY" | awk '
  BEGIN { in_fence=0 }
  /^```/ || /^~~~/ { in_fence = !in_fence; next }
  in_fence { next }
  /^[[:space:]]*>/ { next }
  { print }
')

# --- 5. Extract all issue references ---
# Full 9-keyword closing regex + owner/repo prefix + URL form.
# Uses grep -P (PCRE) for (?:) non-capturing groups.
ISSUE_REFS=$(printf '%s\n' "$STRIPPED" | grep -oiP '\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)[[:space:]]*:?[[:space:]]+(?:[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)?#\d+' || true)
URL_REFS=$(printf '%s\n' "$STRIPPED" | grep -oiP 'https?://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/issues/\d+' || true)

# Build list of "owner/repo issue_number" pairs
# Delayed: need target repo first (for bare #NNN refs)

# --- 6. Determine target repo ---
TARGET_OWNER=""
TARGET_REPO=""
REPO_FLAG=$(printf '%s\n' "$COMMAND" | sed -nE "s/.*(-R|--repo)[[:space:]]+\"?'?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\"?'?.*/\2/p" | head -1) || true
if [ -n "$REPO_FLAG" ]; then
  TARGET_OWNER="${REPO_FLAG%%/*}"
  TARGET_REPO="${REPO_FLAG##*/}"
elif [ -n "$CWD" ] && [ -d "$CWD" ]; then
  REMOTE_URL=$(git -C "$CWD" remote get-url origin 2>/dev/null) || REMOTE_URL=""
  if [ -n "$REMOTE_URL" ]; then
    SLUG=$(printf '%s' "$REMOTE_URL" | sed -E 's#.*github\.com[:/]##; s#\.git$##')
    if [[ "$SLUG" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
      TARGET_OWNER="${SLUG%%/*}"
      TARGET_REPO="${SLUG##*/}"
    fi
  fi
fi

if [ -z "$TARGET_OWNER" ] || [ -z "$TARGET_REPO" ]; then
  fail_open "could not determine target repo"
fi

# Build the (owner, repo, issue) tuples
TUPLES_FILE=$(mktemp) || fail_open "mktemp failed"
trap 'rm -f "$TUPLES_FILE"; release_locks 2>/dev/null || true' EXIT

while IFS= read -r ref; do
  [ -z "$ref" ] && continue
  # Capture optional owner/repo prefix and issue number
  prefix=$(printf '%s' "$ref" | grep -oP '[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(?=#)' | head -1 || true)
  num=$(printf '%s' "$ref" | grep -oP '#\K\d+' | head -1 || true)
  [ -z "$num" ] && continue
  if [ -n "$prefix" ]; then
    printf '%s\t%s\t%s\n' "${prefix%%/*}" "${prefix##*/}" "$num" >> "$TUPLES_FILE"
  else
    printf '%s\t%s\t%s\n' "$TARGET_OWNER" "$TARGET_REPO" "$num" >> "$TUPLES_FILE"
  fi
done <<< "$ISSUE_REFS"

while IFS= read -r url; do
  [ -z "$url" ] && continue
  slug=$(printf '%s' "$url" | sed -nE 's#https?://github\.com/([^/]+)/([^/]+)/issues/([0-9]+).*#\1\t\2\t\3#p')
  [ -n "$slug" ] && printf '%s\n' "$slug" >> "$TUPLES_FILE"
done <<< "$URL_REFS"

# Dedupe tuples
if [ -s "$TUPLES_FILE" ]; then
  sort -u "$TUPLES_FILE" -o "$TUPLES_FILE"
fi

# No refs → allow
if [ ! -s "$TUPLES_FILE" ]; then
  exit 0
fi

# --- 7. gh auth + host check ---
if [ -n "${GH_HOST:-}" ] && [ "$GH_HOST" != "github.com" ]; then
  log_warning "GH_HOST=$GH_HOST is non-github.com — fail-open"
  exit 0
fi
if ! timeout "$AUTH_TIMEOUT" "$GH_BIN" auth status -h github.com >/dev/null 2>&1; then
  log_warning "gh auth status failed — fail-open"
  exit 0
fi

# --- 8. Existing open PR on current branch? defer to gh's native error ---
BRANCH=""
if [ -n "$CWD" ] && [ -d "$CWD" ]; then
  BRANCH=$(git -C "$CWD" symbolic-ref -q --short HEAD 2>/dev/null) || BRANCH=""
fi
if [ -n "$BRANCH" ]; then
  LOGIN=$(timeout "$AUTH_TIMEOUT" "$GH_BIN" api user --jq .login 2>/dev/null) || LOGIN=""
  HEAD_QUAL="${LOGIN:+${LOGIN}:}${BRANCH}"
  EXISTING=$(timeout "$PR_LIST_TIMEOUT" "$GH_BIN" pr list \
    --repo "${TARGET_OWNER}/${TARGET_REPO}" \
    --head "$HEAD_QUAL" \
    --state open \
    --json number \
    --limit 1 2>/dev/null) || EXISTING="[]"
  if [ -n "$EXISTING" ] && [ "$EXISTING" != "[]" ] && [ "$EXISTING" != "null" ]; then
    exit 0
  fi
fi

# --- 9. Bypass check (uses first tuple for slug) ---
FIRST_TUPLE=$(head -1 "$TUPLES_FILE")
BP_OWNER=$(printf '%s' "$FIRST_TUPLE" | cut -f1)
BP_REPO=$(printf '%s' "$FIRST_TUPLE" | cut -f2)
BP_ISSUE=$(printf '%s' "$FIRST_TUPLE" | cut -f3)
BYPASS_FILE="${STATE_DIR}/.stale-scout-${BP_OWNER}-${BP_REPO}-${BP_ISSUE}-bypass"
if [ -f "$BYPASS_FILE" ]; then
  rm -f "$BYPASS_FILE"
  exit 0
fi

# --- 10+12. Query each issue; collect closed ones; classify ---
CLOSED_OWNER=""
CLOSED_REPO=""
CLOSED_ISSUE=""
CLOSED_STATE_REASON=""
ALL_OPEN=1
while IFS=$'\t' read -r o r n; do
  [ -z "$n" ] && continue
  RESP=$(timeout "$REST_TIMEOUT" "$GH_BIN" api "repos/${o}/${r}/issues/${n}" 2>/dev/null) || {
    log_warning "REST query failed for ${o}/${r}#${n}"
    continue
  }
  # Detect "issue is actually a PR" and skip
  PR_FIELD=$(printf '%s' "$RESP" | jq -r '.pull_request // empty' 2>/dev/null || echo "")
  [ -n "$PR_FIELD" ] && continue
  STATE=$(printf '%s' "$RESP" | jq -r '.state // empty' 2>/dev/null || echo "")
  if [ "$STATE" = "closed" ]; then
    ALL_OPEN=0
    CLOSED_OWNER="$o"
    CLOSED_REPO="$r"
    CLOSED_ISSUE="$n"
    CLOSED_STATE_REASON=$(printf '%s' "$RESP" | jq -r '.state_reason // empty' 2>/dev/null || echo "")
    break
  fi
done < "$TUPLES_FILE"

REPO_SLUG="${TARGET_OWNER}/${TARGET_REPO}"

# --- 11. All open → allow, write allow entry, exit ---
if [ "$ALL_OPEN" = "1" ]; then
  ledger_append "pr_stale_scout_allow" "$(head -1 "$TUPLES_FILE" | cut -f3)" "" "" "" "$REPO_SLUG"
  exit 0
fi

# --- 12. Closed: query closing PR via GraphQL, client-side sort mergedAt DESC ---
GRAPHQL_QUERY="query { repository(owner: \"${CLOSED_OWNER}\", name: \"${CLOSED_REPO}\") { issue(number: ${CLOSED_ISSUE}) { closedByPullRequestsReferences(first: 100, includeClosedPrs: true) { nodes { number state title mergedAt url } } } } }"
GRAPHQL_RESP=$(timeout "$REST_TIMEOUT" "$GH_BIN" api graphql -f query="$GRAPHQL_QUERY" 2>/dev/null) || GRAPHQL_RESP=""

CLOSING_PR=""
CLOSING_PR_URL=""
CLOSING_PR_MERGED_AT=""
if [ -n "$GRAPHQL_RESP" ]; then
  # Filter: merged only (mergedAt not null), sort desc, pick first
  MERGED_PICK=$(printf '%s' "$GRAPHQL_RESP" | jq -r '
    .data.repository.issue.closedByPullRequestsReferences.nodes
    | map(select(.mergedAt != null))
    | sort_by(.mergedAt)
    | reverse
    | .[0]
    | if . == null then "" else "\(.number)\t\(.url)\t\(.mergedAt)" end
  ' 2>/dev/null || echo "")
  if [ -n "$MERGED_PICK" ] && [ "$MERGED_PICK" != "" ]; then
    CLOSING_PR=$(printf '%s' "$MERGED_PICK" | cut -f1)
    CLOSING_PR_URL=$(printf '%s' "$MERGED_PICK" | cut -f2)
    CLOSING_PR_MERGED_AT=$(printf '%s' "$MERGED_PICK" | cut -f3)
  fi
fi

CLOSED_SLUG="${CLOSED_OWNER}/${CLOSED_REPO}"
BYPASS_HINT="touch /dev/shm/.stale-scout-${CLOSED_OWNER}-${CLOSED_REPO}-${CLOSED_ISSUE}-bypass"

if [ -n "$CLOSING_PR" ]; then
  ledger_append "pr_blocked_stale_scout" "$CLOSED_ISSUE" "$CLOSING_PR" "$CLOSING_PR_MERGED_AT" "$CLOSED_STATE_REASON" "$CLOSED_SLUG"
  REASON=$(printf '%s\nBYPASS (deliberate follow-up only): %s\nBLOCK: %s#%s closed by PR #%s (merged %s).\nNote: this deny consumed today'"'"'s rate-limit slot. To recover: ~/.claude/hooks/oss-gate reset %s' \
    "$CLOSING_PR_URL" \
    "$BYPASS_HINT" \
    "$CLOSED_SLUG" "$CLOSED_ISSUE" "$CLOSING_PR" "$CLOSING_PR_MERGED_AT" \
    "$CLOSED_SLUG")
  emit_deny "$REASON"
else
  # REST confirmed closed but GraphQL could not identify the closing PR —
  # still block (the crucial non-fail-open branch).
  ledger_append "pr_blocked_stale_scout" "$CLOSED_ISSUE" "" "" "$CLOSED_STATE_REASON" "$CLOSED_SLUG"
  REASON=$(printf 'BYPASS (deliberate follow-up only): %s\nBLOCK: %s#%s is closed (state_reason: %s).\nClosing PR could not be identified. Verify the fix is still needed.\nNote: this deny consumed today'"'"'s rate-limit slot. To recover: ~/.claude/hooks/oss-gate reset %s' \
    "$BYPASS_HINT" \
    "$CLOSED_SLUG" "$CLOSED_ISSUE" "${CLOSED_STATE_REASON:-completed}" \
    "$CLOSED_SLUG")
  emit_deny "$REASON"
fi
