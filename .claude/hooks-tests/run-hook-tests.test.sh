#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
RUNNER="$REPO_ROOT/scripts/run-hook-tests.sh"
TMP_ROOT=$(mktemp -d)
trap 'rm -rf "$TMP_ROOT"' EXIT

PASS=0
FAIL=0

record_pass() {
  PASS=$((PASS + 1))
  printf '  [OK]   %s\n' "$1"
}

record_fail() {
  FAIL=$((FAIL + 1))
  printf '  [FAIL] %s\n' "$1" >&2
  printf '         %s\n' "$2" >&2
}

assert_contains() {
  local name="$1"
  local output="$2"
  local expected="$3"
  if [[ "$output" == *"$expected"* ]]; then
    record_pass "$name"
  else
    record_fail "$name" "missing '$expected' in: $output"
  fi
}

assert_not_contains() {
  local name="$1"
  local output="$2"
  local unexpected="$3"
  if [[ "$output" != *"$unexpected"* ]]; then
    record_pass "$name"
  else
    record_fail "$name" "unexpected '$unexpected' in: $output"
  fi
}

mkdir -p "$TMP_ROOT/scripts" "$TMP_ROOT/.claude/hooks-tests"
cp "$RUNNER" "$TMP_ROOT/scripts/run-hook-tests.sh"

cat > "$TMP_ROOT/.claude/hooks-tests/alpha.test.sh" <<'EOF'
#!/usr/bin/env bash
printf 'alpha ran\n'
EOF

cat > "$TMP_ROOT/.claude/hooks-tests/beta-failure.test.sh" <<'EOF'
#!/usr/bin/env bash
printf 'beta ran\n'
exit 7
EOF

cat > "$TMP_ROOT/.claude/hooks-tests/gamma.test.sh" <<'EOF'
#!/usr/bin/env bash
printf 'gamma ran\n'
EOF

printf '\nRunning hook test runner regression tests\n\n'

set +e
all_output=$(bash "$TMP_ROOT/scripts/run-hook-tests.sh" 2>&1)
all_status=$?
set -e

if [ "$all_status" -ne 0 ]; then
  record_pass "aggregate run exits non-zero when a suite fails"
else
  record_fail "aggregate run exits non-zero when a suite fails" "exit status was 0"
fi
assert_contains "runner continues after a failure" "$all_output" "gamma ran"
assert_contains "summary reports aggregate counts" "$all_output" "2 passed / 1 failed"
assert_contains "summary names the failing suite" "$all_output" "beta-failure.test.sh"

filtered_output=$(bash "$TMP_ROOT/scripts/run-hook-tests.sh" alpha 2>&1)
assert_contains "filter runs matching suite" "$filtered_output" "alpha ran"
assert_not_contains "filter skips non-matching suites" "$filtered_output" "beta ran"
assert_contains "filtered summary reports counts" "$filtered_output" "1 passed / 0 failed"

set +e
no_match_output=$(bash "$TMP_ROOT/scripts/run-hook-tests.sh" missing 2>&1)
no_match_status=$?
set -e

if [ "$no_match_status" -ne 0 ]; then
  record_pass "unmatched filter exits non-zero"
else
  record_fail "unmatched filter exits non-zero" "exit status was 0"
fi
assert_contains "unmatched filter explains failure" "$no_match_output" "No hook test suites matched 'missing'"

printf '\npassed: %s  failed: %s\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
