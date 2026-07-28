#!/usr/bin/env bash
# pr-create-guard-rehearsal.sh — mechanical rehearsal of the pre-`gh pr create`
# duplicate-guard shipped in the delivery playbooks and the kookr-pr-lifecycle
# skill (issue #1569).
#
# Replays the 2026-07-26 duplicate-PR race (task dd1fbcec, a downstream repo,
# #1672/#1673/#1674): PRs were opened 57s-3.5min AFTER their issues had already
# been auto-closed by the first merges, from the same still-existing branches at
# the same head SHAs. The guard must stop that mechanically.
#
# The guard body below is kept byte-for-byte identical to the copy in:
#   - .claude/skills/kookr-pr-lifecycle/SKILL.md
#   - plugin/playbooks/implement-github-issue.md
#   - plugin/playbooks/parallel-issue-batch.md
#
# `gh` is stubbed on PATH so the real jq filter (including now/fromdateiso8601)
# runs against synthetic issue/PR state; `gh pr create` writes a sentinel so the
# rehearsal can prove it was never reached on the abort path. The stub can also
# simulate a failing `gh` (auth / network / rate-limit) so the fail-closed
# behavior is exercised, not just asserted in prose.
#
# Modes:
#   pr-create-guard-rehearsal.sh          # self-checking: exits 0 iff guard is correct
#   pr-create-guard-rehearsal.sh abort    # replay 07-26 timeline; propagates the guard's non-zero exit
#   pr-create-guard-rehearsal.sh happy    # replay happy path; propagates the guard's exit (0)
#
# Portable: bash 3.2 / BSD-safe. Requires jq (matches the runtime dependency of
# the guard's `gh ... -q` jq filter).

set -u

# --- Pre-`gh pr create` duplicate-guard (issue #1569) ----------------------
# Fails CLOSED: if a gh probe errors (auth / network / rate-limit) the guard
# aborts rather than green-lighting an unverified PR — a rate-limited parallel
# batch is exactly when the duplicate race bites.
pr_create_guard() {
  local branch abort n state dupes
  branch="$1"; shift                 # head branch of the PR about to be created
  abort=0
  for n in "$@"; do                  # issue number(s) this PR would close
    if ! state=$(gh issue view "$n" --json state -q .state 2>/dev/null); then
      echo "PR-CREATE ABORTED: could not verify issue #$n (gh error / auth / rate-limit) — refusing to open a PR unverified." >&2
      abort=1; continue
    fi
    if [ "$state" = "CLOSED" ]; then
      echo "PR-CREATE ABORTED: issue #$n is CLOSED (likely auto-closed by an earlier merge) — refusing to open a duplicate PR." >&2
      abort=1
    fi
  done
  if ! dupes=$(gh pr list --head "$branch" --state all --json number,state,mergedAt \
    -q '.[] | select(.state=="OPEN" or (.mergedAt != null and (now - (.mergedAt|fromdateiso8601) < 86400))) | "#\(.number)/\(.state)"' 2>/dev/null); then
    echo "PR-CREATE ABORTED: could not verify PRs for '$branch' (gh error / auth / rate-limit) — refusing to open a PR unverified." >&2
    abort=1
  elif [ -n "$dupes" ]; then
    echo "PR-CREATE ABORTED: head branch '$branch' already has PR(s) $dupes (open or merged <24h ago) — refusing to open a duplicate PR." >&2
    abort=1
  fi
  [ "$abort" -eq 0 ] || return 1
  echo "pr-create guard OK: issue(s) [$*] open, no live/recent PR on '$branch'."
}

# --- Harness scaffolding ---------------------------------------------------
if ! command -v jq >/dev/null 2>&1; then
  echo "rehearsal: jq is required (the guard's gh -q filter uses it)." >&2
  exit 2
fi

WORK=$(mktemp -d "${TMPDIR:-/tmp}/kookr-guard-rehearsal.XXXXXX") || exit 2
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

SENTINEL="$WORK/pr-create-called"
: >"$SENTINEL"
export GUARD_REHEARSAL_CREATE_SENTINEL="$SENTINEL"

# Fake `gh`: emulates the two read commands the guard runs plus `pr create`.
# Honors the guard's `-q`/`--jq` flag by piping synthetic JSON through real jq,
# so the actual filter expression is under test, not a canned answer. Set
# GUARD_REHEARSAL_ISSUE_STATE=ERROR or GUARD_REHEARSAL_PR=error to make the
# corresponding probe exit non-zero (simulating auth / network / rate-limit).
cat >"$WORK/gh" <<'FAKE_GH'
#!/usr/bin/env bash
set -u
top="${1:-}"; shift || true
qexpr=""
prev=""
for a in "$@"; do
  case "$prev" in
    -q|--jq) qexpr="$a" ;;
  esac
  prev="$a"
done
emit() {
  if [ -n "$qexpr" ]; then
    printf '%s' "$1" | jq -r "$qexpr"
  else
    printf '%s\n' "$1"
  fi
}
case "$top" in
  issue)
    if [ "${GUARD_REHEARSAL_ISSUE_STATE:-OPEN}" = "ERROR" ]; then
      echo "gh: could not reach api.github.com (simulated)" >&2
      exit 3
    fi
    emit "{\"state\":\"${GUARD_REHEARSAL_ISSUE_STATE:-OPEN}\"}"
    ;;
  pr)
    sub="${1:-}"
    case "$sub" in
      list)
        case "${GUARD_REHEARSAL_PR:-none}" in
          error)
            echo "gh: HTTP 403 secondary rate limit (simulated)" >&2
            exit 4 ;;
          open)
            emit '[{"number":1672,"state":"OPEN","mergedAt":null}]' ;;
          merged_recent)
            ts=$(jq -rn '(now - 3600) | todateiso8601')
            emit "[{\"number\":1672,\"state\":\"MERGED\",\"mergedAt\":\"$ts\"}]" ;;
          merged_old)
            ts=$(jq -rn '(now - 172800) | todateiso8601')
            emit "[{\"number\":1672,\"state\":\"MERGED\",\"mergedAt\":\"$ts\"}]" ;;
          *)
            emit '[]' ;;
        esac
        ;;
      create)
        printf 'CALLED_GH_PR_CREATE\n' >>"${GUARD_REHEARSAL_CREATE_SENTINEL:-/dev/null}"
        printf 'https://example.com/pr/999\n' ;;
    esac
    ;;
esac
FAKE_GH
chmod +x "$WORK/gh"
PATH="$WORK:$PATH"
export PATH

pass=0
fail=0
report() {
  # $1 = ok|no, $2 = description
  if [ "$1" = "ok" ]; then
    pass=$((pass + 1)); printf 'PASS: %s\n' "$2"
  else
    fail=$((fail + 1)); printf 'FAIL: %s\n' "$2" >&2
  fi
}
contains() { case "$1" in *"$2"*) return 0 ;; *) return 1 ;; esac; }

# The real usage shape: guard MUST pass before gh pr create is invoked.
run_usage() {
  # args: branch issue...
  { pr_create_guard "$@" && gh pr create --base main --title t --body b; } 2>&1
}

run_abort() {
  export GUARD_REHEARSAL_ISSUE_STATE=CLOSED
  export GUARD_REHEARSAL_PR=merged_recent
  : >"$SENTINEL"
  pr_create_guard "surviving-branch" 1656
}

run_happy() {
  export GUARD_REHEARSAL_ISSUE_STATE=OPEN
  export GUARD_REHEARSAL_PR=none
  : >"$SENTINEL"
  pr_create_guard "fresh-branch" 1656
}

run_all() {
  local out rc

  # Scenario A — the 07-26 timeline: issue CLOSED + surviving branch with a
  # merged PR. Guard must abort (non-zero), print a report line, and gh pr
  # create must never be reached.
  export GUARD_REHEARSAL_ISSUE_STATE=CLOSED
  export GUARD_REHEARSAL_PR=merged_recent
  : >"$SENTINEL"
  out=$(run_usage "surviving-branch" 1656); rc=$?
  [ "$rc" -ne 0 ] && report ok "07-26 timeline: guard exits non-zero (rc=$rc)" \
    || report no "07-26 timeline: guard should exit non-zero but rc=$rc"
  contains "$out" "PR-CREATE ABORTED" \
    && report ok "07-26 timeline: prints an abort report line" \
    || report no "07-26 timeline: missing abort report line"
  contains "$out" "issue #1656 is CLOSED" \
    && report ok "07-26 timeline: report identifies the closed issue" \
    || report no "07-26 timeline: report does not identify the closed issue"
  [ ! -s "$SENTINEL" ] \
    && report ok "07-26 timeline: gh pr create was NOT called" \
    || report no "07-26 timeline: gh pr create WAS called"

  # Scenario B — happy path: issue OPEN, no existing PR for the branch. Guard
  # passes and gh pr create is reached.
  export GUARD_REHEARSAL_ISSUE_STATE=OPEN
  export GUARD_REHEARSAL_PR=none
  : >"$SENTINEL"
  out=$(run_usage "fresh-branch" 1656); rc=$?
  [ "$rc" -eq 0 ] \
    && report ok "happy path: guard passes (rc=0)" \
    || report no "happy path: guard should pass but rc=$rc"
  contains "$out" "pr-create guard OK" \
    && report ok "happy path: prints the OK line" \
    || report no "happy path: missing OK line"
  [ -s "$SENTINEL" ] \
    && report ok "happy path: gh pr create was reached" \
    || report no "happy path: gh pr create was NOT reached"

  # Scenario C — boundary: issue OPEN, branch reused, but its only PR merged
  # >24h ago. Guard must NOT block (the window is the last 24h only).
  export GUARD_REHEARSAL_ISSUE_STATE=OPEN
  export GUARD_REHEARSAL_PR=merged_old
  : >"$SENTINEL"
  out=$(run_usage "reused-branch" 1656); rc=$?
  [ "$rc" -eq 0 ] \
    && report ok "24h boundary: PR merged >24h ago does not block" \
    || report no "24h boundary: PR merged >24h ago should not block but rc=$rc"

  # Scenario D — an already-open PR on the branch blocks even when the issue is
  # still OPEN.
  export GUARD_REHEARSAL_ISSUE_STATE=OPEN
  export GUARD_REHEARSAL_PR=open
  : >"$SENTINEL"
  out=$(run_usage "branch-with-open-pr" 1656); rc=$?
  { [ "$rc" -ne 0 ] && [ ! -s "$SENTINEL" ]; } \
    && report ok "open PR on branch: guard aborts and skips create" \
    || report no "open PR on branch: guard should abort (rc=$rc)"

  # Scenario E — fail-closed: the issue probe errors (auth / rate-limit). Guard
  # must abort and NOT create, never green-light an unverified PR.
  export GUARD_REHEARSAL_ISSUE_STATE=ERROR
  export GUARD_REHEARSAL_PR=none
  : >"$SENTINEL"
  out=$(run_usage "some-branch" 1656); rc=$?
  { [ "$rc" -ne 0 ] && [ ! -s "$SENTINEL" ] && contains "$out" "could not verify issue"; } \
    && report ok "fail-closed: gh issue error aborts and skips create" \
    || report no "fail-closed: gh issue error should abort (rc=$rc)"

  # Scenario F — fail-closed: the PR-list probe errors. Guard must abort.
  export GUARD_REHEARSAL_ISSUE_STATE=OPEN
  export GUARD_REHEARSAL_PR=error
  : >"$SENTINEL"
  out=$(run_usage "some-branch" 1656); rc=$?
  { [ "$rc" -ne 0 ] && [ ! -s "$SENTINEL" ] && contains "$out" "could not verify PRs"; } \
    && report ok "fail-closed: gh pr list error aborts and skips create" \
    || report no "fail-closed: gh pr list error should abort (rc=$rc)"

  printf '\n%s passed, %s failed\n' "$pass" "$fail"
  [ "$fail" -eq 0 ]
}

case "${1:-all}" in
  abort) run_abort; exit $? ;;
  happy) run_happy; exit $? ;;
  all|*) run_all; exit $? ;;
esac
