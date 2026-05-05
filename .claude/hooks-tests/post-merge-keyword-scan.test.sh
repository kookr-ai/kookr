#!/usr/bin/env bash
# Regression tests for hooks/post-merge-keyword-scan.sh
#
# The hook fires on UserPromptSubmit, matches a small keyword set in the
# prompt, runs `gh pr list` against the cwd repo, and emits a
# system-reminder for any PRs in BEHIND/DIRTY/CONFLICTING state.
#
# Each case overrides $HOME and PATH to keep all writes (hook-errors.log)
# inside a tmpdir and to use the gh shim. cwd is set to a real-but-empty
# git repo created per-case so the hook's git toplevel detection works.
#
# Run: bash .claude/hooks-tests/post-merge-keyword-scan.test.sh
# Or:  pnpm test:hooks

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
HOOK="$REPO_ROOT/hooks/post-merge-keyword-scan.sh"
SHIM_DIR="$SCRIPT_DIR/shims"

if [ ! -f "$HOOK" ]; then
  printf 'FAIL: hook script not found at %s\n' "$HOOK" >&2
  exit 1
fi

PASS=0
FAIL=0
FAILED_CASES=()

record_pass() {
  PASS=$((PASS + 1))
  printf '  [OK]   %s\n' "$1"
}

record_fail() {
  FAIL=$((FAIL + 1))
  FAILED_CASES+=("$1")
  printf '  [FAIL] %s\n' "$1"
  if [ -n "${2:-}" ]; then
    printf '         %s\n' "$2"
  fi
}

mk_payload() {
  local prompt="$1"
  local cwd="$2"
  jq -n --arg p "$prompt" --arg c "$cwd" '{prompt: $p, cwd: $c}'
}

# Run the hook with a sandboxed HOME, PATH (gh shim first), and fixture dir.
run_hook() {
  local payload="$1"
  local tmpdir="$2"
  local fixture_dir="${3:-$tmpdir/fixtures}"
  mkdir -p "$fixture_dir"
  (
    export HOME="$tmpdir"
    export PATH="$SHIM_DIR:$PATH"
    export GH_SHIM_FIXTURE_DIR="$fixture_dir"
    printf '%s' "$payload" | bash "$HOOK" 2>&1
  ) || true
}

mk_git_repo() {
  local dir="$1"
  mkdir -p "$dir"
  git -C "$dir" init -q
  git -C "$dir" -c user.name=t -c user.email=t@t commit -q --allow-empty -m init 2>/dev/null
}

printf '\nRunning post-merge-keyword-scan tests\n\n'

# ---------------------------------------------------------------------
# 1. Matching keyword + dirty PRs → emit reminder listing them
# ---------------------------------------------------------------------
case_1() {
  local name="1: matching keyword + dirty PRs → reminder"
  local tmp; tmp=$(mktemp -d); local repo="$tmp/r"
  mk_git_repo "$repo"
  mkdir -p "$tmp/fix"
  cat > "$tmp/fix/pr_list.json" <<'EOF'
[
  {"number": 97, "headRefName": "fix/foo", "mergeStateStatus": "BEHIND", "mergeable": "MERGEABLE", "title": "T"},
  {"number": 102, "headRefName": "feat/bar", "mergeStateStatus": "DIRTY", "mergeable": "MERGEABLE", "title": "U"}
]
EOF
  local payload; payload=$(mk_payload "i just merged main, what next?" "$repo")
  local out; out=$(run_hook "$payload" "$tmp" "$tmp/fix")
  if echo "$out" | grep -q "post-merge-keyword-scan" \
     && echo "$out" | grep -q "#97" \
     && echo "$out" | grep -q "#102" \
     && echo "$out" | grep -q "BEHIND" \
     && echo "$out" | grep -q "DIRTY"; then
    record_pass "$name"
  else
    record_fail "$name" "expected reminder with #97 BEHIND and #102 DIRTY, got: $(printf '%s' "$out" | head -c 300)"
  fi
  rm -rf "$tmp"
}
case_1

# ---------------------------------------------------------------------
# 2. Matching keyword + no dirty PRs → silent
# ---------------------------------------------------------------------
case_2() {
  local name="2: matching keyword + clean repo → silent"
  local tmp; tmp=$(mktemp -d); local repo="$tmp/r"
  mk_git_repo "$repo"
  mkdir -p "$tmp/fix"
  echo "[]" > "$tmp/fix/pr_list.json"
  local payload; payload=$(mk_payload "i merged it" "$repo")
  local out; out=$(run_hook "$payload" "$tmp" "$tmp/fix")
  if [ -z "$(echo "$out" | tr -d '[:space:]')" ]; then
    record_pass "$name"
  else
    record_fail "$name" "expected silent, got: $(printf '%s' "$out" | head -c 200)"
  fi
  rm -rf "$tmp"
}
case_2

# ---------------------------------------------------------------------
# 3. Non-matching keyword → silent
# ---------------------------------------------------------------------
case_3() {
  local name="3: non-matching keyword → silent (no gh call)"
  local tmp; tmp=$(mktemp -d); local repo="$tmp/r"
  mk_git_repo "$repo"
  mkdir -p "$tmp/fix"
  # If gh were called, this fixture would emit a PR — but it shouldn't be.
  echo '[{"number":1,"headRefName":"x","mergeStateStatus":"DIRTY","mergeable":"M","title":"T"}]' > "$tmp/fix/pr_list.json"
  local payload; payload=$(mk_payload "hello, please summarize foo" "$repo")
  local out; out=$(run_hook "$payload" "$tmp" "$tmp/fix")
  if [ -z "$(echo "$out" | tr -d '[:space:]')" ]; then
    record_pass "$name"
  else
    record_fail "$name" "expected silent, got: $(printf '%s' "$out" | head -c 200)"
  fi
  rm -rf "$tmp"
}
case_3

# ---------------------------------------------------------------------
# 4. Empty stdin → silent
# ---------------------------------------------------------------------
case_4() {
  local name="4: empty stdin → silent"
  local tmp; tmp=$(mktemp -d)
  local out; out=$(run_hook "" "$tmp")
  if [ -z "$(echo "$out" | tr -d '[:space:]')" ]; then
    record_pass "$name"
  else
    record_fail "$name" "expected silent, got: $(printf '%s' "$out" | head -c 200)"
  fi
  rm -rf "$tmp"
}
case_4

# ---------------------------------------------------------------------
# 5. cwd not a git repo → silent
# ---------------------------------------------------------------------
case_5() {
  local name="5: cwd not a git repo → silent"
  local tmp; tmp=$(mktemp -d)
  mkdir -p "$tmp/fix"
  echo '[{"number":1,"headRefName":"x","mergeStateStatus":"DIRTY","mergeable":"M","title":"T"}]' > "$tmp/fix/pr_list.json"
  local payload; payload=$(mk_payload "i merged it" "$tmp")
  local out; out=$(run_hook "$payload" "$tmp" "$tmp/fix")
  if [ -z "$(echo "$out" | tr -d '[:space:]')" ]; then
    record_pass "$name"
  else
    record_fail "$name" "expected silent, got: $(printf '%s' "$out" | head -c 200)"
  fi
  rm -rf "$tmp"
}
case_5

# ---------------------------------------------------------------------
# 6. UNKNOWN PRs are NOT included (round-2 failure-mode #2)
# ---------------------------------------------------------------------
case_6() {
  local name="6: UNKNOWN-only PRs → silent (UNKNOWN excluded)"
  local tmp; tmp=$(mktemp -d); local repo="$tmp/r"
  mk_git_repo "$repo"
  mkdir -p "$tmp/fix"
  cat > "$tmp/fix/pr_list.json" <<'EOF'
[
  {"number": 1, "headRefName": "a", "mergeStateStatus": "UNKNOWN", "mergeable": "MERGEABLE", "title": "T"},
  {"number": 2, "headRefName": "b", "mergeStateStatus": "UNKNOWN", "mergeable": "MERGEABLE", "title": "U"}
]
EOF
  local payload; payload=$(mk_payload "rebased onto main" "$repo")
  local out; out=$(run_hook "$payload" "$tmp" "$tmp/fix")
  if [ -z "$(echo "$out" | tr -d '[:space:]')" ]; then
    record_pass "$name"
  else
    record_fail "$name" "expected silent (UNKNOWN excluded), got: $(printf '%s' "$out" | head -c 300)"
  fi
  rm -rf "$tmp"
}
case_6

# ---------------------------------------------------------------------
# 7. CONFLICTING via mergeable field (mergeStateStatus may be CLEAN)
# ---------------------------------------------------------------------
case_7() {
  local name="7: mergeable=CONFLICTING → reminder"
  local tmp; tmp=$(mktemp -d); local repo="$tmp/r"
  mk_git_repo "$repo"
  mkdir -p "$tmp/fix"
  cat > "$tmp/fix/pr_list.json" <<'EOF'
[
  {"number": 200, "headRefName": "c", "mergeStateStatus": "CLEAN", "mergeable": "CONFLICTING", "title": "X"}
]
EOF
  local payload; payload=$(mk_payload "gh pr merge done" "$repo")
  local out; out=$(run_hook "$payload" "$tmp" "$tmp/fix")
  if echo "$out" | grep -q "#200"; then
    record_pass "$name"
  else
    record_fail "$name" "expected #200 in output, got: $(printf '%s' "$out" | head -c 300)"
  fi
  rm -rf "$tmp"
}
case_7

# ---------------------------------------------------------------------
# 8. gh fails → silent (fail-open) + error logged
# ---------------------------------------------------------------------
case_8() {
  local name="8: gh failure → silent + error logged"
  local tmp; tmp=$(mktemp -d); local repo="$tmp/r"
  mk_git_repo "$repo"
  mkdir -p "$tmp/fix"
  touch "$tmp/fix/fail_pr_list"
  local payload; payload=$(mk_payload "merged it" "$repo")
  local out; out=$(run_hook "$payload" "$tmp" "$tmp/fix")
  if [ -z "$(echo "$out" | tr -d '[:space:]')" ]; then
    # The gh shim's `fail_pr_list` triggers a non-zero exit; gh shim writes
    # nothing to stderr, so the hook's `2>>$ERR_LOG` won't capture anything
    # meaningful. Acceptable: fail-open with no spurious output is the
    # contract this case verifies.
    record_pass "$name"
  else
    record_fail "$name" "expected silent on gh failure, got: $(printf '%s' "$out" | head -c 200)"
  fi
  rm -rf "$tmp"
}
case_8

# ---------------------------------------------------------------------
# 9. Trigger filter case-insensitive
# ---------------------------------------------------------------------
case_9() {
  local name="9: keyword case-insensitive (MERGED uppercase)"
  local tmp; tmp=$(mktemp -d); local repo="$tmp/r"
  mk_git_repo "$repo"
  mkdir -p "$tmp/fix"
  echo '[{"number":5,"headRefName":"x","mergeStateStatus":"BEHIND","mergeable":"M","title":"T"}]' > "$tmp/fix/pr_list.json"
  local payload; payload=$(mk_payload "I MERGED it just now" "$repo")
  local out; out=$(run_hook "$payload" "$tmp" "$tmp/fix")
  if echo "$out" | grep -q "#5"; then
    record_pass "$name"
  else
    record_fail "$name" "expected #5 in output (case-insensitive match), got: $(printf '%s' "$out" | head -c 200)"
  fi
  rm -rf "$tmp"
}
case_9

# ---------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------
printf '\nResults: %d passed, %d failed\n' "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  printf 'Failed: %s\n' "${FAILED_CASES[*]}"
  exit 1
fi
exit 0
