#!/usr/bin/env bash
# Regression tests for scripts/check-shell-portability.sh
#
# Each case builds a self-contained ephemeral git repo in a tmpdir, copies the
# helper into it, makes a base commit, then commits a "diff under test" on a
# feature branch. The helper is invoked with the base commit's ref and its exit
# code + stdout are asserted against expectations.
#
# Run: bash .claude/hooks-tests/check-shell-portability.test.sh
# Or:  pnpm test:hooks

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
HELPER="$REPO_ROOT/scripts/check-shell-portability.sh"

if [ ! -x "$HELPER" ]; then
  printf 'FAIL: helper not found or not executable at %s\n' "$HELPER" >&2
  exit 1
fi

PASS=0
FAIL=0
FAILED_CASES=()

make_repo() {
  local dir
  dir=$(mktemp -d -t check-shell-portability.XXXXXX)
  (
    cd "$dir"
    git init -q -b main
    git config user.email "test@example.com"
    git config user.name "test"
    cp "$HELPER" check-shell-portability.sh
    chmod +x check-shell-portability.sh
    : > base.txt
    git add . >/dev/null
    git commit -q -m "base"
  )
  printf '%s' "$dir"
}

# commit_line CONTENT — make a feature branch whose only added line is CONTENT.
# Uses a heredoc so the fixture line is written verbatim (no echo -e quirks).
commit_line() {
  local repo="$1"
  local content="$2"
  (
    cd "$repo"
    git checkout -q -b feature
    printf '%s\n' "$content" > new.sh
    git add . >/dev/null
    git commit -q -m "diff under test"
  )
}

assert_case() {
  local name="$1"
  local repo="$2"
  local expected_exit="$3"
  local expected_grep="$4"  # regex to match in stdout, or "" to skip

  local actual_exit out
  out=$(cd "$repo" && bash check-shell-portability.sh main 2>&1) && actual_exit=0 || actual_exit=$?

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

# flagged NAME CONTENT GREP — expects exit 1 and GREP in output.
flagged() {
  local repo; repo=$(make_repo)
  commit_line "$repo" "$2"
  assert_case "$1" "$repo" 1 "$3"
}

# allowed NAME CONTENT — expects exit 0 (clean).
allowed() {
  local repo; repo=$(make_repo)
  commit_line "$repo" "$2"
  assert_case "$1" "$repo" 0 'no GNU-only'
}

# --- Clean baseline ---------------------------------------------------------
allowed "portable line is clean" 'grep -E "foo" file | sed -E "s/a/b/"'

# --- BSD vs GNU coreutils flags ---------------------------------------------
flagged "grep -P flagged"        'grep -P "\\d+" file'        'grep -P'
flagged "grep -oP flagged"       'grep -oP "\\d+" file'       'grep -P'
flagged "readlink -f flagged"    'readlink -f "$0"'           'readlink -f'
flagged "stat -c flagged"        'stat -c "%a" file'          'stat -c'
flagged "date -d flagged"        'date -d "yesterday"'        'date -d'
flagged "sed -r flagged"         'sed -r "s/a+/b/" file'      'sed -r'
flagged "find -printf flagged"   'find . -printf "%p\\n"'     'find -printf'
flagged "xargs -r flagged"       'printf "" | xargs -r rm'    'xargs -r'
# Clustered flags must not slip past a trailing word boundary.
flagged "sed -rn cluster flagged"  'sed -rn "s/a/b/p" file'   'sed -r'
flagged "sed -nr cluster flagged"  'sed -nr "s/a/b/p" file'   'sed -r'
flagged "xargs -0r cluster flagged" 'printf "" | xargs -0r rm' 'xargs -r'
allowed "sed -E not flagged"       'sed -E "s/a+/b/" file'
allowed "xargs -I{} not flagged"   'find . | xargs -I{} rm {}'
allowed "date +format not flagged" 'date +%Y-%m-%d'

# --- sed -i suffix handling -------------------------------------------------
flagged "sed -i no suffix flagged" "sed -i 's/a/b/' file"     'sed -i without an explicit suffix'
allowed "sed -i.bak allowed"       "sed -i.bak 's/a/b/' file && rm file.bak"
allowed "sed -i empty-suffix allowed" "sed -i '' 's/a/b/' file"
allowed "sed -i'' attached-empty allowed" "sed -i'' 's/a/b/' file"

# --- bash 4+ syntax (macOS bash is 3.2) -------------------------------------
flagged "mapfile flagged"        'mapfile -t arr < file'      'mapfile'
flagged "readarray flagged"      'readarray -t arr < file'    'readarray'
flagged "lowercase expansion flagged" 'x="${name,,}"'         'case conversion'
flagged "uppercase expansion flagged" 'x="${name^^}"'         'case conversion'
flagged "declare -A flagged"     'declare -A map'             'associative arrays'
flagged "local -A flagged"       'local -A map'               'associative arrays'
flagged "echo -n flagged"        'echo -n "no newline"'       'echo -e/-n'
flagged "echo -e flagged"        'echo -e "a\\tb"'            'echo -e/-n'
flagged "echo -en cluster flagged" 'echo -en "x"'             'echo -e/-n'
flagged "echo -ne cluster flagged" 'echo -ne "x"'             'echo -e/-n'
allowed "declare -a not flagged" 'declare -a myarr'

# --- portability-ok opt-out -------------------------------------------------
allowed "portability-ok suppresses" 'grep -P "x" file  # portability-ok: linux-only path'

# --- Markdown is prose, not scanned -----------------------------------------
case_markdown_excluded() {
  local repo; repo=$(make_repo)
  (
    cd "$repo"
    git checkout -q -b feature
    printf 'Docs may quote `grep -P` and `declare -A` as examples.\n' > new.md
    git add . >/dev/null
    git commit -q -m "doc that mentions idioms"
  )
  assert_case "markdown idioms are not flagged" "$repo" 0 'no GNU-only'
}
case_markdown_excluded

# --- multi-hit: every violation in a diff is reported -----------------------
case_multi_hit() {
  local repo; repo=$(make_repo)
  (
    cd "$repo"; git checkout -q -b feature
    printf 'grep -P "x" a\ndate -d "yesterday" b\n' > new.sh
    git add . >/dev/null; git commit -q -m "two violations"
  )
  local out actual_exit
  out=$(cd "$repo" && bash check-shell-portability.sh main 2>&1) && actual_exit=0 || actual_exit=$?
  if [ "$actual_exit" = 1 ] \
    && printf '%s' "$out" | grep -q 'grep -P' \
    && printf '%s' "$out" | grep -q 'date -d'; then
    PASS=$((PASS + 1)); printf 'PASS: multi-hit reports all violations\n'
  else
    FAIL=$((FAIL + 1)); FAILED_CASES+=("multi-hit")
    printf 'FAIL: multi-hit — expected exit 1 with both rules, got exit %s\n' "$actual_exit" >&2
    printf '      output:\n%s\n' "$out" | sed 's/^/        /' >&2
  fi
  rm -rf "$repo"
}
case_multi_hit

# --- portability-ok is per-line, not a global mute --------------------------
case_partial_suppress() {
  local repo; repo=$(make_repo)
  (
    cd "$repo"; git checkout -q -b feature
    printf 'grep -P "ok" a  # portability-ok\ngrep -P "bad" b\n' > new.sh
    git add . >/dev/null; git commit -q -m "one suppressed, one not"
  )
  assert_case "partial portability-ok still catches the rest" "$repo" 1 'grep -P'
}
case_partial_suppress

# --- explicit unresolvable base ref is a hard error (exit 2) ----------------
case_explicit_bad_base() {
  local repo; repo=$(make_repo)
  commit_line "$repo" 'grep -P "x" file'
  local out actual_exit
  out=$(cd "$repo" && bash check-shell-portability.sh nonexistent-base-ref 2>&1) && actual_exit=0 || actual_exit=$?
  if [ "$actual_exit" = 2 ] && printf '%s' "$out" | grep -q 'unresolvable'; then
    PASS=$((PASS + 1)); printf 'PASS: explicit unresolvable base ref errors (exit 2)\n'
  else
    FAIL=$((FAIL + 1)); FAILED_CASES+=("explicit bad base")
    printf 'FAIL: explicit bad base — expected exit 2 with "unresolvable", got exit %s\n' "$actual_exit" >&2
    printf '      output:\n%s\n' "$out" | sed 's/^/        /' >&2
  fi
  rm -rf "$repo"
}
case_explicit_bad_base

# --- no base arg + default origin/main absent → skip with exit 0 ------------
case_default_base_missing() {
  local repo; repo=$(make_repo)
  commit_line "$repo" 'grep -P "x" file'
  local out actual_exit
  out=$(cd "$repo" && bash check-shell-portability.sh 2>&1) && actual_exit=0 || actual_exit=$?
  if [ "$actual_exit" = 0 ] && printf '%s' "$out" | grep -q 'skipping'; then
    PASS=$((PASS + 1)); printf 'PASS: missing default base skips with exit 0\n'
  else
    FAIL=$((FAIL + 1)); FAILED_CASES+=("default base missing")
    printf 'FAIL: default base missing — expected exit 0 with "skipping", got exit %s\n' "$actual_exit" >&2
    printf '      output:\n%s\n' "$out" | sed 's/^/        /' >&2
  fi
  rm -rf "$repo"
}
case_default_base_missing

# --- caller-selected paths restrict what the helper scans ------------------
case_caller_paths_restrict_scan() {
  local repo; repo=$(make_repo)
  (
    cd "$repo"
    git update-ref refs/remotes/origin/main main
    git checkout -q -b feature
    mkdir -p src scripts
    printf 'const example = "readlink -f /tmp";\n' > src/note.ts
    printf 'grep -E "x" file\n' > scripts/portable.sh
    git add . >/dev/null
    git commit -q -m "mixed diff"
    printf 'scripts/portable.sh\n' > paths.txt
  )
  local out actual_exit
  out=$(cd "$repo" && SHELL_PORTABILITY_PATHS_FILE=paths.txt bash check-shell-portability.sh 2>&1) && actual_exit=0 || actual_exit=$?
  if [ "$actual_exit" = 0 ] && printf '%s' "$out" | grep -q 'no GNU-only'; then
    PASS=$((PASS + 1)); printf 'PASS: caller-selected paths restrict scan\n'
  else
    FAIL=$((FAIL + 1)); FAILED_CASES+=("caller paths restrict scan")
    printf 'FAIL: caller paths restrict scan — expected exit 0, got exit %s\n' "$actual_exit" >&2
    printf '      output:\n%s\n' "$out" | sed 's/^/        /' >&2
  fi
  rm -rf "$repo"
}
case_caller_paths_restrict_scan

case_caller_paths_still_scan_selected_violation() {
  local repo; repo=$(make_repo)
  (
    cd "$repo"
    git update-ref refs/remotes/origin/main main
    git checkout -q -b feature
    mkdir -p src scripts
    printf 'const example = "readlink -f /tmp";\n' > src/note.ts
    printf 'grep -P "x" file\n' > scripts/unsafe.sh
    git add . >/dev/null
    git commit -q -m "selected violation"
    printf 'scripts/unsafe.sh\n' > paths.txt
  )
  local out actual_exit
  out=$(cd "$repo" && SHELL_PORTABILITY_PATHS_FILE=paths.txt bash check-shell-portability.sh 2>&1) && actual_exit=0 || actual_exit=$?
  if [ "$actual_exit" = 1 ] && printf '%s' "$out" | grep -q 'grep -P'; then
    PASS=$((PASS + 1)); printf 'PASS: caller-selected paths still scan violations\n'
  else
    FAIL=$((FAIL + 1)); FAILED_CASES+=("caller paths scan selected violation")
    printf 'FAIL: caller paths scan selected violation — expected exit 1, got exit %s\n' "$actual_exit" >&2
    printf '      output:\n%s\n' "$out" | sed 's/^/        /' >&2
  fi
  rm -rf "$repo"
}
case_caller_paths_still_scan_selected_violation

case_empty_caller_paths_file() {
  local repo; repo=$(make_repo)
  commit_line "$repo" 'grep -P "x" file'
  : > "$repo/paths.txt"
  local out actual_exit
  out=$(cd "$repo" && SHELL_PORTABILITY_PATHS_FILE=paths.txt bash check-shell-portability.sh main 2>&1) && actual_exit=0 || actual_exit=$?
  if [ "$actual_exit" = 0 ] && printf '%s' "$out" | grep -q 'no caller-selected paths'; then
    PASS=$((PASS + 1)); printf 'PASS: empty caller paths file skips cleanly\n'
  else
    FAIL=$((FAIL + 1)); FAILED_CASES+=("empty caller paths file")
    printf 'FAIL: empty caller paths file — expected exit 0, got exit %s\n' "$actual_exit" >&2
    printf '      output:\n%s\n' "$out" | sed 's/^/        /' >&2
  fi
  rm -rf "$repo"
}
case_empty_caller_paths_file

# --- full-tree scan for first-push/fresh-clone hooks -----------------------
case_scan_all_without_base() {
  local repo; repo=$(make_repo)
  (
    cd "$repo"
    git checkout -q -b feature
    printf 'readlink -f "$0"\n' > new.sh
    git add . >/dev/null
    git commit -q -m "full tree scan"
    git update-ref -d refs/remotes/origin/main 2>/dev/null || true
    printf 'new.sh\n' > paths.txt
  )
  local out actual_exit
  out=$(cd "$repo" && SHELL_PORTABILITY_PATHS_FILE=paths.txt SHELL_PORTABILITY_SCAN_ALL=1 bash check-shell-portability.sh 2>&1) && actual_exit=0 || actual_exit=$?
  if [ "$actual_exit" = 1 ] && printf '%s' "$out" | grep -q 'readlink -f'; then
    PASS=$((PASS + 1)); printf 'PASS: full-tree scan works without origin/main\n'
  else
    FAIL=$((FAIL + 1)); FAILED_CASES+=("scan all without base")
    printf 'FAIL: scan all without base — expected exit 1, got exit %s\n' "$actual_exit" >&2
    printf '      output:\n%s\n' "$out" | sed 's/^/        /' >&2
  fi
  rm -rf "$repo"
}
case_scan_all_without_base

printf '\n----\n'
printf 'check-shell-portability tests: %d passed, %d failed.\n' "$PASS" "$FAIL"
if [ "$FAIL" -ne 0 ]; then
  printf 'failed cases:\n'
  printf '  - %s\n' "${FAILED_CASES[@]}"
  exit 1
fi
exit 0
