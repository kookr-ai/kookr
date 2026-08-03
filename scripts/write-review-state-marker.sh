#!/usr/bin/env bash
# Write a SHA-bound .review-state marker that the pre-push gate accepts.
#
# APPROVED markers carry a producer HMAC token (issue #1968) so a raw
# `cat > .review-state/...` with only sha+status fails verification.
# BYPASS markers keep the human escape hatch (reason required, no token).
#
# Usage:
#   bash scripts/write-review-state-marker.sh --status approved --specialists "correctness,lint-like,test"
#   bash scripts/write-review-state-marker.sh --status bypass --reason "docs-only prose + comment typo"
#
# Options:
#   --repo-root DIR   Git worktree (default: cwd)
#   --sha SHA         Override HEAD sha (tests)
#   --key KEY         Override marker key (default: branch-derived)

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/review-marker-auth.sh
source "$SCRIPT_DIR/lib/review-marker-auth.sh"

STATUS=""
SPECIALISTS=""
REASON=""
REPO_ROOT=""
SHA_OVERRIDE=""
KEY_OVERRIDE=""

usage() {
  sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --status) STATUS="${2:-}"; shift 2 ;;
    --status=*) STATUS="${1#--status=}"; shift ;;
    --specialists) SPECIALISTS="${2:-}"; shift 2 ;;
    --specialists=*) SPECIALISTS="${1#--specialists=}"; shift ;;
    --reason) REASON="${2:-}"; shift 2 ;;
    --reason=*) REASON="${1#--reason=}"; shift ;;
    --repo-root) REPO_ROOT="${2:-}"; shift 2 ;;
    --repo-root=*) REPO_ROOT="${1#--repo-root=}"; shift ;;
    --sha) SHA_OVERRIDE="${2:-}"; shift 2 ;;
    --sha=*) SHA_OVERRIDE="${1#--sha=}"; shift ;;
    --key) KEY_OVERRIDE="${2:-}"; shift 2 ;;
    --key=*) KEY_OVERRIDE="${1#--key=}"; shift ;;
    -h|--help) usage ;;
    *) echo "write-review-state-marker: unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$STATUS" ]; then
  echo "write-review-state-marker: --status approved|bypass is required" >&2
  exit 2
fi

if [ -z "$REPO_ROOT" ]; then
  REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) \
    || { echo "write-review-state-marker: not in a git repo (pass --repo-root)" >&2; exit 1; }
fi

HEAD_SHA="${SHA_OVERRIDE:-}"
if [ -z "$HEAD_SHA" ]; then
  HEAD_SHA=$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null) \
    || { echo "write-review-state-marker: cannot resolve HEAD" >&2; exit 1; }
fi

if [ -n "$KEY_OVERRIDE" ]; then
  MARKER_KEY="$KEY_OVERRIDE"
else
  if BRANCH_NAME=$(git -C "$REPO_ROOT" symbolic-ref --short HEAD 2>/dev/null); then
    MARKER_KEY=$(printf '%s' "$BRANCH_NAME" | tr -c 'A-Za-z0-9.-' '_')
  else
    MARKER_KEY="detached-$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
  fi
fi

MARKER_DIR="$REPO_ROOT/.review-state"
mkdir -p "$MARKER_DIR"
TMP="$MARKER_DIR/${MARKER_KEY}.json.tmp"
DST="$MARKER_DIR/${MARKER_KEY}.json"

case "$STATUS" in
  approved)
    if [ -z "$SPECIALISTS" ]; then
      echo "write-review-state-marker: --specialists is required for status=approved" >&2
      echo "  (comma-separated roles that actually ran, e.g. correctness,lint-like,test)" >&2
      exit 2
    fi
    MATERIAL=$(review_state_token_material "$HEAD_SHA" "$SPECIALISTS")
    TOKEN=$(mint_review_marker_token "$MATERIAL") \
      || { echo "write-review-state-marker: failed to mint producer token" >&2; exit 1; }
    jq -n \
      --arg sha "$HEAD_SHA" \
      --arg status "approved" \
      --arg specialists "$SPECIALISTS" \
      --arg producer "$REVIEW_MARKER_PRODUCER" \
      --arg token "$TOKEN" \
      --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || true)" \
      '{
        sha: $sha,
        status: $status,
        specialists: $specialists,
        producer: $producer,
        token: $token,
        at: $at
      }' > "$TMP"
    ;;
  bypass)
    if [ -z "$REASON" ]; then
      echo "write-review-state-marker: --reason is required for status=bypass" >&2
      exit 2
    fi
    jq -n \
      --arg sha "$HEAD_SHA" \
      --arg status "bypass" \
      --arg reason "$REASON" \
      --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || true)" \
      '{
        sha: $sha,
        status: $status,
        reason: $reason,
        at: $at
      }' > "$TMP"
    ;;
  *)
    echo "write-review-state-marker: status must be approved or bypass, got: $STATUS" >&2
    exit 2
    ;;
esac

mv "$TMP" "$DST"
echo "write-review-state-marker: wrote $DST (status=$STATUS)"
