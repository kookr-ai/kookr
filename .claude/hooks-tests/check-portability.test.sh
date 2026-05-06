#!/usr/bin/env bash
# Regression tests for scripts/check-portability.sh
#
# Each case builds a self-contained ephemeral git repo in a tmpdir, copies
# the helper into it, makes a base commit, then commits a "diff under test"
# on a feature branch. The helper is invoked with the base commit's ref
# and its exit code + stdout are asserted against expectations.
#
# Run: bash .claude/hooks-tests/check-portability.test.sh
# Or:  pnpm test:hooks

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
HELPER="$REPO_ROOT/scripts/check-portability.sh"

if [ ! -x "$HELPER" ]; then
  printf 'FAIL: helper not found or not executable at %s\n' "$HELPER" >&2
  exit 1
fi

PASS=0
FAIL=0
FAILED_CASES=()

# Each case runs in its own tmpdir to keep state isolated.
make_repo() {
  local dir
  dir=$(mktemp -d -t check-portability.XXXXXX)
  (
    cd "$dir"
    git init -q -b main
    git config user.email "test@example.com"
    git config user.name "test"
    cp "$HELPER" check-portability.sh
    chmod +x check-portability.sh
    : > base.txt
    git add . >/dev/null
    git commit -q -m "base"
  )
  printf '%s' "$dir"
}

assert_case() {
  local name="$1"
  local repo="$2"
  local expected_exit="$3"
  local expected_grep="$4"  # regex to match in stdout, or "" to skip

  local actual_exit out
  out=$(cd "$repo" && bash check-portability.sh main 2>&1) && actual_exit=0 || actual_exit=$?

  local ok=1
  if [ "$actual_exit" != "$expected_exit" ]; then
    ok=0
    printf 'FAIL: %s — expected exit %s, got %s\n' "$name" "$expected_exit" "$actual_exit" >&2
    printf '      output:\n%s\n' "$out" | sed 's/^/        /' >&2
  elif [ -n "$expected_grep" ] && ! printf '%s' "$out" | grep -qE "$expected_grep"; then
    ok=0
    printf 'FAIL: %s — output did not match /%s/\n' "$name" "$expected_grep" >&2
    printf '      output:\n%s\n' "$out" | sed 's/^/        /' >&2
  fi

  if [ "$ok" = 1 ]; then
    PASS=$((PASS + 1))
    printf 'PASS: %s\n' "$name"
  else
    FAIL=$((FAIL + 1))
    FAILED_CASES+=("$name")
  fi

  rm -rf "$repo"
}

# --- Case 1: clean diff exits 0 ---------------------------------------------
case_clean() {
  local repo
  repo=$(make_repo)
  (
    cd "$repo"
    git checkout -q -b feature
    printf 'export FOO=$HOME/bar\n' > new.sh
    git add . >/dev/null
    git commit -q -m "add file with no personal paths"
  )
  assert_case "clean diff" "$repo" 0 'no user-specific absolute paths'
}

# --- Case 2: Linux /home/<user>/ flagged ------------------------------------
case_linux() {
  local repo
  repo=$(make_repo)
  (
    cd "$repo"
    git checkout -q -b feature
    printf 'SRC=/home/alice/git/myrepo\n' > new.sh  # portability-ok (test fixture)
    git add . >/dev/null
    git commit -q -m "linux"
  )
  assert_case "linux personal path flagged" "$repo" 1 '/home/alice/'  # portability-ok (test fixture)
}

# --- Case 3: macOS /Users/<user>/ flagged -----------------------------------
case_macos() {
  local repo
  repo=$(make_repo)
  (
    cd "$repo"
    git checkout -q -b feature
    printf 'SRC=/Users/bob/Library/MyApp\n' > new.sh  # portability-ok (test fixture)
    git add . >/dev/null
    git commit -q -m "macos"
  )
  assert_case "macos personal path flagged" "$repo" 1 '/Users/bob/'  # portability-ok (test fixture)
}

# --- Case 4: Windows C:\Users\<user>\ flagged --------------------------------
case_windows_backslash() {
  local repo
  repo=$(make_repo)
  (
    cd "$repo"
    git checkout -q -b feature
    printf 'SRC="C:\\Users\\carol\\AppData\\Local"\n' > new.sh
    git add . >/dev/null
    git commit -q -m "windows backslash"
  )
  assert_case "windows backslash path flagged" "$repo" 1 'C:\\Users\\carol'
}

# --- Case 5: Windows forward-slash form flagged -----------------------------
case_windows_forwardslash() {
  local repo
  repo=$(make_repo)
  (
    cd "$repo"
    git checkout -q -b feature
    printf 'SRC="C:/Users/dave/Documents"\n' > new.sh  # portability-ok (test fixture)
    git add . >/dev/null
    git commit -q -m "windows forwardslash"
  )
  assert_case "windows forward-slash path flagged" "$repo" 1 'C:/Users/dave'
}

# --- Case 6: <user> placeholder naturally allowed ----------------------------
case_placeholder_lower() {
  local repo
  repo=$(make_repo)
  (
    cd "$repo"
    git checkout -q -b feature
    printf 'doc: see /home/<user>/git/something\n' > new.md
    git add . >/dev/null
    git commit -q -m "placeholder lowercase"
  )
  assert_case "<user> placeholder allowed" "$repo" 0 'no user-specific absolute paths'
}

# --- Case 7: <USER> placeholder naturally allowed ---------------------------
case_placeholder_upper() {
  local repo
  repo=$(make_repo)
  (
    cd "$repo"
    git checkout -q -b feature
    printf 'doc: see /Users/<USER>/git/something\n' > new.md
    git add . >/dev/null
    git commit -q -m "placeholder uppercase"
  )
  assert_case "<USER> placeholder allowed" "$repo" 0 'no user-specific absolute paths'
}

# --- Case 8: portability-ok marker excludes line ----------------------------
case_marker() {
  local repo
  repo=$(make_repo)
  (
    cd "$repo"
    git checkout -q -b feature
    printf 'KOOKR_PROD=/home/jean/git/kookr-prod  # portability-ok\n' > new.sh
    git add . >/dev/null
    git commit -q -m "marker"
  )
  assert_case "portability-ok marker excludes line" "$repo" 0 'no user-specific absolute paths'
}

# --- Case 9: missing base ref skips with exit 0 -----------------------------
case_missing_base() {
  local repo
  repo=$(make_repo)
  (
    cd "$repo"
    git checkout -q -b feature
    printf 'SRC=/home/eve/foo\n' > new.sh  # portability-ok (test fixture)
    git add . >/dev/null
    git commit -q -m "violation but unreachable base"
  )
  local out actual_exit
  out=$(cd "$repo" && bash check-portability.sh nonexistent-base-ref 2>&1) && actual_exit=0 || actual_exit=$?
  if [ "$actual_exit" = 0 ] && printf '%s' "$out" | grep -q 'not found'; then
    PASS=$((PASS + 1))
    printf 'PASS: missing base ref skips with exit 0\n'
  else
    FAIL=$((FAIL + 1))
    FAILED_CASES+=("missing base ref")
    printf 'FAIL: missing base ref — expected exit 0 with "not found" message, got exit %s\n' "$actual_exit" >&2
    printf '      output:\n%s\n' "$out" | sed 's/^/        /' >&2
  fi
  rm -rf "$repo"
}

# --- Run all cases -----------------------------------------------------------
case_clean
case_linux
case_macos
case_windows_backslash
case_windows_forwardslash
case_placeholder_lower
case_placeholder_upper
case_marker
case_missing_base

printf '\n----\n'
printf 'check-portability tests: %d passed, %d failed.\n' "$PASS" "$FAIL"
if [ "$FAIL" -ne 0 ]; then
  printf 'failed cases:\n'
  printf '  - %s\n' "${FAILED_CASES[@]}"
  exit 1
fi
exit 0
