#!/usr/bin/env bash
# Regression tests for hooks/git-identity-guard.sh.
#
# The guard rejects a push when the repo-LOCAL git identity is a reserved
# test/documentation address (RFC 2606: example.com/.org/.net). It must NOT
# fire on a real local override or on an unset local identity, and must never
# read the user's global identity.

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
GUARD="$REPO_ROOT/hooks/git-identity-guard.sh"

PASS=0
FAIL=0

# Resolve to the physical path — on macOS `mktemp -d` yields /var/folders/...
# while the guard's `cd` + git see /private/var/folders/... ; keep them equal.
# Pass the template as a positional arg (GNU and BSD agree) rather than `-t`,
# whose semantics diverge — BSD treats the arg as a literal prefix. No `-b main`:
# the guard reads only user.email, never a branch, so an initial branch is
# irrelevant and `-b` would need git >= 2.28 that stock macOS git may lack.
make_repo() {
  local dir
  dir=$(cd "$(mktemp -d "${TMPDIR:-/tmp}/git-identity-guard.XXXXXX")" && pwd -P)
  git -C "$dir" init -q
  printf '%s' "$dir"
}

# Each case sets the local identity (or not) and asserts the guard's exit code.
assert_identity() {
  local name="$1" email="$2" uname="$3" expected_exit="$4" expected_grep="${5:-}"
  local repo out actual_exit
  repo=$(make_repo)
  [ -n "$email" ] && git -C "$repo" config user.email "$email"
  [ -n "$uname" ] && git -C "$repo" config user.name "$uname"

  out=$(bash "$GUARD" "$repo" 2>&1) && actual_exit=0 || actual_exit=$?
  rm -rf "$repo"

  local ok=1
  if [ "$actual_exit" != "$expected_exit" ]; then
    ok=0
    printf 'FAIL: %s — expected exit %s, got %s\n%s\n' "$name" "$expected_exit" "$actual_exit" "$out" >&2
  elif [ -n "$expected_grep" ] && ! printf '%s' "$out" | grep -qE "$expected_grep"; then
    ok=0
    printf 'FAIL: %s — output did not match /%s/\n%s\n' "$name" "$expected_grep" "$out" >&2
  fi

  if [ "$ok" = 1 ]; then
    PASS=$((PASS + 1)); printf 'PASS: %s\n' "$name"
  else
    FAIL=$((FAIL + 1))
  fi
}

# --- Clean states: guard must stay silent and pass -------------------------
assert_identity "no local identity set (global applies)"        ""                   ""            0
assert_identity "real local override — company address"         "dev@company.com"    "Dev"         0
assert_identity "real local override — gmail"                   "jane@gmail.com"     "Jane"        0
# A name containing 'test' with a real email must NOT trip — we key on the
# email domain only, so real people named Test are safe.
assert_identity "real email, name literally 'Test'"             "t@company.io"       "Test"        0

# --- Poisoned states: guard must reject with the remediation ---------------
assert_identity "classic poison — test@example.com / Kookr Test" "test@example.com"  "Kookr Test"  1 "remove-section user"
assert_identity "example.org reserved domain"                    "ci@example.org"    "CI"          1 "test/fixture identity"
assert_identity "example.net reserved domain"                    "x@example.net"     "X"           1 "test/fixture identity"
assert_identity "subdomain .example TLD"                         "bot@build.example" "Bot"         1 "test/fixture identity"
# Case-insensitive: reserved domains trip regardless of case.
assert_identity "uppercase EXAMPLE.COM"                          "TEST@EXAMPLE.COM"  "T"           1 "test/fixture identity"
# Poison with no local name still trips (email is the signal).
assert_identity "poisoned email, no local name"                  "test@example.com"  ""            1 "remove-section user"

# --- Adjacent-but-real domains must NOT trip (no over-matching) ------------
# 'example.com' as a substring of a real domain must not false-positive.
assert_identity "real domain containing 'example'"              "me@example.company" "Me"          0
assert_identity "real domain — myexample.com"                    "me@myexample.com"  "Me"          0

printf '\nResults: %s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
