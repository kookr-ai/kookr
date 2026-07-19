#!/usr/bin/env bash
# Regression tests for hooks/kookr-prod-kill-guard.sh.

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
HOOK="$REPO_ROOT/hooks/kookr-prod-kill-guard.sh"

TMP=$(mktemp -d "${TMPDIR:-/tmp}/kookr-prod-kill-guard.XXXXXX")
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/repo/hooks" "$TMP/state"
cp "$HOOK" "$TMP/repo/hooks/kookr-prod-kill-guard.sh"
TEST_HOOK="$TMP/repo/hooks/kookr-prod-kill-guard.sh"

PASS=0
FAIL=0

run_hook() {
  local command="$1"
  shift
  jq -n --arg command "$command" '{tool_input: {command: $command}}' \
    | env -u KOOKR_PORT -u KOOKR_GIT_COMMON_DIR \
        KOOKR_HOOKS_DIR="$TMP/state" "$@" bash "$TEST_HOOK"
}

assert_denied() {
  local label="$1" command="$2"
  shift 2
  local output
  output=$(run_hook "$command" "$@")
  if [ "$(printf '%s' "$output" | jq -r '.hookSpecificOutput.permissionDecision // empty')" = "deny" ]; then
    PASS=$((PASS + 1))
    printf 'PASS: %s\n' "$label"
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL: %s — expected deny output, got: %s\n' "$label" "$output" >&2
  fi
}

assert_allowed() {
  local label="$1" command="$2"
  shift 2
  local output
  output=$(run_hook "$command" "$@")
  if [ -z "$output" ]; then
    PASS=$((PASS + 1))
    printf 'PASS: %s\n' "$label"
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL: %s — expected no output, got: %s\n' "$label" "$output" >&2
  fi
}

assert_denied "exported port protects lsof/xargs" \
  'lsof -ti :4910 | xargs kill' KOOKR_PORT=4910
assert_denied "exported port protects command-substitution kill" \
  'kill $(lsof -t -i :4910)' KOOKR_PORT=4910
assert_denied "exported port protects fuser -k" \
  'fuser -k 4910/tcp' KOOKR_PORT=4910
assert_denied "exported port protects manual server start" \
  'KOOKR_PORT=4910 node dist/server/start.js' KOOKR_PORT=4910
assert_allowed "different port is allowed" \
  'lsof -ti :4800 | xargs kill' KOOKR_PORT=4910
assert_allowed "manual server start on a different port is allowed" \
  'KOOKR_PORT=4800 node dist/server/start.js' KOOKR_PORT=4910
assert_allowed "numeric substring is not treated as the protected port" \
  'lsof -ti :14910 | xargs kill' KOOKR_PORT=4910

printf '%s\n' 'KOOKR_PORT=4920' > "$TMP/repo/.env"
assert_denied ".env port is used when KOOKR_PORT is not exported" \
  'fuser -k 4920/tcp'
assert_denied "exported KOOKR_PORT takes precedence over .env" \
  'fuser -k 4930/tcp' KOOKR_PORT=4930
assert_allowed ".env port does not override exported KOOKR_PORT" \
  'fuser -k 4920/tcp' KOOKR_PORT=4930

mkdir -p "$TMP/main-checkout/.git"
printf '%s\n' 'KOOKR_PORT=4940' > "$TMP/main-checkout/.env"
rm "$TMP/repo/.env"
assert_denied "injected git common dir resolves .env from the main checkout" \
  'fuser -k 4940/tcp' KOOKR_GIT_COMMON_DIR="$TMP/main-checkout/.git"

mkdir -p "$TMP/git-main/hooks"
cp "$HOOK" "$TMP/git-main/hooks/kookr-prod-kill-guard.sh"
git -C "$TMP/git-main" init -q
git -C "$TMP/git-main" add hooks/kookr-prod-kill-guard.sh
git -C "$TMP/git-main" \
  -c user.name=test -c user.email=test@example.com commit -q -m base
git -C "$TMP/git-main" worktree add -q -b hook-test "$TMP/git-worktree"
printf '%s\n' 'KOOKR_PORT=4950' > "$TMP/git-main/.env"
original_test_hook="$TEST_HOOK"
TEST_HOOK="$TMP/git-worktree/hooks/kookr-prod-kill-guard.sh"
assert_denied "linked worktree discovers .env from the git common dir" \
  'fuser -k 4950/tcp'
TEST_HOOK="$original_test_hook"

assert_denied "missing configuration defaults to port 4800" \
  'lsof -ti :4800 | xargs kill'

printf '%s\n' 'KOOKR_PORT=not-a-port' > "$TMP/repo/.env"
assert_allowed "invalid configuration fails open" \
  'fuser -k 4800/tcp'

malformed_output=$(printf '%s' 'not json' \
  | env -u KOOKR_PORT KOOKR_HOOKS_DIR="$TMP/state" bash "$TEST_HOOK")
if [ -z "$malformed_output" ]; then
  PASS=$((PASS + 1))
  printf 'PASS: malformed hook payload fails open\n'
else
  FAIL=$((FAIL + 1))
  printf 'FAIL: malformed hook payload — expected no output, got: %s\n' "$malformed_output" >&2
fi

mkdir -p "$TMP/bin"
printf '%s\n' '#!/usr/bin/env bash' 'exit 7' > "$TMP/bin/tr"
chmod +x "$TMP/bin/tr"
assert_allowed "unexpected runtime error fails open through the ERR trap" \
  'fuser -k 4910/tcp' KOOKR_PORT=4910 PATH="$TMP/bin:$PATH"

printf '\nResults: %s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
