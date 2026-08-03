#!/usr/bin/env bash
# Issue #1968: prove forgery paths fail for review-state + pr-gate markers.
#
# Run: bash .claude/hooks-tests/review-marker-forgery.test.sh
# Or:  pnpm test:hooks

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
# shellcheck source=../../scripts/lib/review-marker-auth.sh
source "$REPO_ROOT/scripts/lib/review-marker-auth.sh"

PASS=0
FAIL=0

record() {
  local ok="$1" name="$2" detail="${3:-}"
  if [ "$ok" = "1" ]; then
    PASS=$((PASS + 1))
    printf '  [OK]   %s\n' "$name"
  else
    FAIL=$((FAIL + 1))
    printf '  [FAIL] %s\n' "$name"
    [ -n "$detail" ] && printf '         %s\n' "$detail"
  fi
}

printf '\nRunning review-marker forgery tests (issue #1968)\n\n'

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export HOME="$TMP"
export KOOKR_REVIEW_MARKER_SECRET_FILE="$TMP/.kookr/review-marker-secret"
mkdir -p "$TMP/.kookr"

HEAD_SHA="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
SPEC="correctness,lint-like,test"

# --- 1. Writer produces a token-backed approved marker that validates -------
git init -q -b main "$TMP/repo"
git -C "$TMP/repo" config user.email t@t
git -C "$TMP/repo" config user.name t
git -C "$TMP/repo" commit --allow-empty -q -m init
# Force known SHA for stable assertions via --sha.
bash "$REPO_ROOT/scripts/write-review-state-marker.sh" \
  --repo-root "$TMP/repo" --status approved --specialists "$SPEC" \
  --sha "$HEAD_SHA" --key "main" >/dev/null

MARKER="$TMP/repo/.review-state/main.json"
if validate_review_state_approved_file "$MARKER" "$HEAD_SHA"; then
  record 1 "writer approved marker validates"
else
  record 0 "writer approved marker validates" "file=$(cat "$MARKER" 2>/dev/null || true)"
fi

# --- 2. Raw cat forgery (sha+status only) fails validation ------------------
FORGE="$TMP/forged.json"
printf '{"sha":"%s","status":"approved"}\n' "$HEAD_SHA" > "$FORGE"
if validate_review_state_approved_file "$FORGE" "$HEAD_SHA"; then
  record 0 "raw cat approved forgery must fail" "validator accepted bare sha+status"
else
  record 1 "raw cat approved forgery must fail"
fi

# --- 3. Forgery with specialists but no token fails -------------------------
printf '{"sha":"%s","status":"approved","specialists":"%s","producer":"kookr-write-review-marker"}\n' \
  "$HEAD_SHA" "$SPEC" > "$FORGE"
if validate_review_state_approved_file "$FORGE" "$HEAD_SHA"; then
  record 0 "approved without token must fail"
else
  record 1 "approved without token must fail"
fi

# --- 4. Forgery with wrong token fails --------------------------------------
printf '{"sha":"%s","status":"approved","specialists":"%s","producer":"kookr-write-review-marker","token":"deadbeef"}\n' \
  "$HEAD_SHA" "$SPEC" > "$FORGE"
if validate_review_state_approved_file "$FORGE" "$HEAD_SHA"; then
  record 0 "approved with wrong token must fail"
else
  record 1 "approved with wrong token must fail"
fi

# --- 5. Empty specialists rejected even with a real token for empty string --
# Mint a token for empty specialists then force empty specialists field.
BAD_MAT=$(review_state_token_material "$HEAD_SHA" "")
BAD_TOK=$(mint_review_marker_token "$BAD_MAT")
printf '{"sha":"%s","status":"approved","specialists":"","producer":"kookr-write-review-marker","token":"%s"}\n' \
  "$HEAD_SHA" "$BAD_TOK" > "$FORGE"
if validate_review_state_approved_file "$FORGE" "$HEAD_SHA"; then
  record 0 "empty specialists must fail"
else
  record 1 "empty specialists must fail"
fi

# --- 6. pr-gate: writer validates; empty touch does not ---------------------
STATE_DIR="$TMP/shm"
mkdir -p "$STATE_DIR"
bash "$REPO_ROOT/scripts/write-pr-gate-marker.sh" \
  --repo "kookr" --branch "feat/x" --sha "$HEAD_SHA" \
  --state-dir "$STATE_DIR" >/dev/null
PRE_DONE="$STATE_DIR/.pr-gate-kookr-feat-x-pre-done"
if validate_pr_gate_pre_done_file "$PRE_DONE" "kookr" "feat-x"; then
  record 1 "writer pr-gate marker validates"
else
  record 0 "writer pr-gate marker validates" "file=$(cat "$PRE_DONE" 2>/dev/null || true)"
fi

EMPTY="$STATE_DIR/.pr-gate-kookr-empty-pre-done"
touch "$EMPTY"
if validate_pr_gate_pre_done_file "$EMPTY" "kookr" "empty"; then
  record 0 "empty touch pre-done must fail"
else
  record 1 "empty touch pre-done must fail"
fi

# --- 7. pre-push rejects forged approved marker (early exit, no build) ------
# Build a tiny repo with a non-trivial change so the review-gate runs.
FAKE_REPO="$TMP/prepush-repo"
git init -q -b main "$FAKE_REPO"
git -C "$FAKE_REPO" config user.email t@t
git -C "$FAKE_REPO" config user.name t
printf 'base\n' > "$FAKE_REPO/README.md"
git -C "$FAKE_REPO" add README.md
git -C "$FAKE_REPO" commit -q -m base
# Fake origin/main so the three-dot diff works.
git -C "$FAKE_REPO" branch origin/main 2>/dev/null || true
# Create a real remote-tracking ref without network:
git -C "$FAKE_REPO" update-ref refs/remotes/origin/main HEAD
printf 'export const x = 1\n' > "$FAKE_REPO/src-code.ts"
git -C "$FAKE_REPO" add src-code.ts
git -C "$FAKE_REPO" commit -q -m 'nontrivial'
git -C "$FAKE_REPO" checkout -q -b feature-1968
# Point origin/main at the parent of this branch's tip for a non-empty diff.
PARENT=$(git -C "$FAKE_REPO" rev-parse HEAD~1)
git -C "$FAKE_REPO" update-ref refs/remotes/origin/main "$PARENT"
HEAD_NOW=$(git -C "$FAKE_REPO" rev-parse HEAD)
mkdir -p "$FAKE_REPO/.review-state" "$FAKE_REPO/scripts/lib" "$FAKE_REPO/hooks"
# Copy auth lib so pre-push can source it from REPO_ROOT of the fake repo.
cp "$REPO_ROOT/scripts/lib/review-marker-auth.sh" "$FAKE_REPO/scripts/lib/"
# Staged review-state check uses index; marker file is untracked (gitignored
# pattern may not apply) — write forged approved only.
printf '{"sha":"%s","status":"approved"}\n' "$HEAD_NOW" \
  > "$FAKE_REPO/.review-state/feature-1968.json"
# Also need node_modules skip path: create empty node_modules so install is skipped
mkdir -p "$FAKE_REPO/node_modules"
# Copy pre-push hook
cp "$REPO_ROOT/.hooks/pre-push" "$FAKE_REPO/.hooks-pre-push"
# git-identity-guard is optional if missing
set +e
OUT=$(
  cd "$FAKE_REPO" &&
  HOME="$TMP" KOOKR_REVIEW_MARKER_SECRET_FILE="$KOOKR_REVIEW_MARKER_SECRET_FILE" \
    bash .hooks-pre-push </dev/null 2>&1
)
STATUS=$?
set -e
if [ "$STATUS" -ne 0 ] && printf '%s' "$OUT" | grep -qi 'producer token'; then
  record 1 "pre-push rejects forged approved marker"
else
  record 0 "pre-push rejects forged approved marker" \
    "status=$STATUS out=$(printf '%s' "$OUT" | head -c 400)"
fi

# --- 8. Valid approved marker passes the review-gate check (then may fail later)
bash "$REPO_ROOT/scripts/write-review-state-marker.sh" \
  --repo-root "$FAKE_REPO" --status approved --specialists "$SPEC" \
  --sha "$HEAD_NOW" >/dev/null
set +e
OUT2=$(
  cd "$FAKE_REPO" &&
  HOME="$TMP" KOOKR_REVIEW_MARKER_SECRET_FILE="$KOOKR_REVIEW_MARKER_SECRET_FILE" \
    bash .hooks-pre-push </dev/null 2>&1
)
STATUS2=$?
set -e
if printf '%s' "$OUT2" | grep -q 'review-gate: APPROVED'; then
  record 1 "pre-push accepts producer-token approved marker"
else
  record 0 "pre-push accepts producer-token approved marker" \
    "status=$STATUS2 out=$(printf '%s' "$OUT2" | head -c 400)"
fi

printf '\nResults: %d passed, %d failed\n' "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
