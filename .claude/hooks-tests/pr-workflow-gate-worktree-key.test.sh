#!/usr/bin/env bash
# Regression test for issue #406: pre-pr-review state-key mismatch in worktrees.
#
# The pr-workflow-gate.sh hook derives its state-file key from `-R owner/repo`
# (parsed out of `gh pr create`) or, failing that, from the cwd's git toplevel
# basename. When the skill runs from a worktree whose directory name differs
# from the repo name (e.g. `kookr-feature-x` vs. `kookr`), deriving the key
# from the cwd produces a file the hook never looks up.
#
# The fix lands in `.claude/skills/pre-pr-review/SKILL.md`: the snippet now
# reads `REPO_NAME` from `git config --get remote.origin.url`. This test
# exercises both halves of the contract end-to-end:
#
#   1. Running the skill's updated snippet from a scratch repo whose
#      directory basename differs from the remote produces a state file
#      keyed on the REMOTE name, not the dir name.
#   2. Running pr-workflow-gate.sh against that state file — with a
#      `gh pr create -R <remote> --head <branch>` payload — resolves the
#      same key and allows the command (exit 0, no deny output).
#
# Run: bash .claude/hooks-tests/pr-workflow-gate-worktree-key.test.sh
# Or:  pnpm test:hooks

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
HOOK="$REPO_ROOT/hooks/pr-workflow-gate.sh"

if [ ! -x "$HOOK" ] && [ ! -f "$HOOK" ]; then
  printf 'ERROR: hook not found at %s\n' "$HOOK" >&2
  exit 1
fi

PASS=0
FAIL=0
FAILED_CASES=()

report() {
  local status="$1"
  local name="$2"
  if [ "$status" = "PASS" ]; then
    PASS=$((PASS + 1))
    printf '  [OK]   %s\n' "$name"
  else
    FAIL=$((FAIL + 1))
    FAILED_CASES+=("$name")
    printf '  [FAIL] %s\n' "$name"
    shift 2
    for line in "$@"; do printf '         %s\n' "$line"; done
  fi
}

printf '\nRunning pr-workflow-gate worktree-key regression (#406)\n\n'

# ---------------------------------------------------------------------
# Build a scratch repo whose directory basename != remote repo name.
#   dir basename: scratch-kookr-feature-x
#   remote:       git@github.com:kookr-ai/kookr.git  -> 'kookr'
# ---------------------------------------------------------------------
SCRATCH_PARENT=$(mktemp -d)
SCRATCH_DIR="${SCRATCH_PARENT}/scratch-kookr-feature-x"
git init -q -b main "${SCRATCH_DIR}"
git -C "${SCRATCH_DIR}" config user.email 'test@example.com'
git -C "${SCRATCH_DIR}" config user.name 'Test'
git -C "${SCRATCH_DIR}" remote add origin 'git@github.com:kookr-ai/kookr.git'
git -C "${SCRATCH_DIR}" commit -q --allow-empty -m 'init'
git -C "${SCRATCH_DIR}" checkout -q -b 'feat/x'

# Quarantine state files to this test — use a private /tmp dir, not /dev/shm,
# so we don't collide with or leak into the operator's real PR-gate state.
# Both the skill snippet and the hook honor an overridable STATE_DIR, but the
# real hook hardcodes /dev/shm. So we simulate by writing to a tmp state dir
# AND to /dev/shm under a test-only key that we clean up afterward.
TEST_TAG="$(date -u +%s)-$$"
TEST_BRANCH="feat-x-${TEST_TAG}"
git -C "${SCRATCH_DIR}" branch -m "feat/x" "feat/x-${TEST_TAG}"

# ---------------------------------------------------------------------
# Case 1: updated skill snippet derives REPO_NAME from the remote URL,
# producing a key that matches the hook's `-R owner/repo` parsing.
# ---------------------------------------------------------------------
cd "${SCRATCH_DIR}"

# This is the exact snippet shipped in SKILL.md after the #406 fix.
REMOTE_URL=$(git config --get remote.origin.url 2>/dev/null || true)
REPO_NAME=$(basename -s .git "${REMOTE_URL:-$(git rev-parse --show-toplevel)}")
SAFE_BRANCH=$(git rev-parse --abbrev-ref HEAD | tr '/' '-')
STATE_KEY="${REPO_NAME}-${SAFE_BRANCH}"
EXPECTED_KEY="kookr-feat-x-${TEST_TAG}"
WRONG_KEY_PREFIX="scratch-kookr-feature-x-"

if [ "${STATE_KEY}" = "${EXPECTED_KEY}" ]; then
  report PASS "1: skill snippet derives key from remote URL (kookr), not dir basename (scratch-kookr-feature-x)"
else
  report FAIL "1: skill snippet derives key from remote URL" \
    "expected STATE_KEY=${EXPECTED_KEY}" \
    "got      STATE_KEY=${STATE_KEY}"
fi

case "${STATE_KEY}" in
  ${WRONG_KEY_PREFIX}*)
    report FAIL "1b: skill snippet avoided cwd-basename key" \
      "STATE_KEY=${STATE_KEY} matches rejected prefix ${WRONG_KEY_PREFIX}"
    ;;
  *)
    report PASS "1b: skill snippet avoided cwd-basename key"
    ;;
esac

# Produce the state file the skill would touch.
STATE_FILE="/dev/shm/.pr-gate-${STATE_KEY}-pre-done"
touch "${STATE_FILE}"
trap 'rm -f "${STATE_FILE}" "/dev/shm/.pr-gate-${STATE_KEY}-bypass" 2>/dev/null || true; rm -rf "${SCRATCH_PARENT}"' EXIT

# ---------------------------------------------------------------------
# Case 2: pr-workflow-gate.sh sees `-R kookr-ai/kookr --head feat/x-<tag>`,
# derives the same key, finds the state file, and allows.
# ---------------------------------------------------------------------
PAYLOAD=$(jq -n \
  --arg cwd "${SCRATCH_DIR}" \
  --arg cmd "gh pr create -R kookr-ai/kookr --head feat/x-${TEST_TAG} --title t --body b" \
  '{ tool_name: "Bash", cwd: $cwd, tool_input: { command: $cmd } }')

OUT=$(printf '%s' "${PAYLOAD}" | bash "${HOOK}" 2>&1) || true

if printf '%s' "${OUT}" | grep -q '"permissionDecision": "deny"'; then
  report FAIL "2: hook allows when remote-derived state file exists" \
    "hook emitted deny output:" \
    "$(printf '%s' "${OUT}" | head -c 400)"
else
  report PASS "2: hook allows when remote-derived state file exists"
fi

# The state file must survive (only the bypass file is one-time).
if [ -f "${STATE_FILE}" ]; then
  report PASS "3: pre-done state file not consumed by allow path"
else
  report FAIL "3: pre-done state file not consumed by allow path" \
    "${STATE_FILE} was removed"
fi

# ---------------------------------------------------------------------
# Case 4: sanity-check — confirm the OLD cwd-basename key (which the
# skill used to produce) would NOT have matched. Writing a state file
# under the old key and running the hook (without the correct key in
# place) must still deny, proving the mismatch is real.
# ---------------------------------------------------------------------
rm -f "${STATE_FILE}"
WRONG_KEY="scratch-kookr-feature-x-feat-x-${TEST_TAG}"
WRONG_STATE="/dev/shm/.pr-gate-${WRONG_KEY}-pre-done"
touch "${WRONG_STATE}"

OUT2=$(printf '%s' "${PAYLOAD}" | bash "${HOOK}" 2>&1) || true
rm -f "${WRONG_STATE}"

if printf '%s' "${OUT2}" | grep -q '"permissionDecision": "deny"'; then
  report PASS "4: hook denies when only the legacy cwd-basename key exists (pre-fix repro)"
else
  report FAIL "4: hook denies when only the legacy cwd-basename key exists" \
    "expected deny output with WRONG key ${WRONG_KEY} but got allow" \
    "$(printf '%s' "${OUT2}" | head -c 400)"
fi

# Restore the correct state file so case 2's trap-cleanup still matches.
touch "${STATE_FILE}"

printf '\nResults: %d passed, %d failed\n' "${PASS}" "${FAIL}"
if [ "${FAIL}" -gt 0 ]; then
  printf 'Failed cases:\n'
  for c in "${FAILED_CASES[@]}"; do printf '  - %s\n' "$c"; done
  exit 1
fi
