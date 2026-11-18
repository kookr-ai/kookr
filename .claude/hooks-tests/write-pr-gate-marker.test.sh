#!/usr/bin/env bash
# Regression test for issue #4179: write-pr-gate-marker.sh with an
# owner/name --repo slug.
#
# pr-workflow-gate.sh reads `gh pr create -R owner/name` and keys its state
# file on the bare name only. The marker writer used to put the slug into the
# key verbatim, so `--repo kookr-ai/kookr` tried to write
# `<dir>/.pr-gate-kookr-ai/kookr-<branch>-pre-done` (a missing directory) and
# failed. This test checks that:
#
#   1. `--repo owner/name`, `--repo=owner/name` and `--repo name` all write the
#      same file, `.pr-gate-<name>-<safe-branch>-pre-done`, with the same
#      marker fields (format unchanged).
#   2. A marker written with `--repo kookr-ai/kookr` is accepted by
#      pr-workflow-gate.sh for `gh pr create -R kookr-ai/kookr --head <branch>`
#      (and, as a control, the hook denies when no marker exists).
#
# Run: bash .claude/hooks-tests/write-pr-gate-marker.test.sh

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
WRITER="$REPO_ROOT/scripts/write-pr-gate-marker.sh"
HOOK="$REPO_ROOT/hooks/pr-workflow-gate.sh"

PASS=0
FAIL=0

report() {
  local status="$1" name="$2"
  if [ "$status" = "PASS" ]; then
    PASS=$((PASS + 1))
    printf '  [OK]   %s\n' "$name"
  else
    FAIL=$((FAIL + 1))
    printf '  [FAIL] %s\n' "$name"
    shift 2
    for line in "$@"; do printf '         %s\n' "$line"; done
  fi
}

printf '\nRunning write-pr-gate-marker owner/name --repo regression (#4179)\n\n'

TEST_TAG="$(date -u +%s)-$$"
BRANCH="fix/marker-slug-${TEST_TAG}"
SAFE_BRANCH="fix-marker-slug-${TEST_TAG}"
SHA="0123456789abcdef0123456789abcdef01234567"
EXPECTED_NAME=".pr-gate-kookr-${SAFE_BRANCH}-pre-done"

WORK=$(mktemp -d)
HOME_ISOLATE="$WORK/home"
mkdir -p "$HOME_ISOLATE/.kookr"
SECRET_FILE="$HOME_ISOLATE/.kookr/review-marker-secret"
# The hook hardcodes /dev/shm, so the hook case writes there under a key unique
# to this run and removes it on exit.
SHM_MARKER="/dev/shm/${EXPECTED_NAME}"
trap 'rm -f "$SHM_MARKER" "/dev/shm/.pr-gate-kookr-${SAFE_BRANCH}-bypass" 2>/dev/null || true; rm -rf "$WORK"' EXIT

write_marker() {
  # $1 = state dir; remaining args = --repo form(s)
  local state_dir="$1"; shift
  HOME="$HOME_ISOLATE" KOOKR_REVIEW_MARKER_SECRET_FILE="$SECRET_FILE" \
    bash "$WRITER" "$@" --branch "$BRANCH" --sha "$SHA" --state-dir "$state_dir" \
    </dev/null 2>&1
}

# Marker fields minus the timestamp, which differs between runs.
marker_fields() {
  jq -c '{sha, repo, branch, producer, token}' "$1"
}

# ---------------------------------------------------------------------
# Case 1: each --repo form writes the same file with the same fields.
# ---------------------------------------------------------------------
FIELDS_slug_space=""
FIELDS_slug_equals=""
FIELDS_bare=""
for form in "slug-space" "slug-equals" "bare"; do
  dir="$WORK/state-$form"
  case "$form" in
    slug-space)  out=$(write_marker "$dir" --repo kookr-ai/kookr) && rc=0 || rc=$? ;;
    slug-equals) out=$(write_marker "$dir" --repo=kookr-ai/kookr) && rc=0 || rc=$? ;;
    bare)        out=$(write_marker "$dir" --repo kookr) && rc=0 || rc=$? ;;
  esac
  if [ "$rc" -ne 0 ]; then
    report FAIL "1[$form]: writer exits 0" "rc=$rc" "$out"
    continue
  fi
  files=$(cd "$dir" && ls -A)
  if [ "$files" = "$EXPECTED_NAME" ]; then
    report PASS "1[$form]: writes exactly $EXPECTED_NAME"
  else
    report FAIL "1[$form]: writes exactly $EXPECTED_NAME" "state dir holds: $files"
    continue
  fi
  # bash 3.2 (macOS) has no associative arrays.
  printf -v "FIELDS_${form//-/_}" '%s' "$(marker_fields "$dir/$EXPECTED_NAME")"
done

if [ -n "${FIELDS_bare}" ] \
  && [ "${FIELDS_slug_space}" = "${FIELDS_bare}" ] \
  && [ "${FIELDS_slug_equals}" = "${FIELDS_bare}" ]; then
  report PASS "1b: owner/name and bare name produce identical marker fields"
else
  report FAIL "1b: owner/name and bare name produce identical marker fields" \
    "slug-space:  ${FIELDS_slug_space:-<none>}" \
    "slug-equals: ${FIELDS_slug_equals:-<none>}" \
    "bare:        ${FIELDS_bare:-<none>}"
fi

if [ -n "${FIELDS_bare}" ] \
  && [ "$(jq -r '.repo' <<<"${FIELDS_bare}")" = "kookr" ] \
  && [ "$(jq -r '.branch' <<<"${FIELDS_bare}")" = "$SAFE_BRANCH" ]; then
  report PASS "1c: marker records repo=kookr and the flattened branch"
else
  report FAIL "1c: marker records repo=kookr and the flattened branch" "${FIELDS_bare:-<none>}"
fi

# ---------------------------------------------------------------------
# Case 2: pr-workflow-gate.sh accepts a marker written with the slug.
# ---------------------------------------------------------------------
SCRATCH="$WORK/repo"
git init -q -b main "$SCRATCH"
git -C "$SCRATCH" config user.email 'test@example.com'
git -C "$SCRATCH" config user.name 'Test'
git -C "$SCRATCH" remote add origin 'git@github.com:kookr-ai/kookr.git'
git -C "$SCRATCH" commit -q --allow-empty -m init
git -C "$SCRATCH" checkout -q -b "$BRANCH"

PAYLOAD=$(jq -n \
  --arg cwd "$SCRATCH" \
  --arg cmd "gh pr create -R kookr-ai/kookr --head $BRANCH --title t --body b" \
  '{ tool_name: "Bash", cwd: $cwd, tool_input: { command: $cmd } }')

run_hook() {
  HOME="$HOME_ISOLATE" KOOKR_REVIEW_MARKER_SECRET_FILE="$SECRET_FILE" \
    bash -c 'printf "%s" "$1" | bash "$2"' _ "$PAYLOAD" "$HOOK" 2>&1 || true
}

# Control: no marker yet, so the hook must deny (proves the allow below is
# caused by the marker, not by the hook skipping this command).
rm -f "$SHM_MARKER"
OUT=$(run_hook)
if grep -q '"permissionDecision": "deny"' <<<"$OUT"; then
  report PASS "2a: hook denies without a marker (control)"
else
  report FAIL "2a: hook denies without a marker (control)" "$(printf '%s' "$OUT" | head -c 400)"
fi

SHA="$(git -C "$SCRATCH" rev-parse HEAD)"
out=$(write_marker /dev/shm --repo kookr-ai/kookr) && rc=0 || rc=$?
if [ "$rc" -eq 0 ] && [ -f "$SHM_MARKER" ]; then
  report PASS "2b: writer with --repo kookr-ai/kookr writes $SHM_MARKER"
else
  report FAIL "2b: writer with --repo kookr-ai/kookr writes $SHM_MARKER" "rc=$rc" "$out"
fi

OUT=$(run_hook)
if grep -q '"permissionDecision": "deny"' <<<"$OUT"; then
  report FAIL "2c: hook accepts the slug-written marker" "$(printf '%s' "$OUT" | head -c 400)"
else
  report PASS "2c: hook accepts the slug-written marker"
fi

printf '\n  %d passed, %d failed\n\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
