#!/usr/bin/env bash
# Shared producer-token helpers for review-state and pr-gate markers (issue #1968).
#
# Design: APPROVED / pre-done markers must carry an HMAC-SHA256 token minted by
# the writer scripts in this repo. Raw shell forgery (`cat > .review-state/...`
# with only sha+status, or `touch /dev/shm/.pr-gate-*-pre-done`) fails verification.
#
# The secret lives at $HOME/.kookr/review-marker-secret (mode 0600), auto-created
# on first mint. Override path with KOOKR_REVIEW_MARKER_SECRET_FILE for tests.
#
# Bypass markers (status=bypass + reason) intentionally do NOT require a token —
# that is the documented human escape hatch (see .hooks/pre-push AC5).
#
# This is not cryptographic assurance against a determined agent that can read
# the secret file; it raises the bar so prompt-only / naive shell forgery no
# longer satisfies the gates.
#
# shellcheck shell=bash

REVIEW_MARKER_AUTH_VERSION="v1"
REVIEW_MARKER_PRODUCER="kookr-write-review-marker"

review_marker_secret_path() {
  if [ -n "${KOOKR_REVIEW_MARKER_SECRET_FILE:-}" ]; then
    printf '%s' "$KOOKR_REVIEW_MARKER_SECRET_FILE"
    return 0
  fi
  printf '%s' "${HOME:-/tmp}/.kookr/review-marker-secret"
}

ensure_review_marker_secret() {
  local path parent
  path=$(review_marker_secret_path)
  parent=$(dirname "$path")
  mkdir -p "$parent" 2>/dev/null || true
  if [ ! -f "$path" ]; then
    # 32 hex bytes of entropy. Prefer openssl; fall back to /dev/urandom.
    if command -v openssl >/dev/null 2>&1; then
      openssl rand -hex 32 > "$path" 2>/dev/null || {
        head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$path"
      }
    else
      head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$path"
    fi
    chmod 600 "$path" 2>/dev/null || true
  fi
  printf '%s' "$path"
}

# mint_review_marker_token <material>
# material is an opaque string (caller builds the binding fields).
mint_review_marker_token() {
  local material="$1"
  local secret_path secret
  secret_path=$(ensure_review_marker_secret)
  secret=$(cat "$secret_path" 2>/dev/null) || return 1
  [ -n "$secret" ] || return 1
  if ! command -v openssl >/dev/null 2>&1; then
    echo "review-marker-auth: openssl is required to mint tokens" >&2
    return 1
  fi
  # HMAC-SHA256; openssl prints "HMAC-SHA256(stdin)= <hex>" or "(stdin)= <hex>"
  printf '%s' "$material" \
    | openssl dgst -sha256 -hmac "$secret" 2>/dev/null \
    | awk '{print $NF}'
}

# verify_review_marker_token <material> <token>
verify_review_marker_token() {
  local material="$1"
  local token="$2"
  local secret_path secret expected
  [ -n "$token" ] || return 1
  secret_path=$(review_marker_secret_path)
  [ -f "$secret_path" ] || return 1
  secret=$(cat "$secret_path" 2>/dev/null) || return 1
  [ -n "$secret" ] || return 1
  command -v openssl >/dev/null 2>&1 || return 1
  expected=$(printf '%s' "$material" \
    | openssl dgst -sha256 -hmac "$secret" 2>/dev/null \
    | awk '{print $NF}')
  [ -n "$expected" ] || return 1
  # Constant-time-ish compare via test equality (token is hex, short).
  [ "$expected" = "$token" ]
}

# Material for .review-state approved markers.
review_state_token_material() {
  local sha="$1"
  local specialists="$2"
  printf '%s|review-state|%s|approved|%s' \
    "$REVIEW_MARKER_AUTH_VERSION" "$sha" "$specialists"
}

# Material for pr-gate pre-done markers.
pr_gate_token_material() {
  local repo="$1"
  local branch="$2"
  local sha="$3"
  printf '%s|pr-gate|%s|%s|%s' \
    "$REVIEW_MARKER_AUTH_VERSION" "$repo" "$branch" "$sha"
}

# validate_review_state_approved_file <marker_file> <expected_head_sha>
# Returns 0 if the marker is a token-backed approved marker for that SHA.
validate_review_state_approved_file() {
  local file="$1"
  local head_sha="$2"
  local sha status specialists producer token material

  command -v jq >/dev/null 2>&1 || return 1
  [ -f "$file" ] || return 1

  sha=$(jq -r '.sha // empty' "$file" 2>/dev/null) || return 1
  status=$(jq -r '.status // empty' "$file" 2>/dev/null) || return 1
  specialists=$(jq -r '.specialists // empty' "$file" 2>/dev/null) || return 1
  producer=$(jq -r '.producer // empty' "$file" 2>/dev/null) || return 1
  token=$(jq -r '.token // empty' "$file" 2>/dev/null) || return 1

  [ "$status" = "approved" ] || return 1
  [ "$sha" = "$head_sha" ] || return 1
  [ -n "$specialists" ] || return 1
  [ "$producer" = "$REVIEW_MARKER_PRODUCER" ] || return 1
  [ -n "$token" ] || return 1

  material=$(review_state_token_material "$sha" "$specialists")
  verify_review_marker_token "$material" "$token"
}

# validate_pr_gate_pre_done_file <state_file> <repo> <branch>
# SHA inside the file is informational; token binds repo+branch+sha.
validate_pr_gate_pre_done_file() {
  local file="$1"
  local repo="$2"
  local branch="$3"
  local sha producer token material

  command -v jq >/dev/null 2>&1 || return 1
  [ -f "$file" ] || return 1
  # Empty touch() files are the classic forgery path — reject.
  [ -s "$file" ] || return 1

  sha=$(jq -r '.sha // empty' "$file" 2>/dev/null) || return 1
  producer=$(jq -r '.producer // empty' "$file" 2>/dev/null) || return 1
  token=$(jq -r '.token // empty' "$file" 2>/dev/null) || return 1

  [ -n "$sha" ] || return 1
  [ "$producer" = "$REVIEW_MARKER_PRODUCER" ] || return 1
  [ -n "$token" ] || return 1

  material=$(pr_gate_token_material "$repo" "$branch" "$sha")
  verify_review_marker_token "$material" "$token"
}
