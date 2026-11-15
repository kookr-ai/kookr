#!/usr/bin/env bash
# kookr-merge — wait for a PR's checks then squash-merge, deleting the branch by default.
#
# Drop-in substitute for `gh pr merge <PR> --auto --squash --delete-branch` on
# repos where GitHub auto-merge is unavailable (private repos on the Free plan
# without branch protection — see issue #29).
#
# Before merging, an independent-review gate (issue #1717) refuses to merge
# unless the PR carries a fresh-context reviewer verdict of `pass` explicitly
# bound to the exact current head. The `review-skipped-timeout` label is
# telemetry only and never authorizes a merge. This makes zero-review
# autonomous merges unreachable. The gate literals below are kept in
# sync with src/core/independent-review.ts by a contract test. Set
# KOOKR_MERGE_REQUIRE_REVIEW=0 to disable the gate (manual merges, OSS repos).
#
# Paired delivery (a change reviewed in two repositories) can still need both
# source branches after the first merge, for audit, replay, or the second
# repository's merge. Pass --preserve-branch to skip source-branch deletion.
# Preservation does not skip review, exact-head pinning, required checks,
# mergeability, or the post-merge confirmation (CLI: state=MERGED or a
# non-null mergedAt; REST: .merged == true). The caller remains responsible
# for deleting the preserved branch later.
#
# When GitHub Actions never executed the checks — an external billing/quota/
# spending-limit block that "completes" every job as failure in seconds without
# running the code, not a code failure — the merge may still proceed, but ONLY
# when the operator recorded the local verification gate on the PR: the
# `local-verified` label AND a comment carrying the local-gate marker with a
# `local-gate-head-sha:` line equal to the current head. That head binding makes
# the waiver specific to the reviewed code, exactly like the independent-review
# gate above; a check that RAN and failed is never waived (issue #3396). The
# never-executed vs executed-red distinction is made by the same reusable
# classifier the delivery playbooks call (scripts/check-verification.mjs).
#
# The source branch is deleted through the REST API after GitHub confirms the
# merge, never with `gh pr merge --delete-branch` (issue #3641). That flag also
# switches the local checkout to the base branch and deletes the local branch;
# from a linked worktree whose base branch is checked out elsewhere that local
# step fails AFTER the remote merge, so the wrapper used to exit 1 on a merged
# PR. Nothing after the confirmed merge can change the exit code: a failed
# branch delete or closing-issue lookup is a warning, not a failure.
#
# After the merge, any issue the PR declares as closing (closingIssuesReferences)
# that is still open is reported, so a missed auto-close is seen, not assumed.
#
# Integration branch (issue #3788): when the current checkout's repository
# configures one (.kookr/delivery-gate.json, read by scripts/lib/delivery-gate.sh)
# a PR aimed at the default branch is retargeted to it before anything else, and
# a PR merged there reports its closing issues as staying open until the
# integration train promotes the change. Inert without the config.
#
# A verdict may also carry `review-patch-id:` (scripts/review-patch-id.sh), the
# id of the exact file versions the PR changes. The gate then accepts a pass whose
# head SHA moved as long as the PR's current id still equals it. A rebase keeps the
# id only when the new base did not touch the files the PR changes; otherwise the
# reviewer must re-review.
#
# Also reachable from any repository as `kookr merge <PR> [--repo OWNER/NAME]`.
#
# Usage: kookr-merge <pr-number> [--repo OWNER/NAME] [--preserve-branch | --delete-branch]
set -euo pipefail

# Absolute directory of this script, so the reusable check classifier resolves
# whether kookr-merge is invoked by path, via `pnpm merge`, or from another CWD.
KOOKR_MERGE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/repo-slug.sh
source "$KOOKR_MERGE_DIR/lib/repo-slug.sh"

# --- independent-review gate literals (keep in sync with src/core/independent-review.ts) ---
KOOKR_REVIEW_MARKER='<!-- kookr-independent-review -->'
KOOKR_REVIEW_TIMEOUT_LABEL='review-skipped-timeout'
KOOKR_REVIEW_HEAD_SHA_PREFIX='review-head-sha:'
KOOKR_REVIEW_PATCH_ID_PREFIX='review-patch-id:'

# Integration-branch configuration reader (issue #3788); absent => behave as before.
if [[ -f "$KOOKR_MERGE_DIR/lib/delivery-gate.sh" ]]; then
  # shellcheck source=lib/delivery-gate.sh
  source "$KOOKR_MERGE_DIR/lib/delivery-gate.sh"
fi

# --- local-gate literals (never-executed CI waiver, issue #3396) ---
# A never-executed (billing/quota) block is waived only by the local-verified
# label plus a comment with this marker AND a `local-gate-head-sha:` line equal
# to the current head. Keep the marker and head-sha line format in sync with the
# operator-facing contract in plugin/playbooks/parallel-issue-batch.md and
# plugin/playbooks/implement-github-issue.md. Override the classifier for tests.
KOOKR_LOCAL_GATE_MARKER='<!-- kookr-local-gate -->'
KOOKR_LOCAL_VERIFIED_LABEL='local-verified'
KOOKR_MERGE_CLASSIFIER="${KOOKR_MERGE_CLASSIFIER:-$KOOKR_MERGE_DIR/check-verification.mjs}"

PR=""
REPO_ARG=()
REPO_SLUG=""
BRANCH_MODE=""

print_usage() {
  cat <<'EOF'
Usage: kookr-merge <pr-number> [--repo OWNER/NAME] [--preserve-branch | --delete-branch]

Watches the PR's checks via `gh pr checks --watch` and squash-merges once they
pass. By default the source branch is deleted through the GitHub API after the
merge is confirmed (never with `gh pr merge --delete-branch`, whose local
cleanup fails in a linked worktree). Afterwards, any issue the PR declares as
closing that is still open is reported. When the repository configures an
integration branch, a PR aimed at the default branch is retargeted to it first.
Aborts before merging if the PR is closed, a draft, has changes requested, or
any check fails.

Use --preserve-branch for paired delivery: a change reviewed in two
repositories, where both source branches are still needed for audit, replay,
or the coordinated merge in the second repository. Preservation skips only
wrapper-owned branch deletion. The caller must delete the preserved branch
once that later work is done.

A drop-in substitute for:
  gh pr merge <pr-number> --auto --squash --delete-branch

Options:
  --repo OWNER/NAME   Target repo (defaults to the current git remote).
  --preserve-branch   Keep the source branch after merge; caller cleans up later.
  --delete-branch     Delete the source branch after merge (the default).
  -h, --help          Show this help.

Exit codes:
  0  merged successfully (a failed branch delete or a still-open closing issue
     is reported on stderr but does not change the exit code)
  1  pre-flight failed (state/draft/review) or merge command failed
  2  bad usage
  3  one or more checks RAN and failed, or never-executed checks lacked the
     recorded local gate (local-verified label + a local-gate-head-sha comment
     bound to the current head)
  4  blocked by the independent-review gate (no pass verdict / confirmed finding)
EOF
}

# checkout_matches_repo — true when the PR belongs to the repository of the
# current checkout. Without --repo, gh resolves the PR from this checkout, so it
# does. With --repo, compare it with origin's slug; unknown means no.
checkout_matches_repo() {
  [[ -n "$REPO_SLUG" ]] || return 0
  local want have
  want="$(repo_slug_of_url "$REPO_SLUG")"
  have="$(repo_slug_of_url "$(git config --get remote.origin.url 2>/dev/null || true)")"
  [[ -n "$want" && -n "$have" && "$want" == "$have" ]]
}

# MERGE_INTO_INTEGRATION — set to the default branch name when this PR's base is
# the configured integration branch (after any retarget), else empty.
MERGE_INTO_INTEGRATION=""

# retarget_to_integration_branch — when the current checkout's repository
# configures an integration branch and the PR is aimed at the default branch,
# retarget it (gh pr edit --base) before the review gate and the mergeability
# wait. Stacked PRs (any other base) and the integration branch's own promotion
# PR (head == integration) are left alone. Never merge into the default branch
# when an integration branch is configured: a failed edit is fatal.
retarget_to_integration_branch() {
  declare -F delivery_gate_integration_branch >/dev/null || return 0
  local integration=""
  integration="$(delivery_gate_integration_branch 2>/dev/null || true)"
  [[ -n "$integration" ]] || return 0
  checkout_matches_repo || return 0

  local pr_json base head default
  if ! pr_json="$(gh pr view "$PR" ${REPO_ARG[@]+"${REPO_ARG[@]}"} --json baseRefName,headRefName)"; then
    echo "kookr-merge: an integration branch ($integration) is configured but PR #$PR could not be read; refusing to merge" >&2
    exit 1
  fi
  base="$(printf '%s' "$pr_json" | jq -r '.baseRefName // ""')"
  head="$(printf '%s' "$pr_json" | jq -r '.headRefName // ""')"
  if ! default="$(gh repo view ${REPO_SLUG:+"$REPO_SLUG"} --json defaultBranchRef --jq .defaultBranchRef.name)" || [[ -z "$default" ]]; then
    echo "kookr-merge: an integration branch ($integration) is configured but the default branch could not be read; refusing to merge" >&2
    exit 1
  fi

  if [[ "$base" == "$integration" ]]; then
    MERGE_INTO_INTEGRATION="$default"
    return 0
  fi
  [[ "$base" == "$default" && "$head" != "$integration" ]] || return 0

  if ! gh pr edit "$PR" ${REPO_ARG[@]+"${REPO_ARG[@]}"} --base "$integration"; then
    echo "kookr-merge: could not retarget PR #$PR from $default to $integration; refusing to merge into $default while an integration branch is configured" >&2
    exit 1
  fi
  echo "kookr-merge: retargeted PR #$PR from $default to $integration (integration branch configured in .kookr/delivery-gate.json)"
  MERGE_INTO_INTEGRATION="$default"
}

# require_review_verdict — enforce the independent merge-review gate (#1717).
# Allows the merge only when the latest reviewer verdict comment is `pass` for
# the current head SHA. Timeout labels are telemetry only. Returns 0 to allow,
# 4 to block. Set KOOKR_MERGE_REQUIRE_REVIEW=0 to skip entirely for a human merge.
require_review_verdict() {
  local require="${KOOKR_MERGE_REQUIRE_REVIEW:-1}"
  if [[ "$require" == "0" || "$require" == "false" ]]; then
    echo "kookr-merge: independent-review gate disabled (KOOKR_MERGE_REQUIRE_REVIEW=$require)"
    return 0
  fi

  local view head_sha decision current_pid=""
  # Prefer fields available across gh versions. `headRefOid` is missing on gh < ~2.14
  # (issue #1853); `commits` has been a valid `gh pr view --json` field much longer.
  # An empty head SHA is a hard block: exact-head binding is part of the safety
  # contract, not an optional enhancement.
  if ! view="$(gh pr view "$PR" ${REPO_ARG[@]+"${REPO_ARG[@]}"} --json comments,labels,commits)"; then
    echo "kookr-merge: could not read PR comments/labels for the review gate" >&2
    return 4
  fi
  head_sha="$(printf '%s' "$view" | jq -r '((.commits // []) | last | .oid // "") | ascii_downcase')"
  # Export the reviewed head so the final merge can pin to it (--match-head-commit),
  # closing the TOCTOU window where the head advances during the check-watch wait
  # and an unreviewed commit would otherwise merge. Older gh lacks that flag; the
  # merge step feature-probes and degrades gracefully (issue #1853). When a
  # patch-id match authorizes a moved head, the pin is this CURRENT head.
  REVIEW_HEAD_SHA="$head_sha"

  # shellcheck disable=SC2016  # jq program, not shell
  local program='
    def strip: gsub("^\\s+|\\s+$"; "");
    def field($lines; $prefix):
      ( [ $lines[] | select(ascii_downcase | startswith($prefix)) ] | last // "" )
      | ascii_downcase | ltrimstr($prefix) | strip;
    def verdicts:
      [ .comments[]
        | select(.body | contains($marker))
        | .createdAt as $ts
        | (.body | split("\n") | map(strip)) as $lines
        | ( [ $lines[] | select(ascii_downcase | startswith("kookr-review-verdict:")) ] | last // "" ) as $vline
        | ( $vline | ascii_downcase | ltrimstr("kookr-review-verdict:") | strip ) as $verdict
        | select($verdict == "pass" or $verdict == "block")
        | { ts: ($ts // ""), verdict: $verdict,
            sha: field($lines; $shaPrefix), pid: field($lines; $pidPrefix) } ];
    ([ .labels[]?.name | ascii_downcase ] | index($tlabel)) as $hasLabel
    | verdicts as $vs
    | ( $vs | sort_by(.ts) | last ) as $v
    # A BLOCK is sticky for the exact head (or diff) it reviewed: once this current
    # head or patch id is blocked, a later PASS on it is a re-poll flip on
    # identical content and cannot clear it. A fix pushes a new commit with a new
    # diff, so its PASS is not caught here. Mirrors evaluateMergeReviewGate.
    # A BLOCK on the head the latest PASS reviewed is sticky too. That matters
    # when the PASS is accepted through its patch id after a clean rebase: a
    # BLOCK posted without a patch-id line (every verdict written before
    # reviewers emitted one) names only the old head, and the rebase must not
    # launder the re-poll flip that followed it.
    | ( [ $vs[] | select(.verdict == "block"
          and ((.sha != "" and .sha == $head)
               or (.pid != "" and $cpid != "" and .pid == $cpid)
               or (.sha != "" and $v != null and $v.sha != "" and .sha == $v.sha))) ]
        | length > 0 ) as $blockedThis
    | ( $v != null and $v.sha != "" and $head != "" and $v.sha == $head ) as $shaMatch
    | ( $v != null and $v.pid != "" and $cpid != "" and $v.pid == $cpid ) as $pidMatch
    | if $mode == "need-pid" then
        # Is the PR diff patch id worth computing? Only for a latest PASS that is
        # not already head-bound, or when any BLOCK carries a patch id.
        ( $v != null and $v.verdict == "pass" and $head != ""
          and ( ($shaMatch | not) and $v.pid != ""
                or ([ $vs[] | select(.verdict == "block" and .pid != "") ] | length > 0) ) )
        | tostring
      elif $v == null then
        (if $hasLabel then "block:timeout-label" else "block:no-verdict" end)
      elif $v.verdict == "block" then
        "block:blocked-finding"
      elif ($head == "" or ($v.sha == "" and $v.pid == "")) then
        "block:unbound-verdict"
      elif ($shaMatch | not) and ($pidMatch | not) then
        "block:stale-verdict"
      elif $blockedThis then
        "block:sticky-block"
      elif $shaMatch then
        "allow:pass"
      else
        "allow:pass-patch-id"
      end
  '
  run_gate_program() {
    printf '%s' "$view" | jq -r \
      --arg marker "$KOOKR_REVIEW_MARKER" \
      --arg tlabel "$KOOKR_REVIEW_TIMEOUT_LABEL" \
      --arg shaPrefix "$KOOKR_REVIEW_HEAD_SHA_PREFIX" \
      --arg pidPrefix "$KOOKR_REVIEW_PATCH_ID_PREFIX" \
      --arg head "$head_sha" \
      --arg cpid "$current_pid" \
      --arg mode "$1" "$program"
  }

  # Compute the PR's current patch id lazily: only when the head SHA alone does
  # not decide. An uncomputable id falls back to the SHA rule and never matches.
  if [[ "$(run_gate_program need-pid)" == "true" ]]; then
    if [[ -n "$REPO_SLUG" ]] && ! checkout_matches_repo; then
      echo "kookr-merge: this checkout is not $REPO_SLUG; cannot compute the PR patch id, using the head-SHA rule alone" >&2
    elif [[ -x "$KOOKR_MERGE_DIR/review-patch-id.sh" ]] \
        && current_pid="$("$KOOKR_MERGE_DIR/review-patch-id.sh" --pr "$PR" --expect-head "$head_sha" ${REPO_ARG[@]+"${REPO_ARG[@]}"} | tr '[:upper:]' '[:lower:]')" \
        && [[ -n "$current_pid" ]]; then
      :
    else
      current_pid=""
      echo "kookr-merge: could not compute the PR patch id; using the head-SHA rule alone" >&2
    fi
  fi
  decision="$(run_gate_program decide)"

  case "$decision" in
    allow:pass-patch-id)
      echo "kookr-merge: review verdict matches the PR diff (patch id); head moved without changing the diff"
      return 0
      ;;
    allow:*)
      echo "kookr-merge: independent-review gate: ${decision#allow:}"
      return 0
      ;;
    *)
      echo "kookr-merge: BLOCKED by the independent-review gate: ${decision#block:}" >&2
      echo "kookr-merge: the latest reviewer verdict must be 'pass' with review-head-sha equal to the current head ($head_sha), or with review-patch-id equal to the id of the exact file versions the PR currently changes (it survives a rebase only when the base did not touch those files)." >&2
      echo "kookr-merge: '$KOOKR_REVIEW_TIMEOUT_LABEL' is telemetry only and cannot bypass review." >&2
      echo "kookr-merge: run the independent-merge-review skill, or set KOOKR_MERGE_REQUIRE_REVIEW=0 for a manual merge." >&2
      return 4
      ;;
  esac
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      [[ $# -ge 2 ]] || { echo "kookr-merge: --repo requires a value" >&2; exit 2; }
      if [[ -z "$2" || "$2" == -* ]]; then
        echo "kookr-merge: --repo requires a value, got '$2'" >&2
        exit 2
      fi
      REPO_ARG=(--repo "$2")
      REPO_SLUG="$2"
      shift 2
      ;;
    --repo=*)
      [[ -n "${1#--repo=}" ]] || { echo "kookr-merge: --repo requires a value" >&2; exit 2; }
      REPO_ARG=(--repo "${1#--repo=}")
      REPO_SLUG="${1#--repo=}"
      shift
      ;;
    --preserve-branch|--delete-branch)
      if [[ -n "$BRANCH_MODE" && "$BRANCH_MODE" != "$1" ]]; then
        echo "kookr-merge: conflicting options: $BRANCH_MODE and $1" >&2
        exit 2
      fi
      BRANCH_MODE="$1"
      shift
      ;;
    -h|--help)
      print_usage
      exit 0
      ;;
    --)
      shift
      if [[ -z "$PR" && $# -gt 0 && "$1" != -* ]]; then
        PR="$1"
        shift
      fi
      if [[ $# -gt 0 ]]; then
        echo "kookr-merge: unexpected argument after --: $1" >&2
        exit 2
      fi
      break
      ;;
    -*)
      echo "kookr-merge: unknown option: $1" >&2
      exit 2
      ;;
    *)
      if [[ -z "$PR" ]]; then
        PR="$1"
      else
        echo "kookr-merge: unexpected argument: $1" >&2
        exit 2
      fi
      shift
      ;;
  esac
done

if [[ -z "$PR" ]]; then
  print_usage >&2
  exit 2
fi

if ! [[ "$PR" =~ ^[0-9]+$ ]]; then
  echo "kookr-merge: PR number must be numeric, got: $PR" >&2
  exit 2
fi

command -v gh >/dev/null || { echo "kookr-merge: gh (GitHub CLI) is required" >&2; exit 1; }
command -v jq >/dev/null || { echo "kookr-merge: jq is required" >&2; exit 1; }

# Decide whether a zero-check PR is genuinely merge-eligible.
#
# `total == 0` alone is NOT "nothing to wait on": right after a PR opens the
# statusCheckRollup can be empty while GitHub is still registering required
# checks and computing mergeability. Returning success there would merge
# prematurely on a branch-protected repo (the transient pre-registration
# window called out in issue #2148).
#
# mergeStateStatus is authoritative — it is the only field that reflects branch
# protection AND check registration. CLEAN means nothing is blocking; every
# other value (BLOCKED, BEHIND, UNSTABLE, DIRTY, UNKNOWN) means "keep waiting".
#
# mergeable is only a Git-level conflict signal (MERGEABLE / CONFLICTING /
# UNKNOWN); it flips to MERGEABLE within seconds of PR creation regardless of
# checks or protection, so it must NOT override a non-CLEAN mergeStateStatus.
# It is consulted only as a fallback when mergeStateStatus is absent — i.e. on
# a gh old enough not to populate the field at all.
zero_check_merge_eligible() {
  local checks="$1" merge_state mergeable
  merge_state="$(printf '%s' "$checks" | jq -r '(.mergeStateStatus // "") | ascii_upcase')"
  if [[ -n "$merge_state" ]]; then
    [[ "$merge_state" == "CLEAN" ]]
    return
  fi
  mergeable="$(printf '%s' "$checks" | jq -r '(.mergeable // "") | ascii_upcase')"
  [[ "$mergeable" == "MERGEABLE" ]]
}

# run_head_check_classifier — classify the head SHA's check runs with the same
# reusable classifier the delivery playbooks call (scripts/check-verification.mjs),
# so kookr-merge and the playbooks agree bit-for-bit on what "never executed"
# means. `$1` is the head SHA to classify — passed with `--sha` so the whole
# merge path (classification, local-gate binding, and the final --match-head
# pin) uses ONE head definition (`commits | last`). The classifier's human
# summary is echoed to stderr for the run log. Returns its exit code: 0
# executed-green/none-required, 10 never-executed, 20 executed-red, 30 pending,
# 1 error. Any inability to classify (no node, classifier missing, gh error)
# returns non-10 so the caller treats the failure as a real one — fail closed.
run_head_check_classifier() {
  local head_sha="$1"
  if ! command -v node >/dev/null 2>&1; then
    echo "kookr-merge: node is required to classify never-executed checks; treating the check failure as real" >&2
    return 1
  fi
  if [[ ! -f "$KOOKR_MERGE_CLASSIFIER" ]]; then
    echo "kookr-merge: check classifier not found at $KOOKR_MERGE_CLASSIFIER; treating the check failure as real" >&2
    return 1
  fi
  local rc=0
  node "$KOOKR_MERGE_CLASSIFIER" --sha "$head_sha" ${REPO_ARG[@]+"${REPO_ARG[@]}"} >&2 || rc=$?
  return "$rc"
}

# local_gate_recorded_on_head — true iff the PR records the local verification
# gate for the given head SHA: the `local-verified` label AND a comment carrying
# the local-gate marker with a `local-gate-head-sha:` line equal to that SHA.
# `$1` is the `gh pr view` JSON (comments+labels), `$2` the head SHA — both
# resolved once by the caller so the classifier and the gate see the same head.
# The head binding makes the waiver specific to the reviewed code — a local-gate
# comment from an earlier push does not carry forward — mirroring the exact-head
# binding of the independent-review gate (issue #3396).
local_gate_recorded_on_head() {
  local view="$1" head_sha="$2" decision
  decision="$(printf '%s' "$view" | jq -r \
    --arg marker "$KOOKR_LOCAL_GATE_MARKER" \
    --arg wantlabel "$KOOKR_LOCAL_VERIFIED_LABEL" \
    --arg head "$head_sha" '
    def strip: gsub("^\\s+|\\s+$"; "");
    ([ .labels[]?.name | ascii_downcase ] | index(($wantlabel | ascii_downcase))) as $hasLabel
    | ([ .comments[]?
         | select((.body // "") | contains($marker))
         | ((.body // "") | split("\n") | map(strip))[]
         | select(ascii_downcase | startswith("local-gate-head-sha:"))
         | ascii_downcase | ltrimstr("local-gate-head-sha:") | strip
       ] | index($head)) as $hasComment
    | if ($hasLabel != null) and ($hasComment != null) then "ok" else "missing" end
  ')"
  [[ "$decision" == "ok" ]]
}

# never_executed_merge_allowed — the rollup looks failed; decide whether that is
# actually an EXTERNAL never-executed block (GitHub Actions billing/quota) that
# the recorded local gate waives, versus a check that RAN and failed on the code.
# Returns 0 to ALLOW the merge (never-executed + local gate on the current head),
# 1 to refuse (executed-red, still pending, classifier error, or never-executed
# without the recorded local gate). executed-red is NEVER waived, even when the
# local-verified label is present.
never_executed_merge_allowed() {
  local view head_sha rc=0
  # Resolve the head + comments once. `commits | last | .oid` is the same head
  # definition require_review_verdict pins the merge to, so classification, the
  # local-gate binding, and the final pin never disagree.
  if ! view="$(gh pr view "$PR" ${REPO_ARG[@]+"${REPO_ARG[@]}"} --json comments,labels,commits)"; then
    echo "kookr-merge: could not read the PR for the local gate; treating the check failure as real" >&2
    return 1
  fi
  head_sha="$(printf '%s' "$view" | jq -r '((.commits // []) | last | .oid // "") | ascii_downcase')"
  if [[ -z "$head_sha" ]]; then
    echo "kookr-merge: could not resolve the PR head SHA; treating the check failure as real" >&2
    return 1
  fi

  run_head_check_classifier "$head_sha" || rc=$?
  if [[ "$rc" != "10" ]]; then
    # 20 executed-red, 30 pending, 0 green (rollup lag), or 1 error — never waive.
    return 1
  fi
  if local_gate_recorded_on_head "$view" "$head_sha"; then
    echo "kookr-merge: checks never executed (external GitHub Actions billing/quota block, not a code failure); the PR carries the '$KOOKR_LOCAL_VERIFIED_LABEL' label and a local-gate comment bound to the current head — proceeding on the local verification gate (issue #3396)"
    return 0
  fi
  echo "kookr-merge: checks never executed (billing/quota), but the local gate is not recorded on the current head." >&2
  echo "kookr-merge: to merge, record local verification on this PR — add the '$KOOKR_LOCAL_VERIFIED_LABEL' label AND comment the local-gate result with a 'local-gate-head-sha: <current head>' line — then retry." >&2
  return 1
}

watch_checks() {
  # Shared pre-flight for BOTH the --watch fast path and the poll loop.
  # A PR with no reported checks has statusCheckRollup=null (repos without CI)
  # or []; there is nothing to wait on. Without special-casing that:
  #   - poll path: jq iteration over null errors; empty [] never satisfies a
  #     "total != 0 && pending == 0" success condition and spins to timeout
  #     (issues #1850, #2148)
  #   - `gh pr checks [--watch]` exits 1 with "no checks reported on the
  #     '<branch>' branch" — which used to surface as kookr-merge exit 3
  #     (issue #2102)
  # But a zero-check PR is treated as an immediate success ONLY when GitHub
  # confirms it with mergeStateStatus=CLEAN (or mergeable=MERGEABLE on older gh
  # that omits mergeStateStatus). Otherwise checks may still be registering, so
  # we fall through to the poll loop and wait for the merge state to settle
  # rather than merging prematurely (issue #2148).
  local checks total
  checks="$(gh pr view "$PR" ${REPO_ARG[@]+"${REPO_ARG[@]}"} --json statusCheckRollup,mergeStateStatus,mergeable)" || return 3
  total="$(printf '%s' "$checks" | jq '(.statusCheckRollup // []) | length')"
  if [[ "$total" == "0" ]] && zero_check_merge_eligible "$checks"; then
    echo "kookr-merge: no status checks reported and merge state is clean — nothing to wait on"
    return 0
  fi

  # With real checks present, prefer gh's built-in --watch when available.
  # Zero-check-but-not-yet-clean PRs must NOT use --watch (it exits 1 on "no
  # checks", issue #2102) — they fall through to the poll loop below.
  if [[ "$total" != "0" ]] && gh pr checks --help 2>/dev/null | grep -q -- '--watch'; then
    if gh pr checks "$PR" ${REPO_ARG[@]+"${REPO_ARG[@]}"} --watch; then
      return 0
    fi
    # A non-zero --watch means at least one check settled as "not passing". That
    # is a real red UNLESS the checks never executed (external billing/quota) and
    # the local gate is recorded on the current head (issue #3396).
    if never_executed_merge_allowed; then
      return 0
    fi
    return 3
  fi

  local timeout="${KOOKR_MERGE_CHECK_TIMEOUT_SECONDS:-3600}"
  local interval="${KOOKR_MERGE_CHECK_INTERVAL_SECONDS:-15}"
  local start now elapsed failed pending
  start=$(date +%s)
  echo "kookr-merge: polling statusCheckRollup + mergeStateStatus"

  while true; do
    checks="$(gh pr view "$PR" ${REPO_ARG[@]+"${REPO_ARG[@]}"} --json statusCheckRollup,mergeStateStatus,mergeable)" || return 3
    # `// []` keeps the jq iterations from erroring if the rollup becomes null mid-poll.
    total="$(printf '%s' "$checks" | jq '(.statusCheckRollup // []) | length')"

    if [[ "$total" == "0" ]]; then
      # No checks reported. Succeed only once GitHub confirms the PR is clean;
      # a blank / non-CLEAN state means checks may still be registering (#2148),
      # so keep polling until the merge state settles or we time out.
      if zero_check_merge_eligible "$checks"; then
        echo "kookr-merge: no status checks reported and merge state is clean — nothing to wait on"
        return 0
      fi
      now=$(date +%s)
      elapsed=$((now - start))
      if (( elapsed >= timeout )); then
        echo "kookr-merge: timed out after ${elapsed}s waiting for merge state to clear (no checks reported)" >&2
        printf '%s\n' "$checks" | jq -r '"  mergeStateStatus=\(.mergeStateStatus // "?") mergeable=\(.mergeable // "?")"' >&2
        return 3
      fi
      echo "kookr-merge: no checks yet and merge state not clean; sleeping ${interval}s"
      sleep "$interval"
      continue
    fi

    failed="$(printf '%s' "$checks" | jq '[(.statusCheckRollup // [])[] | select(.status == "COMPLETED" and (.conclusion as $c | $c != "SUCCESS" and $c != "SKIPPED" and $c != "NEUTRAL"))] | length')"
    pending="$(printf '%s' "$checks" | jq '[(.statusCheckRollup // [])[] | select(.status != "COMPLETED")] | length')"

    if [[ "$failed" != "0" ]]; then
      printf '%s\n' "$checks" | jq -r '(.statusCheckRollup // [])[] | select(.status == "COMPLETED" and (.conclusion as $c | $c != "SUCCESS" and $c != "SKIPPED" and $c != "NEUTRAL")) | "  \(.name): \(.conclusion)"' >&2
      # A failing rollup is a real red UNLESS the checks never executed (external
      # billing/quota block) and the local gate is recorded on the current head.
      if never_executed_merge_allowed; then
        return 0
      fi
      return 3
    fi

    if [[ "$pending" == "0" ]]; then
      printf '%s\n' "$checks" | jq -r '(.statusCheckRollup // [])[] | "  \(.name): \(.conclusion)"'
      return 0
    fi

    now=$(date +%s)
    elapsed=$((now - start))
    if (( elapsed >= timeout )); then
      echo "kookr-merge: timed out waiting for checks after ${elapsed}s" >&2
      printf '%s\n' "$checks" | jq -r '(.statusCheckRollup // [])[] | "  \(.name): \(.status) \(.conclusion // "")"' >&2
      return 3
    fi

    echo "kookr-merge: checks pending (${pending}/${total}); sleeping ${interval}s"
    sleep "$interval"
  done
}

# merge_pinned_via_api — squash-merge $PR pinned to a head SHA through the REST
# API, for a gh too old to have `gh pr merge --match-head-commit` (issue #1853).
# `sha` is the same head pin that flag sends: GitHub refuses the merge with 409
# if the PR head has moved on, so an unreviewed commit can never slip in.
# Branch deletion is not done here: every merge path shares delete_head_branch
# after the merge is confirmed.
# Returns 0 on a merged PR, 1 otherwise.
merge_pinned_via_api() {
  local head_sha="$1"
  local slug="" resp=""

  slug="$REPO_SLUG"
  if [[ -z "$slug" ]]; then
    # Only reached when --repo was absent, so REPO_ARG is empty here too and
    # `gh repo view` resolves the repo from the current git remote.
    slug="$(gh repo view --json nameWithOwner -q .nameWithOwner)" || {
      echo "kookr-merge: could not resolve the target repo for the REST merge" >&2
      return 1
    }
  fi

  # `gh --repo` accepts HOST/OWNER/REPO and full URLs, but an API path wants a
  # bare OWNER/REPO. Splicing the long form in unchanged yields a 404 reported as
  # a phantom head race, so reduce to the last two segments and refuse anything
  # that still is not OWNER/REPO rather than calling a malformed path.
  slug="${slug#http://}"
  slug="${slug#https://}"
  slug="${slug%/}"
  slug="${slug%.git}"
  if [[ "$slug" == */*/* ]]; then
    slug="${slug#"${slug%/*/*}/"}"
  fi
  if [[ ! "$slug" =~ ^[^/]+/[^/]+$ ]]; then
    echo "kookr-merge: cannot derive OWNER/REPO for the REST merge from '$REPO_SLUG'" >&2
    return 1
  fi

  # --raw-field, not --field: a SHA must stay a JSON string. --field infers types,
  # and an all-digit SHA would go out as a number the API rejects.
  if ! resp="$(gh api --method PUT "repos/$slug/pulls/$PR/merge" \
      --raw-field "sha=$head_sha" --raw-field "merge_method=squash")"; then
    echo "kookr-merge: REST merge refused — the head is no longer $head_sha, or the PR is not mergeable" >&2
    return 1
  fi
  # A 2xx is not proof of a merge: the response body carries `merged`, and the
  # endpoint can answer 200 with merged:false. Reporting a merge that did not
  # happen is the worst outcome here — the caller closes the PR out as landed —
  # so believe the field, not the exit status.
  if ! printf '%s' "$resp" | jq -e '.merged == true' >/dev/null 2>&1; then
    echo "kookr-merge: REST merge call succeeded but PR #$PR did not merge: $(printf '%s' "$resp" | jq -r '.message // "no message in response"')" >&2
    return 1
  fi
  echo "kookr-merge: merged PR #$PR (squash), pinned to $head_sha"
  return 0
}

# read_head_branch — record the PR's head branch and head repository in
# HEAD_REF / HEAD_SLUG, before merging (afterwards the branch may already be
# gone). A failed read leaves both empty, and delete_head_branch then skips the
# delete rather than aiming it at a guessed ref. On a cross-repo PR the head
# repository is the fork, which is where the branch lives.
HEAD_REF=""
HEAD_SLUG=""
read_head_branch() {
  local head_json=""
  head_json="$(gh pr view "$PR" ${REPO_ARG[@]+"${REPO_ARG[@]}"} --json headRefName,headRepository,headRepositoryOwner)" || head_json=""
  HEAD_REF="$(printf '%s' "$head_json" | jq -r '.headRefName // ""' 2>/dev/null)" || HEAD_REF=""
  HEAD_SLUG="$(printf '%s' "$head_json" | jq -r 'if .headRepositoryOwner.login and .headRepository.name then .headRepositoryOwner.login + "/" + .headRepository.name else "" end' 2>/dev/null)" || HEAD_SLUG=""
}

# delete_head_branch — delete the PR's source branch through the REST API, after
# the merge is confirmed. This replaces `gh pr merge --delete-branch`, whose local
# half (check out the base branch, delete the local branch) fails in a linked
# worktree when the base branch is checked out in another worktree, turning a
# successful merge into exit 1 (issue #3641). The API call touches only the
# remote ref, so it behaves the same from any checkout or from no checkout.
# Never fails the caller: the merge has already happened.
delete_head_branch() {
  if [[ "$BRANCH_MODE" == "--preserve-branch" ]]; then
    echo "kookr-merge: source-branch deletion skipped (--preserve-branch); caller is responsible for later cleanup"
    return 0
  fi
  if [[ -z "$HEAD_REF" || -z "$HEAD_SLUG" ]]; then
    # The pre-merge head read failed. Say so: silence here is indistinguishable
    # from a branch that was deleted.
    echo "kookr-merge: could not resolve the head branch; it was left in place (delete it manually if wanted)" >&2
    return 0
  fi
  # Never delete the configured integration branch (#3797): merging its own
  # promotion PR (integration -> main) through this wrapper would otherwise
  # remove it, and the train and every later retarget would stop working.
  local integration=""
  if declare -F delivery_gate_integration_branch >/dev/null; then
    integration="$(delivery_gate_integration_branch 2>/dev/null || true)"
  fi
  if [[ -n "$integration" && "$HEAD_REF" == "$integration" ]]; then
    echo "kookr-merge: head branch $HEAD_REF is the integration branch (.kookr/delivery-gate.json); it was left in place"
    return 0
  fi
  # Percent-encode each path segment of the ref (keeping its `/` separators):
  # git allows `#`, `?` and `%` in branch names, and unencoded they would cut or
  # reinterpret the URL, so `release#42` would DELETE the `release` branch.
  # (`gh pr merge --delete-branch` escaped the ref the same way.) If encoding
  # fails, leave the branch rather than send a raw, possibly wrong, path.
  local ref_path="" out=""
  if ! ref_path="$(jq -rn --arg r "$HEAD_REF" '$r | split("/") | map(@uri) | join("/")' 2>/dev/null)" \
      || [[ -z "$ref_path" ]]; then
    echo "kookr-merge: could not encode head branch $HEAD_REF for the API; it was left in place (delete it manually if wanted)" >&2
    return 0
  fi
  if out="$(gh api --method DELETE "repos/$HEAD_SLUG/git/refs/heads/$ref_path" 2>&1)"; then
    echo "kookr-merge: deleted head branch $HEAD_REF"
  elif [[ "$(printf '%s' "$out" | tr '[:upper:]' '[:lower:]')" == *"reference does not exist"* ]]; then
    # The repository's "automatically delete head branches" setting got there first.
    echo "kookr-merge: head branch $HEAD_REF was already deleted"
  else
    echo "kookr-merge: head branch $HEAD_REF was not deleted (delete it manually: gh api --method DELETE 'repos/$HEAD_SLUG/git/refs/heads/$ref_path'): ${out%%$'\n'*}" >&2
  fi
  return 0
}

# unclosed_issues — read "OWNER/NAME NUMBER" lines on stdin and print
# "OWNER/NAME NUMBER STATE" for each issue that is not closed: STATE is `open`,
# or `unknown` when the state could not be read. An unreadable issue is kept, so
# a lookup failure is never mistaken for a closed issue.
unclosed_issues() {
  local slug number state
  while read -r slug number; do
    [[ -n "$slug" && -n "$number" ]] || continue
    state="$(gh api "repos/$slug/issues/$number" --jq .state </dev/null 2>/dev/null)" || state="unknown"
    state="$(printf '%s' "$state" | tr '[:upper:]' '[:lower:]')"
    if [[ "$state" != "closed" ]]; then
      printf '%s %s %s\n' "$slug" "$number" "${state:-unknown}"
    fi
  done
}

# body_closing_numbers — read a PR body on stdin and print the same-repository
# issue numbers it closes by keyword (close/closes/closed, fix/fixes/fixed,
# resolve/resolves/resolved, optional colon, whitespace, `#N`), one per line.
# `owner/repo#N` and URLs never match: the keyword must be followed by `#`.
# Only the prose counts, as in `prBodyProse` in
# scripts/lib/integration-train-core.ts (both are tested on one table of
# bodies): fenced code blocks, quoted lines (`>`) and inline code are removed,
# then HTML comments (an unclosed fence or comment runs to the end), so a quoted
# commit list such as `fix: resolve #77 crash` closes nothing and a `<!--`
# written as code hides nothing. Numbers longer than 9 digits are ignored.
body_closing_numbers() {
  jq -r '
    (.body // "")
    | reduce (split("\n")[] | sub("\r\\z"; "")) as $line ({fence: null, out: []};
        ([$line | capture("^ {0,3}(?<m>`{3,}|~{3,})")] | first | .m?) as $marker
        | if .fence != null then
            if $marker != null and ($marker[0:1] == .fence[0:1]) and (($marker | length) >= (.fence | length))
               and ($line | test("^ {0,3}[`~]+\\s*\\z")) then .fence = null else . end
          elif $marker != null then .fence = $marker
          elif ($line | test("^\\s*>")) then .
          else .out += [$line | gsub("(`+)[\\s\\S]*?\\1"; " ")]
          end)
    | .out | join("\n")
    | gsub("<!--[\\s\\S]*?(?:-->|\\z)"; " ")
    | [scan("(?i)(?<![A-Za-z0-9_])(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s*:?\\s+#([0-9]{1,9})(?![0-9A-Za-z_])") | .[0]]
    | map(tonumber | select(. > 0)) | reduce .[] as $n ([]; if index([$n]) then . else . + [$n] end) | .[]' 2>/dev/null
}

# report_open_closing_issues — after the merge, report every issue the PR
# declares as closing (closingIssuesReferences: a `Closes #N` keyword or a
# manual link) that is still open. GitHub closes them asynchronously, and only
# when the PR merged into the default branch, so a still-open issue is checked
# once more after KOOKR_MERGE_CHECK_INTERVAL_SECONDS before it is reported.
# Report only: never changes the exit code.
report_open_closing_issues() {
  local refs="" list="" unclosed="" slug number state
  if ! refs="$(gh pr view "$PR" ${REPO_ARG[@]+"${REPO_ARG[@]}"} --json closingIssuesReferences,body 2>/dev/null)"; then
    echo "kookr-merge: could not read the issues PR #$PR declares as closing (gh too old?); check them by hand" >&2
    return 0
  fi
  list="$(printf '%s' "$refs" | jq -r '
    (.closingIssuesReferences // [])[]
    | select(.number != null and (.repository.owner.login // "") != "" and (.repository.name // "") != "")
    | "\(.repository.owner.login)/\(.repository.name) \(.number)"' 2>/dev/null)" || list=""
  if [[ -n "$MERGE_INTO_INTEGRATION" ]]; then
    # Merged into the integration branch: GitHub only auto-closes on the default
    # branch, so these stay open by design. No wait, no retry. GitHub returns an
    # empty closingIssuesReferences for a PR whose base is not the default
    # branch, so the numbers the body closes by keyword are added (de-duplicated).
    local nums="" body_nums=""
    body_nums="$(printf '%s' "$refs" | body_closing_numbers)" || body_nums=""
    nums="$({ printf '%s\n' "$list" | awk 'NF { print $2 }'; printf '%s\n' "$body_nums"; } \
      | awk 'NF && !seen[$1]++ { printf "%s%s", (n++ ? ", " : ""), "#" $1 }')"
    [[ -n "$nums" ]] || return 0
    echo "kookr-merge: closing issue(s) $nums stay open until the integration train promotes this change to $MERGE_INTO_INTEGRATION"
    return 0
  fi
  [[ -n "$list" ]] || return 0

  unclosed="$(printf '%s\n' "$list" | unclosed_issues)"
  if [[ -n "$unclosed" ]]; then
    sleep "${KOOKR_MERGE_CHECK_INTERVAL_SECONDS:-15}"
    unclosed="$(printf '%s\n' "$unclosed" | cut -d' ' -f1,2 | unclosed_issues)"
  fi
  if [[ -z "$unclosed" ]]; then
    echo "kookr-merge: every issue PR #$PR declares as closing is closed"
    return 0
  fi
  while read -r slug number state; do
    [[ -n "$slug" ]] || continue
    if [[ "$state" == "open" ]]; then
      echo "kookr-merge: issue $slug#$number is declared as closed by PR #$PR but is still open — close it (gh issue close $number --repo $slug) or confirm it should stay open" >&2
    else
      echo "kookr-merge: could not read the state of closing issue $slug#$number; check it by hand" >&2
    fi
  done <<<"$unclosed"
  return 0
}

state_json="$(gh pr view "$PR" ${REPO_ARG[@]+"${REPO_ARG[@]}"} --json state,isDraft,reviewDecision)"
state=$(printf '%s' "$state_json" | jq -r '.state')
is_draft=$(printf '%s' "$state_json" | jq -r '.isDraft')
review_decision=$(printf '%s' "$state_json" | jq -r '.reviewDecision // ""')

case "$state" in
  OPEN) ;;
  *)
    echo "kookr-merge: PR #$PR state=$state — not mergeable" >&2
    exit 1
    ;;
esac

if [[ "$is_draft" == "true" ]]; then
  echo "kookr-merge: PR #$PR is a draft — mark ready before merging" >&2
  exit 1
fi

if [[ "$review_decision" == "CHANGES_REQUESTED" ]]; then
  echo "kookr-merge: PR #$PR has changes requested — address feedback before merging" >&2
  exit 1
fi

retarget_to_integration_branch

if ! require_review_verdict; then
  exit 4
fi

echo "kookr-merge: watching checks for PR #$PR"
if ! watch_checks; then
  echo "kookr-merge: checks did not pass for PR #$PR" >&2
  exit 3
fi

echo "kookr-merge: checks passed, squash-merging PR #$PR"
# Read the head branch now; after the merge it may already be gone.
if [[ "$BRANCH_MODE" != "--preserve-branch" ]]; then
  read_head_branch
fi

# Pin the merge to the reviewed head when the review gate ran (REVIEW_HEAD_SHA is
# set inside require_review_verdict). If the head advanced during the wait, the
# merge is refused rather than merging an unreviewed commit.
#
# Two ways to express the same server-side pin, in order of preference:
#   1. `gh pr merge --match-head-commit` (gh >= ~2.15).
#   2. The REST merge endpoint's `sha` parameter (any gh with `gh api`), which
#      is what that flag sends on the wire. GitHub answers 409 when the head has
#      advanced past `sha`, so the TOCTOU window is closed either way.
# Both leave the squash commit message to GitHub's server-side default, so the
# resulting history is identical whichever path runs. Neither passes
# --delete-branch: the branch is deleted through the API below (issue #3641).
cli_merge=1
if [[ -z "${REVIEW_HEAD_SHA:-}" ]]; then
  gh pr merge "$PR" ${REPO_ARG[@]+"${REPO_ARG[@]}"} --squash
elif gh pr merge --help 2>&1 | grep -q -- '--match-head-commit'; then
  gh pr merge "$PR" ${REPO_ARG[@]+"${REPO_ARG[@]}"} --squash \
    --match-head-commit "$REVIEW_HEAD_SHA"
else
  echo "kookr-merge: installed gh lacks --match-head-commit; pinning the head via the REST API instead"
  merge_pinned_via_api "$REVIEW_HEAD_SHA" || exit 1
  cli_merge=0
fi

if [[ "$cli_merge" -eq 1 ]]; then
  # `gh pr merge` can exit 0 after queueing rather than completing. Confirm the
  # PR actually merged before treating it as landed. The REST merge body uses
  # `.merged`, but that is not a `gh pr view --json` field — older (and current)
  # gh list `state`, `mergedAt`, `mergedBy`, `mergeCommit` and reject `merged`
  # (issue #3403). Asking for `merged` made a successful squash-merge look like
  # a failure. `state=MERGED` or a non-null `mergedAt` is the same postcondition
  # on fields gh already supports.
  if ! merged_json="$(gh pr view "$PR" ${REPO_ARG[@]+"${REPO_ARG[@]}"} --json state,mergedAt)"; then
    echo "kookr-merge: could not verify whether PR #$PR merged" >&2
    exit 1
  fi
  if ! printf '%s' "$merged_json" | jq -e \
      '((.state // "") | ascii_upcase) == "MERGED" or ((.mergedAt // null) != null)' \
      >/dev/null 2>&1; then
    echo "kookr-merge: PR #$PR did not merge according to GitHub" >&2
    exit 1
  fi
fi

# The merge is confirmed. Nothing below may change the exit code.
delete_head_branch || true
report_open_closing_issues || true
exit 0
