#!/usr/bin/env bash
# Write the pre-PR-review gate state file that pr-workflow-gate.sh accepts.
#
# Produces a JSON file with a producer HMAC token (issue #1968) so a raw
# `touch /dev/shm/.pr-gate-*-pre-done` no longer satisfies the gate.
#
# Usage (from the worktree, after pre-pr-review checks pass):
#   bash scripts/write-pr-gate-marker.sh
#   bash scripts/write-pr-gate-marker.sh --repo kookr --branch feat/x
#
# Options:
#   --repo NAME       Bare repo name used in the state key (default: remote)
#   --branch BRANCH   Branch name (default: current branch; / → - in key)
#   --sha SHA         Bind token to this sha (default: HEAD)
#   --cwd DIR         Git cwd for defaults
#   --state-dir DIR   Override /dev/shm (tests)

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/review-marker-auth.sh
source "$SCRIPT_DIR/lib/review-marker-auth.sh"

REPO_NAME=""
BRANCH=""
SHA=""
CWD=""
STATE_DIR="${KOOKR_PR_GATE_STATE_DIR:-/dev/shm}"

usage() {
  sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO_NAME="${2:-}"; shift 2 ;;
    --repo=*) REPO_NAME="${1#--repo=}"; shift ;;
    --branch) BRANCH="${2:-}"; shift 2 ;;
    --branch=*) BRANCH="${1#--branch=}"; shift ;;
    --sha) SHA="${2:-}"; shift 2 ;;
    --sha=*) SHA="${1#--sha=}"; shift ;;
    --cwd) CWD="${2:-}"; shift 2 ;;
    --cwd=*) CWD="${1#--cwd=}"; shift ;;
    --state-dir) STATE_DIR="${2:-}"; shift 2 ;;
    --state-dir=*) STATE_DIR="${1#--state-dir=}"; shift ;;
    -h|--help) usage ;;
    *) echo "write-pr-gate-marker: unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$CWD" ]; then
  CWD=$(pwd)
fi

if [ -z "$REPO_NAME" ]; then
  REMOTE_URL=$(git -C "$CWD" config --get remote.origin.url 2>/dev/null || true)
  REPO_NAME=$(basename -s .git "${REMOTE_URL:-$(git -C "$CWD" rev-parse --show-toplevel 2>/dev/null || echo unknown)}")
fi

if [ -z "$BRANCH" ]; then
  BRANCH=$(git -C "$CWD" rev-parse --abbrev-ref HEAD 2>/dev/null) \
    || { echo "write-pr-gate-marker: cannot determine branch (pass --branch)" >&2; exit 1; }
fi

if [ -z "$SHA" ]; then
  SHA=$(git -C "$CWD" rev-parse HEAD 2>/dev/null || printf 'unknown')
fi

# Match pr-workflow-gate.sh key derivation: SAFE_BRANCH = branch with / → -
SAFE_BRANCH=$(printf '%s' "$BRANCH" | tr '/' '-')
STATE_KEY="${REPO_NAME}-${SAFE_BRANCH}"
STATE_FILE="${STATE_DIR}/.pr-gate-${STATE_KEY}-pre-done"

MATERIAL=$(pr_gate_token_material "$REPO_NAME" "$SAFE_BRANCH" "$SHA")
TOKEN=$(mint_review_marker_token "$MATERIAL") \
  || { echo "write-pr-gate-marker: failed to mint producer token" >&2; exit 1; }

mkdir -p "$STATE_DIR" 2>/dev/null || true
TMP="${STATE_FILE}.tmp.$$"
jq -n \
  --arg sha "$SHA" \
  --arg repo "$REPO_NAME" \
  --arg branch "$SAFE_BRANCH" \
  --arg producer "$REVIEW_MARKER_PRODUCER" \
  --arg token "$TOKEN" \
  --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || true)" \
  '{
    sha: $sha,
    repo: $repo,
    branch: $branch,
    producer: $producer,
    token: $token,
    at: $at
  }' > "$TMP"
mv "$TMP" "$STATE_FILE"
echo "write-pr-gate-marker: wrote $STATE_FILE"
