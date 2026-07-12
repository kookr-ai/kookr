#!/usr/bin/env bash
# Regression tests for hooks/oss-stale-scout-gate.sh
#
# Uses a shim `gh` at $REPO/.claude/hooks-tests/shims/gh that returns
# canned responses per case via $GH_SHIM_FIXTURE_DIR. No real network.
#
# Run: bash .claude/hooks-tests/oss-stale-scout-gate.test.sh
# Or:  pnpm test:hooks

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
HOOK="$REPO_ROOT/hooks/oss-stale-scout-gate.sh"
SHIM_DIR="$SCRIPT_DIR/shims"
FIXTURE_ROOT="$SCRIPT_DIR/fixtures"

PASS=0
FAIL=0
FAILED_CASES=()

run_case() {
  local name="$1"
  local fixture="$2"
  local payload="$3"
  local expect="$4"   # "allow" or "deny"
  local assert_regex="${5:-}"
  local setup="${6:-}"
  local cwd_override="${7:-}"

  local tmpdir
  tmpdir=$(mktemp -d)
  export KOOKR_HOOKS_DIR="$tmpdir"
  export GH_SHIM_FIXTURE_DIR="$FIXTURE_ROOT/$fixture"
  export PATH="$SHIM_DIR:$PATH"
  # Avoid pulling the real KOOKR_TASK_ID into fixture ledgers.
  unset KOOKR_TASK_ID 2>/dev/null || true

  if [ -n "$cwd_override" ]; then
    # Rewrite the payload's cwd so the branch check fires against a real git repo
    payload=$(printf '%s' "$payload" | jq --arg cwd "$cwd_override" '.cwd = $cwd')
  fi

  [ -n "$setup" ] && eval "$setup"

  local out
  out=$(printf '%s' "$payload" | bash "$HOOK" 2>&1) || true

  local got="allow"
  if printf '%s' "$out" | grep -q '"permissionDecision": "deny"'; then
    got="deny"
  fi

  local status="PASS"
  if [ "$got" != "$expect" ]; then
    status="FAIL"
  elif [ -n "$assert_regex" ]; then
    if ! printf '%s' "$out" | grep -qE "$assert_regex"; then
      status="FAIL"
    fi
  fi

  if [ "$status" = "PASS" ]; then
    PASS=$((PASS + 1))
    printf '  [OK]   %s\n' "$name"
  else
    FAIL=$((FAIL + 1))
    FAILED_CASES+=("$name")
    printf '  [FAIL] %s\n' "$name"
    printf '         expected=%s got=%s\n' "$expect" "$got"
    printf '         output: %s\n' "$(printf '%s' "$out" | head -c 400)"
    if [ -s "$tmpdir/hook-errors.log" ]; then
      printf '         errors: %s\n' "$(head -c 200 "$tmpdir/hook-errors.log")"
    fi
  fi

  rm -rf "$tmpdir"
  # Clean up any bypass files the case may have set up
  rm -f /dev/shm/.stale-scout-testowner-testrepo-*-bypass 2>/dev/null || true
}

# Convenience: build a tool_input.command with a heredoc body.
# The command string includes literal newlines inside the heredoc body so
# the hook's awk extractor sees real lines. We use ANSI-C quoting and
# printf format to avoid command-substitution newline stripping.
mk_payload() {
  local repo="$1"
  local body_line="$2"
  local extra="${3:-}"
  local cmd
  # shellcheck disable=SC2059
  printf -v cmd 'gh pr create %s --repo %s --title "t" --body "$(cat <<'"'"'EOF'"'"'\n%s\nEOF\n)"' \
    "$extra" "$repo" "$body_line"
  jq -n --arg cmd "$cmd" '{
    tool_name: "Bash",
    cwd: "/tmp",
    tool_input: { command: $cmd }
  }'
}

# ---------------------------------------------------------------------
# Fixture setup helpers
# ---------------------------------------------------------------------
mk_fixture() {
  local name="$1"
  local dir="$FIXTURE_ROOT/$name"
  mkdir -p "$dir"
  echo "$dir"
}

# Open issue fixture
F=$(mk_fixture open-issue)
printf '{"state":"open"}' > "$F/issue.json"

# Closed-by-other-PR fixture
F=$(mk_fixture closed-by-other)
printf '{"state":"closed","state_reason":"completed"}' > "$F/issue.json"
printf '%s' '{"data":{"repository":{"issue":{"closedByPullRequestsReferences":{"nodes":[
  {"number":9001,"state":"MERGED","title":"canonical fix","mergedAt":"2026-04-09T04:34:04Z","url":"https://github.com/testowner/testrepo/pull/9001"}
]}}}}}' > "$F/graphql.json"

# Closed manually (no closer)
F=$(mk_fixture closed-manually)
printf '{"state":"closed","state_reason":"completed"}' > "$F/issue.json"
printf '%s' '{"data":{"repository":{"issue":{"closedByPullRequestsReferences":{"nodes":[]}}}}}' > "$F/graphql.json"

# Closed as not_planned
F=$(mk_fixture closed-not-planned)
printf '{"state":"closed","state_reason":"not_planned"}' > "$F/issue.json"
printf '%s' '{"data":{"repository":{"issue":{"closedByPullRequestsReferences":{"nodes":[]}}}}}' > "$F/graphql.json"

# Reopened (state=open, old merged PR in graphql)
F=$(mk_fixture reopened)
printf '{"state":"open"}' > "$F/issue.json"
printf '%s' '{"data":{"repository":{"issue":{"closedByPullRequestsReferences":{"nodes":[
  {"number":7777,"state":"MERGED","title":"old","mergedAt":"2024-01-01T00:00:00Z","url":"https://github.com/testowner/testrepo/pull/7777"}
]}}}}}' > "$F/graphql.json"

# Out-of-order GraphQL (two merged PRs, oldest returned first — newest wins after sort)
F=$(mk_fixture out-of-order)
printf '{"state":"closed","state_reason":"completed"}' > "$F/issue.json"
printf '%s' '{"data":{"repository":{"issue":{"closedByPullRequestsReferences":{"nodes":[
  {"number":1000,"state":"MERGED","title":"old","mergedAt":"2025-01-01T00:00:00Z","url":"https://github.com/testowner/testrepo/pull/1000"},
  {"number":2000,"state":"MERGED","title":"new","mergedAt":"2026-03-01T00:00:00Z","url":"https://github.com/testowner/testrepo/pull/2000"},
  {"number":1500,"state":"MERGED","title":"mid","mergedAt":"2025-06-01T00:00:00Z","url":"https://github.com/testowner/testrepo/pull/1500"}
]}}}}}' > "$F/graphql.json"

# Confirmed-closed + GraphQL failure (regression test for round-1 bug)
F=$(mk_fixture closed-graphql-fails)
printf '{"state":"closed","state_reason":"completed"}' > "$F/issue.json"
touch "$F/fail_graphql"

# Auth fail
F=$(mk_fixture auth-fail)
printf '{"state":"closed","state_reason":"completed"}' > "$F/issue.json"
touch "$F/fail_auth"

# Existing PR on branch (gh pr list returns one)
F=$(mk_fixture existing-pr)
printf '{"state":"closed","state_reason":"completed"}' > "$F/issue.json"
printf '[{"number":1234}]' > "$F/pr_list.json"

# Second-issue-closed fixture (first open, second closed)
F=$(mk_fixture second-closed)
printf '{"state":"open"}' > "$F/issue_testowner_testrepo_1.json"
printf '{"state":"closed","state_reason":"completed"}' > "$F/issue_testowner_testrepo_2.json"
printf '%s' '{"data":{"repository":{"issue":{"closedByPullRequestsReferences":{"nodes":[
  {"number":555,"state":"MERGED","title":"fix 2","mergedAt":"2026-04-10T00:00:00Z","url":"https://github.com/testowner/testrepo/pull/555"}
]}}}}}' > "$F/graphql.json"

# First-closed-second-open (order independence)
F=$(mk_fixture first-closed)
printf '{"state":"closed","state_reason":"completed"}' > "$F/issue_testowner_testrepo_1.json"
printf '{"state":"open"}' > "$F/issue_testowner_testrepo_2.json"
printf '%s' '{"data":{"repository":{"issue":{"closedByPullRequestsReferences":{"nodes":[
  {"number":777,"state":"MERGED","title":"fix 1","mergedAt":"2026-04-10T00:00:00Z","url":"https://github.com/testowner/testrepo/pull/777"}
]}}}}}' > "$F/graphql.json"

# Cross-repo reference
F=$(mk_fixture cross-repo)
printf '{"state":"closed","state_reason":"completed"}' > "$F/issue_otherowner_otherrepo_42.json"
printf '{"state":"open"}' > "$F/issue.json"  # default for target repo (unused, but defensive)
printf '%s' '{"data":{"repository":{"issue":{"closedByPullRequestsReferences":{"nodes":[
  {"number":999,"state":"MERGED","title":"other","mergedAt":"2026-04-11T00:00:00Z","url":"https://github.com/otherowner/otherrepo/pull/999"}
]}}}}}' > "$F/graphql.json"

# ---------------------------------------------------------------------
# Cases
# ---------------------------------------------------------------------
printf '\nRunning oss-stale-scout-gate regression tests\n\n'

# 1. Open issue → allow
run_case "1: open issue → allow" open-issue \
  "$(mk_payload testowner/testrepo 'Fixes #1')" \
  allow

# 2. Closed by other PR → block; message contains PR number + URL
run_case "2: closed by other PR → block" closed-by-other \
  "$(mk_payload testowner/testrepo 'Fixes #1')" \
  deny '#9001'

# 3. Closed manually (no closer) → block with "Closing PR could not be identified"
run_case "3: closed manually → block (no closer)" closed-manually \
  "$(mk_payload testowner/testrepo 'Closes #1')" \
  deny 'Closing PR could not be identified'

# 4. Closed as not_planned → block
run_case "4: closed not_planned → block" closed-not-planned \
  "$(mk_payload testowner/testrepo 'Resolves #1')" \
  deny 'not_planned'

# 5. Reopened issue → allow
run_case "5: reopened issue → allow" reopened \
  "$(mk_payload testowner/testrepo 'Fixes #1')" \
  allow

# 6. Multi-issue: first open, second closed → block on second
run_case "6: multi-issue, second closed → block" second-closed \
  "$(mk_payload testowner/testrepo $'Fixes #1\nCloses #2')" \
  deny '#555'

# 7. Multi-issue: first closed, second open → block on first (order-independence)
run_case "7: multi-issue, first closed → block" first-closed \
  "$(mk_payload testowner/testrepo $'Fixes #1\nCloses #2')" \
  deny '#777'

# 8. Cross-repo `otherowner/otherrepo#42` against a different target
run_case "8: cross-repo ref → queries other repo" cross-repo \
  "$(mk_payload testowner/testrepo 'Fixes otherowner/otherrepo#42')" \
  deny 'otherowner/otherrepo#42'

# 9. Full URL reference
run_case "9: URL ref → captured" cross-repo \
  "$(mk_payload testowner/testrepo 'Related to https://github.com/otherowner/otherrepo/issues/42')" \
  deny '#999'

# 10. Keyword coverage: `fix: #1`, `closed #1`, `resolved #1` — any one triggers
run_case "10a: 'fix: #1' keyword" closed-by-other \
  "$(mk_payload testowner/testrepo 'fix: #1')" \
  deny
run_case "10b: 'closed #1' keyword" closed-by-other \
  "$(mk_payload testowner/testrepo 'closed #1')" \
  deny
run_case "10c: 'resolved #1' keyword" closed-by-other \
  "$(mk_payload testowner/testrepo 'resolved #1')" \
  deny

# 11. Fenced code block with closes → stripped, no block
run_case "11: fenced code block stripped" open-issue \
  "$(mk_payload testowner/testrepo $'\`\`\`\nPrevious: closes #1\n\`\`\`\nNothing else.')" \
  allow

# 12. Quoted line with closes → stripped
run_case "12: quoted line stripped" open-issue \
  "$(mk_payload testowner/testrepo $'> old commit: closes #1\n\nNothing here.')" \
  allow

# 13. No linked issue → allow, no ledger entry
run_case "13: no linked issue → silent allow" open-issue \
  "$(mk_payload testowner/testrepo 'Nothing to see here.')" \
  allow

# 14. Draft PR (via --draft flag) against closed issue → allow
run_case "14: draft PR → allow" closed-by-other \
  "$(mk_payload testowner/testrepo 'Fixes #1' '--draft')" \
  allow

# 15. Confirmed-closed + GraphQL failure → still block with closing-PR-unknown
run_case "15: confirmed-closed + graphql fail → block" closed-graphql-fails \
  "$(mk_payload testowner/testrepo 'Fixes #1')" \
  deny 'Closing PR could not be identified'

# 16. Out-of-order GraphQL → client-side sort picks newest (#2000)
run_case "16: graphql out-of-order → newest merged wins" out-of-order \
  "$(mk_payload testowner/testrepo 'Fixes #1')" \
  deny '#2000'

# 17. Bypass file present → allow; file consumed
run_case "17: bypass file consumed" closed-by-other \
  "$(mk_payload testowner/testrepo 'Fixes #1')" \
  allow \
  '' \
  'touch /dev/shm/.stale-scout-testowner-testrepo-1-bypass'

# 18. gh auth status fails → fail open (allow), logged
run_case "18: gh auth fail → fail open" auth-fail \
  "$(mk_payload testowner/testrepo 'Fixes #1')" \
  allow

# 19. Existing PR on branch → fail open (defer to gh native error).
# Needs cwd to be a real git repo with a *branch-checkout* HEAD (so the
# hook's `git symbolic-ref HEAD` returns a name and the shim's
# pr_list.json gets read). The kookr repo's own root works locally but
# fails in PR CI because actions/checkout@v4 creates a detached HEAD.
# Build a throwaway git repo in a temp dir with a real branch checkout.
TEST19_REPO=$(mktemp -d)
(
  cd "$TEST19_REPO"
  git init -q -b stale-scout-test
  # Need at least one commit so HEAD is a real ref (`git symbolic-ref` still
  # works on an unborn branch but defensive: a real commit makes the repo
  # behave identically to a normal checkout).
  git -c user.email=test@example.com -c user.name=Test commit -q --allow-empty -m init
)
run_case "19: existing PR on branch → fail open" existing-pr \
  "$(mk_payload testowner/testrepo 'Fixes #1')" \
  allow "" "" "$TEST19_REPO"
rm -rf "$TEST19_REPO"

# 20-22. A Codex-managed hook may receive the launcher checkout as cwd while
# the command targets a sibling linked worktree. Relative --body-file must
# resolve from the --head branch's worktree, not from the hook process cwd.
run_worktree_body_file_case() {
  local name="$1"
  local head="$2"
  local head_arg="$3"
  local expected_error="$4"
  local tmpdir
  tmpdir=$(mktemp -d)
  local parent="$tmpdir/parent"
  local child="$tmpdir/child"
  mkdir -p "$parent/data"
  git -C "$parent" init -q -b main
  git -C "$parent" config user.email test@example.com
  git -C "$parent" config user.name Test
  git -C "$parent" remote add origin https://github.com/testowner/testrepo.git
  printf 'Fixes #1\n' > "$parent/data/pr-body.md"
  git -C "$parent" add data/pr-body.md
  git -C "$parent" commit -q -m init
  if [ "$head" = "feature" ]; then
    git -C "$parent" worktree add -q -b feature "$child"
    printf 'No linked issue here.\n' > "$child/data/pr-body.md"
  fi

  local cmd
  printf -v cmd 'gh pr create --head %s --body-file data/pr-body.md' "$head_arg"
  local payload
  payload=$(jq -n --arg cwd "$parent" --arg cmd "$cmd" '{
    tool_name: "Bash",
    cwd: $cwd,
    tool_input: { command: $cmd }
  }')

  export KOOKR_HOOKS_DIR="$tmpdir/state"
  export GH_SHIM_FIXTURE_DIR="$FIXTURE_ROOT/closed-by-other"
  export GH_BIN="$SHIM_DIR/gh"
  unset KOOKR_TASK_ID 2>/dev/null || true

  local out
  out=$(printf '%s' "$payload" | (cd "$parent" && bash "$HOOK") 2>&1) || true
  local got="allow"
  if printf '%s' "$out" | grep -q '"permissionDecision": "deny"'; then
    got="deny"
  fi
  local errors=""
  if [ -s "$tmpdir/state/hook-errors.log" ]; then
    errors=$(cat "$tmpdir/state/hook-errors.log")
  fi

  local passed=0
  if [ "$got" = "allow" ]; then
    if [ -n "$expected_error" ]; then
      printf '%s' "$errors" | grep -q "$expected_error" && passed=1
    elif [ -z "$errors" ]; then
      passed=1
    fi
  fi
  if [ "$passed" = "1" ]; then
    PASS=$((PASS + 1))
    printf '  [OK]   %s\n' "$name"
  else
    FAIL=$((FAIL + 1))
    FAILED_CASES+=("$name")
    printf '  [FAIL] %s\n' "$name"
    if [ -n "$expected_error" ]; then
      printf '         expected=allow with error=%s got=%s\n' "$expected_error" "$got"
    else
      printf '         expected=allow with no errors got=%s\n' "$got"
    fi
    printf '         output: %s\n' "$(printf '%s' "$out" | head -c 400)"
    [ -n "$errors" ] && printf '         errors: %s\n' "$(printf '%s' "$errors" | head -c 400)"
  fi

  rm -rf "$tmpdir"
}

run_worktree_body_file_case \
  "20: relative body-file follows linked --head worktree" \
  feature \
  feature \
  ""
run_worktree_body_file_case \
  "21: command-substitution --head follows linked worktree" \
  feature \
  '"$(gh api user --jq .login):feature"' \
  ""
run_worktree_body_file_case \
  "22: unresolved --head fails open without reading launcher body" \
  missing \
  missing \
  "body-file cwd resolution failed"

printf '\nResults: %d passed, %d failed\n' "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  printf 'Failed cases:\n'
  for c in "${FAILED_CASES[@]}"; do printf '  - %s\n' "$c"; done
  exit 1
fi
