#!/usr/bin/env bash
# Regression tests for hooks/pr-workflow-gate.sh
#
# The hook has no external command dependencies beyond jq, git, and basename,
# and never calls gh, so no PATH shims are needed. State lives in /dev/shm
# (hardcoded in the hook) and errors go to $HOME/.kookr/hook-errors.log —
# we override $HOME per case to keep log writes inside a tmpdir.
#
# Each case uses unique /dev/shm filenames ("pr-gate-<unique>-...") so it
# cannot collide with state from a running Kookr instance on the same box,
# and every case cleans up its own /dev/shm entries at the end.
#
# Run: bash .claude/hooks-tests/pr-workflow-gate.test.sh
# Or:  pnpm test:hooks

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
HOOK="$REPO_ROOT/hooks/pr-workflow-gate.sh"

if [ ! -x "$HOOK" ] && [ ! -f "$HOOK" ]; then
  printf 'FAIL: hook script not found at %s\n' "$HOOK" >&2
  exit 1
fi

# Unique suffix so /dev/shm keys cannot collide with real repos or parallel
# invocations. Includes PID and epoch nanoseconds.
SUFFIX="t$$-$(date +%s%N 2>/dev/null || date +%s)"

PASS=0
FAIL=0
FAILED_CASES=()

# Track every /dev/shm file we touch so we can clean up even on early exit.
CREATED_STATE_FILES=()
cleanup_state() {
  local f
  for f in "${CREATED_STATE_FILES[@]:-}"; do
    [ -n "$f" ] && rm -f "$f" 2>/dev/null || true
  done
}
trap cleanup_state EXIT

track_state_file() {
  CREATED_STATE_FILES+=("$1")
}

# Build a PreToolUse payload for `gh pr create`. Positional args:
#   $1 command        — the full shell command string
#   $2 cwd (optional) — defaults to /tmp
mk_payload() {
  local cmd="$1"
  local cwd="${2:-/tmp}"
  jq -n --arg cmd "$cmd" --arg cwd "$cwd" '{
    tool_name: "Bash",
    cwd: $cwd,
    tool_input: { command: $cmd }
  }'
}

# Run the hook. Stdin = $payload. Stdout+stderr captured.
#   run_hook <payload> <tmpdir>
# HOME is exported inside a subshell so the hook's own $HOME (used for
# hook-errors.log and for mkdir) resolves to the tmpdir, not the real home.
# A simple "HOME=X cmd | bash" only scopes the var to the left-hand command.
run_hook() {
  local payload="$1"
  local tmpdir="$2"
  (
    export HOME="$tmpdir"
    printf '%s' "$payload" | bash "$HOOK" 2>&1
  ) || true
}

# Classify hook output: "allow" (no deny JSON body) vs "deny".
classify() {
  local out="$1"
  if printf '%s' "$out" | grep -q '"permissionDecision": "deny"'; then
    printf 'deny'
  else
    printf 'allow'
  fi
}

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

printf '\nRunning pr-workflow-gate regression tests\n\n'

# ---------------------------------------------------------------------
# 1. Allow when state file exists — and state file is sticky (not consumed).
# ---------------------------------------------------------------------
run_case_1() {
  local name="1: state file present → allow (state sticky)"
  local tmpdir; tmpdir=$(mktemp -d)
  local repo="repoA-$SUFFIX"
  local branch="branchA"
  local state="/dev/shm/.pr-gate-${repo}-${branch}-pre-done"
  track_state_file "$state"
  rm -f "$state"
  touch "$state"

  local cmd="gh pr create -R testowner/${repo} --head ${branch} --title t --body b"
  local payload; payload=$(mk_payload "$cmd")
  local out; out=$(run_hook "$payload" "$tmpdir")

  if [ "$(classify "$out")" != "allow" ]; then
    record_fail "$name" "expected allow, got deny: $(printf '%s' "$out" | head -c 200)"
  elif [ ! -f "$state" ]; then
    record_fail "$name" "state file was consumed but should be sticky"
  else
    record_pass "$name"
  fi

  rm -f "$state"
  rm -rf "$tmpdir"
}
run_case_1

# ---------------------------------------------------------------------
# 2. Deny with expected reason when state file is missing.
# ---------------------------------------------------------------------
run_case_2() {
  local name="2: state file missing → deny with expected reason"
  local tmpdir; tmpdir=$(mktemp -d)
  local repo="repoB-$SUFFIX"
  local branch="branchB"
  local state="/dev/shm/.pr-gate-${repo}-${branch}-pre-done"
  track_state_file "$state"
  rm -f "$state"

  local cmd="gh pr create -R testowner/${repo} --head ${branch} --title t --body b"
  local payload; payload=$(mk_payload "$cmd")
  local out; out=$(run_hook "$payload" "$tmpdir")

  if [ "$(classify "$out")" != "deny" ]; then
    record_fail "$name" "expected deny, got allow: $(printf '%s' "$out" | head -c 200)"
  elif ! printf '%s' "$out" | grep -q 'Pre-PR review has not been completed'; then
    record_fail "$name" "deny reason missing 'Pre-PR review has not been completed': $(printf '%s' "$out" | head -c 200)"
  else
    record_pass "$name"
  fi

  rm -rf "$tmpdir"
}
run_case_2

# ---------------------------------------------------------------------
# 3. Bypass file is consumed (one-time use).
# ---------------------------------------------------------------------
run_case_3() {
  local name="3: bypass file → allow + consumed"
  local tmpdir; tmpdir=$(mktemp -d)
  local repo="repoC-$SUFFIX"
  local branch="branchC"
  local state="/dev/shm/.pr-gate-${repo}-${branch}-pre-done"
  local bypass="/dev/shm/.pr-gate-${repo}-${branch}-bypass"
  track_state_file "$state"
  track_state_file "$bypass"
  rm -f "$state" "$bypass"
  touch "$bypass"

  local cmd="gh pr create -R testowner/${repo} --head ${branch} --title t --body b"
  local payload; payload=$(mk_payload "$cmd")
  local out; out=$(run_hook "$payload" "$tmpdir")

  if [ "$(classify "$out")" != "allow" ]; then
    record_fail "$name" "expected allow, got deny: $(printf '%s' "$out" | head -c 200)"
  elif [ -f "$bypass" ]; then
    record_fail "$name" "bypass file was not consumed"
  else
    record_pass "$name"
  fi

  rm -f "$state" "$bypass"
  rm -rf "$tmpdir"
}
run_case_3

# ---------------------------------------------------------------------
# 4. Non-`gh pr create` command → silent passthrough (exit 0, no JSON).
# ---------------------------------------------------------------------
run_case_4() {
  local name="4: non-matching command → silent passthrough"
  local tmpdir; tmpdir=$(mktemp -d)

  local payload; payload=$(mk_payload "git status")
  local out; out=$(run_hook "$payload" "$tmpdir")

  if [ -n "$out" ]; then
    record_fail "$name" "expected empty output, got: $(printf '%s' "$out" | head -c 200)"
  else
    record_pass "$name"
  fi

  rm -rf "$tmpdir"
}
run_case_4

# ---------------------------------------------------------------------
# 5. `-R` and `--head` flags are authoritative over cwd-derived key.
#
#    Pre-place a state file at the cwd-derived key (what the hook would
#    compute if it fell back to cwd). Command includes both -R and --head
#    pointing at a DIFFERENT repo/branch whose flag-derived key has NO state.
#    The hook must deny — proving it used the flag-derived key and ignored
#    the cwd-derived one that happens to have state.
# ---------------------------------------------------------------------
run_case_5() {
  local name="5: -R/--head override cwd-derived key"
  local tmpdir; tmpdir=$(mktemp -d)

  # Real git repo at cwd on branch cwdbranch5. Hook only reads cwd as a
  # fallback when a flag is missing, but we set up a valid repo so a buggy
  # build that consulted cwd anyway would find a real branch — this way the
  # failure mode is visibly "wrong state key used", not "hook crashed".
  local cwd_repo_name="cwdrepoE-$SUFFIX"
  local cwd_branch="cwdbranch5"
  local cwd_dir="$tmpdir/$cwd_repo_name"
  mkdir -p "$cwd_dir"
  (
    cd "$cwd_dir" &&
    git init -q --initial-branch="$cwd_branch" 2>/dev/null ||
      { git init -q && git checkout -q -b "$cwd_branch"; }
    git -c user.email=t@t -c user.name=t commit --allow-empty -q -m init
  )

  local flag_repo="flagrepoE-$SUFFIX"
  local flag_branch="flagbranch5"

  local cwd_state="/dev/shm/.pr-gate-${cwd_repo_name}-${cwd_branch}-pre-done"
  local flag_state="/dev/shm/.pr-gate-${flag_repo}-${flag_branch}-pre-done"
  track_state_file "$cwd_state"
  track_state_file "$flag_state"
  rm -f "$cwd_state" "$flag_state"
  touch "$cwd_state"   # only cwd-derived key has state; flag-derived does not

  local cmd="gh pr create -R testowner/${flag_repo} --head ${flag_branch} --title t --body b"
  local payload; payload=$(mk_payload "$cmd" "$cwd_dir")
  local out; out=$(run_hook "$payload" "$tmpdir")

  if [ "$(classify "$out")" != "deny" ]; then
    record_fail "$name" "expected deny (flag-derived key has no state); got allow → hook fell back to cwd"
  elif [ -f "$flag_state" ]; then
    record_fail "$name" "hook unexpectedly created flag-derived state file"
  elif [ ! -f "$cwd_state" ]; then
    record_fail "$name" "cwd-derived state file was touched/consumed"
  else
    record_pass "$name"
  fi

  rm -f "$cwd_state" "$flag_state"
  rm -rf "$tmpdir"
}
run_case_5

# ---------------------------------------------------------------------
# 6a. Malformed (non-JSON) stdin → fail-open (allow) + error logged.
# ---------------------------------------------------------------------
run_case_6a() {
  local name="6a: non-JSON stdin → fail-open + error logged"
  local tmpdir; tmpdir=$(mktemp -d)
  local log="$tmpdir/.kookr/hook-errors.log"

  local out
  out=$(
    (
      export HOME="$tmpdir"
      printf 'not json at all' | bash "$HOOK" 2>&1
    ) || true
  )

  if printf '%s' "$out" | grep -q '"permissionDecision": "deny"'; then
    record_fail "$name" "expected allow (fail-open), got deny"
  elif [ ! -s "$log" ]; then
    record_fail "$name" "expected error-log entry at $log, but file is empty/missing"
  elif ! grep -q 'pr-workflow-gate' "$log"; then
    record_fail "$name" "error log exists but does not name the hook: $(head -c 200 "$log")"
  else
    record_pass "$name"
  fi

  rm -rf "$tmpdir"
}
run_case_6a

# ---------------------------------------------------------------------
# 6b. Valid JSON missing .tool_input.command → silent exit 0 (no block, no log).
# ---------------------------------------------------------------------
run_case_6b() {
  local name="6b: missing tool_input.command → silent passthrough"
  local tmpdir; tmpdir=$(mktemp -d)

  local out
  out=$(
    (
      export HOME="$tmpdir"
      printf '{}' | bash "$HOOK" 2>&1
    ) || true
  )

  if [ -n "$out" ]; then
    record_fail "$name" "expected empty output, got: $(printf '%s' "$out" | head -c 200)"
  else
    record_pass "$name"
  fi

  rm -rf "$tmpdir"
}
run_case_6b

# =====================================================================
# Scope-list regression cases (issue #405)
#
# The scope check consults $HOME/.kookr/pr-gated-repos.json. With $HOME
# overridden to a per-case tmpdir, we can write a scope list into
# $tmpdir/.kookr/pr-gated-repos.json and exercise every branch of the
# owner/repo derivation plus malformed-file handling.
# =====================================================================

write_scope_list() {
  local tmpdir="$1"
  local content="$2"
  mkdir -p "$tmpdir/.kookr"
  printf '%s' "$content" > "$tmpdir/.kookr/pr-gated-repos.json"
}

# Set up a real git repo at $1 with `origin` set to $2.
# Optionally: $3 = upstream URL, $4 = remote name to mark as gh-resolved.
setup_git_repo() {
  local dir="$1"
  local origin_url="$2"
  local upstream_url="${3:-}"
  local resolve_on="${4:-}"
  mkdir -p "$dir"
  (
    cd "$dir"
    git init -q --initial-branch=main 2>/dev/null || { git init -q && git checkout -q -b main; }
    git -c user.email=t@t -c user.name=t commit --allow-empty -q -m init
    git remote add origin "$origin_url"
    [ -n "$upstream_url" ] && git remote add upstream "$upstream_url"
    if [ -n "$resolve_on" ]; then
      git config "remote.${resolve_on}.gh-resolved" base
    fi
  )
}

# ---------------------------------------------------------------------
# A. Scope list absent → today's behavior preserved (deny when state missing).
# ---------------------------------------------------------------------
run_case_A() {
  local name="A: scope list absent → deny (gate-everything default)"
  local tmpdir; tmpdir=$(mktemp -d)
  local repo="repoA-$SUFFIX"
  local branch="branchA"
  local state="/dev/shm/.pr-gate-${repo}-${branch}-pre-done"
  track_state_file "$state"; rm -f "$state"

  local cmd="gh pr create -R testowner/${repo} --head ${branch} --title t --body b"
  local payload; payload=$(mk_payload "$cmd")
  local out; out=$(run_hook "$payload" "$tmpdir")

  if [ "$(classify "$out")" != "deny" ]; then
    record_fail "$name" "expected deny, got allow: $(printf '%s' "$out" | head -c 200)"
  else
    record_pass "$name"
  fi
  rm -rf "$tmpdir"
}
run_case_A

# ---------------------------------------------------------------------
# B. In-scope repo + no state file → deny (normal gate applies).
# ---------------------------------------------------------------------
run_case_B() {
  local name="B: in-scope + no state → deny"
  local tmpdir; tmpdir=$(mktemp -d)
  write_scope_list "$tmpdir" '["testowner/repoB-'"$SUFFIX"'"]'
  local repo="repoB-$SUFFIX"
  local branch="branchB"
  local state="/dev/shm/.pr-gate-${repo}-${branch}-pre-done"
  track_state_file "$state"; rm -f "$state"

  local cmd="gh pr create -R testowner/${repo} --head ${branch} --title t --body b"
  local payload; payload=$(mk_payload "$cmd")
  local out; out=$(run_hook "$payload" "$tmpdir")

  if [ "$(classify "$out")" != "deny" ]; then
    record_fail "$name" "expected deny, got allow: $(printf '%s' "$out" | head -c 200)"
  else
    record_pass "$name"
  fi
  rm -rf "$tmpdir"
}
run_case_B

# ---------------------------------------------------------------------
# C. Out-of-scope repo → allow (hook has no opinion).
# ---------------------------------------------------------------------
run_case_C() {
  local name="C: out-of-scope → allow"
  local tmpdir; tmpdir=$(mktemp -d)
  write_scope_list "$tmpdir" '["kookr-ai/kookr"]'
  local repo="repoC-$SUFFIX"
  local branch="branchC"
  local state="/dev/shm/.pr-gate-unrelated-${repo}-${branch}-pre-done"
  track_state_file "$state"; rm -f "$state"

  local cmd="gh pr create -R unrelated/${repo} --head ${branch} --title t --body b"
  local payload; payload=$(mk_payload "$cmd")
  local out; out=$(run_hook "$payload" "$tmpdir")

  if [ "$(classify "$out")" != "allow" ]; then
    record_fail "$name" "expected allow (out-of-scope), got deny: $(printf '%s' "$out" | head -c 200)"
  else
    record_pass "$name"
  fi
  rm -rf "$tmpdir"
}
run_case_C

# ---------------------------------------------------------------------
# D. Empty array [] → allow everything (opt-in quiet mode).
# ---------------------------------------------------------------------
run_case_D() {
  local name="D: empty array scope list → allow"
  local tmpdir; tmpdir=$(mktemp -d)
  write_scope_list "$tmpdir" '[]'
  local repo="repoD-$SUFFIX"
  local branch="branchD"
  local state="/dev/shm/.pr-gate-${repo}-${branch}-pre-done"
  track_state_file "$state"; rm -f "$state"

  local cmd="gh pr create -R anyone/${repo} --head ${branch} --title t --body b"
  local payload; payload=$(mk_payload "$cmd")
  local out; out=$(run_hook "$payload" "$tmpdir")

  if [ "$(classify "$out")" != "allow" ]; then
    record_fail "$name" "expected allow (empty list = no-op gate), got deny"
  else
    record_pass "$name"
  fi
  rm -rf "$tmpdir"
}
run_case_D

# ---------------------------------------------------------------------
# E1. Non-JSON scope list → deny + error log (fail-closed to gate-everything).
# ---------------------------------------------------------------------
run_case_E1() {
  local name="E1: non-JSON scope list → deny + error log"
  local tmpdir; tmpdir=$(mktemp -d)
  write_scope_list "$tmpdir" 'not json at all'
  local repo="repoE1-$SUFFIX"
  local branch="branchE1"
  local state="/dev/shm/.pr-gate-${repo}-${branch}-pre-done"
  track_state_file "$state"; rm -f "$state"

  local cmd="gh pr create -R testowner/${repo} --head ${branch} --title t --body b"
  local payload; payload=$(mk_payload "$cmd")
  local out; out=$(run_hook "$payload" "$tmpdir")

  local log="$tmpdir/.kookr/hook-errors.log"
  if [ "$(classify "$out")" != "deny" ]; then
    record_fail "$name" "expected deny (fall-through), got allow"
  elif [ ! -s "$log" ] || ! grep -q 'scope list malformed' "$log"; then
    record_fail "$name" "expected 'scope list malformed' entry at $log"
  else
    record_pass "$name"
  fi
  rm -rf "$tmpdir"
}
run_case_E1

# ---------------------------------------------------------------------
# E2. JSON object (wrong shape) scope list → deny + error log.
# ---------------------------------------------------------------------
run_case_E2() {
  local name="E2: JSON object scope list → deny + error log"
  local tmpdir; tmpdir=$(mktemp -d)
  write_scope_list "$tmpdir" '{"not": "an array"}'
  local repo="repoE2-$SUFFIX"
  local branch="branchE2"
  local state="/dev/shm/.pr-gate-${repo}-${branch}-pre-done"
  track_state_file "$state"; rm -f "$state"

  local cmd="gh pr create -R testowner/${repo} --head ${branch} --title t --body b"
  local payload; payload=$(mk_payload "$cmd")
  local out; out=$(run_hook "$payload" "$tmpdir")

  local log="$tmpdir/.kookr/hook-errors.log"
  if [ "$(classify "$out")" != "deny" ]; then
    record_fail "$name" "expected deny (fall-through), got allow"
  elif [ ! -s "$log" ] || ! grep -q 'scope list malformed' "$log"; then
    record_fail "$name" "expected 'scope list malformed' entry"
  else
    record_pass "$name"
  fi
  rm -rf "$tmpdir"
}
run_case_E2

# ---------------------------------------------------------------------
# E3. Mixed-type array (strings + number) → deny + error log.
# ---------------------------------------------------------------------
run_case_E3() {
  local name="E3: mixed-type array scope list → deny + error log"
  local tmpdir; tmpdir=$(mktemp -d)
  write_scope_list "$tmpdir" '["kookr", 42]'
  local repo="repoE3-$SUFFIX"
  local branch="branchE3"
  local state="/dev/shm/.pr-gate-${repo}-${branch}-pre-done"
  track_state_file "$state"; rm -f "$state"

  local cmd="gh pr create -R testowner/${repo} --head ${branch} --title t --body b"
  local payload; payload=$(mk_payload "$cmd")
  local out; out=$(run_hook "$payload" "$tmpdir")

  local log="$tmpdir/.kookr/hook-errors.log"
  if [ "$(classify "$out")" != "deny" ]; then
    record_fail "$name" "expected deny (fall-through), got allow"
  elif [ ! -s "$log" ] || ! grep -q 'scope list malformed' "$log"; then
    record_fail "$name" "expected 'scope list malformed' entry"
  else
    record_pass "$name"
  fi
  rm -rf "$tmpdir"
}
run_case_E3

# ---------------------------------------------------------------------
# F. Case-insensitive match: scope "Owner/Repo" matches payload "owner/repo".
# ---------------------------------------------------------------------
run_case_F() {
  local name="F: case-insensitive match on both sides"
  local tmpdir; tmpdir=$(mktemp -d)
  write_scope_list "$tmpdir" '["TestOwner/RepoF-'"$SUFFIX"'"]'
  local repo="repof-$SUFFIX"  # lowercase
  local branch="branchF"
  local state="/dev/shm/.pr-gate-${repo}-${branch}-pre-done"
  track_state_file "$state"; rm -f "$state"

  local cmd="gh pr create -R testowner/${repo} --head ${branch} --title t --body b"
  local payload; payload=$(mk_payload "$cmd")
  local out; out=$(run_hook "$payload" "$tmpdir")

  if [ "$(classify "$out")" != "deny" ]; then
    record_fail "$name" "expected deny (case-insensitive match), got allow → normalization is one-sided"
  else
    record_pass "$name"
  fi
  rm -rf "$tmpdir"
}
run_case_F

# ---------------------------------------------------------------------
# G1. cwd-derived owner/repo via gh-resolved matches scope list → deny.
# ---------------------------------------------------------------------
run_case_G1() {
  local name="G1: cwd+gh-resolved owner/repo in scope → deny"
  local tmpdir; tmpdir=$(mktemp -d)
  local repo="repoG1-$SUFFIX"
  local branch="main"  # must match the initial-branch used by setup_git_repo
  local cwd_dir="$tmpdir/workdir"
  setup_git_repo "$cwd_dir" "git@github.com:testowner/${repo}.git" "" "origin"

  write_scope_list "$tmpdir" '["testowner/'"$repo"'"]'

  # cwd-fallback uses basename(repo_root) for state-key, not the remote URL.
  local cwd_repo_name
  cwd_repo_name=$(basename "$cwd_dir")
  local state="/dev/shm/.pr-gate-${cwd_repo_name}-${branch}-pre-done"
  track_state_file "$state"; rm -f "$state"

  # No -R flag, no --head — force cwd fallback.
  local cmd="gh pr create --title t --body b"
  local payload; payload=$(mk_payload "$cmd" "$cwd_dir")
  local out; out=$(run_hook "$payload" "$tmpdir")

  if [ "$(classify "$out")" != "deny" ]; then
    record_fail "$name" "expected deny (gh-resolved path should match scope list), got allow: $(printf '%s' "$out" | head -c 300)"
  else
    record_pass "$name"
  fi
  rm -f "$state"
  rm -rf "$tmpdir"
}
run_case_G1

# ---------------------------------------------------------------------
# G2. cwd owner is DIFFERENT from scope-list owner → allow.
#     Catches a buggy implementation comparing bare repo names.
# ---------------------------------------------------------------------
run_case_G2() {
  local name="G2: cwd owner differs from scope-list owner → allow"
  local tmpdir; tmpdir=$(mktemp -d)
  local repo="repoG2-$SUFFIX"
  local branch="main"
  local cwd_dir="$tmpdir/workdir"
  # Remote URL points at unrelated/<repo>; scope list has jeanibarz/<repo>.
  setup_git_repo "$cwd_dir" "git@github.com:unrelated/${repo}.git" "" "origin"

  write_scope_list "$tmpdir" '["jeanibarz/'"$repo"'"]'

  local cwd_repo_name
  cwd_repo_name=$(basename "$cwd_dir")
  local state="/dev/shm/.pr-gate-${cwd_repo_name}-${branch}-pre-done"
  track_state_file "$state"; rm -f "$state"

  local cmd="gh pr create --title t --body b"
  local payload; payload=$(mk_payload "$cmd" "$cwd_dir")
  local out; out=$(run_hook "$payload" "$tmpdir")

  if [ "$(classify "$out")" != "allow" ]; then
    record_fail "$name" "expected allow (owner mismatch), got deny → implementation is comparing bare repo names"
  else
    record_pass "$name"
  fi
  rm -rf "$tmpdir"
}
run_case_G2

printf '\nResults: %d passed, %d failed\n' "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  printf 'Failed cases:\n'
  for c in "${FAILED_CASES[@]}"; do printf '  - %s\n' "$c"; done
  exit 1
fi
