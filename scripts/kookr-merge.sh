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
# mergeability, or the post-merge `.merged == true` confirmation. The caller
# remains responsible for deleting the preserved branch later.
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
# Usage: kookr-merge <pr-number> [--repo OWNER/NAME] [--preserve-branch | --delete-branch]
set -euo pipefail

# Absolute directory of this script, so the reusable check classifier resolves
# whether kookr-merge is invoked by path, via `pnpm merge`, or from another CWD.
KOOKR_MERGE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# --- independent-review gate literals (keep in sync with src/core/independent-review.ts) ---
KOOKR_REVIEW_MARKER='<!-- kookr-independent-review -->'
KOOKR_REVIEW_TIMEOUT_LABEL='review-skipped-timeout'

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
pass. By default the source branch is deleted after a successful merge. Aborts
before merging if the PR is closed, a draft, has changes requested, or any
check fails.

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
  0  merged successfully
  1  pre-flight failed (state/draft/review) or merge command failed
  2  bad usage
  3  one or more checks RAN and failed, or never-executed checks lacked the
     recorded local gate (local-verified label + a local-gate-head-sha comment
     bound to the current head)
  4  blocked by the independent-review gate (no pass verdict / confirmed finding)
EOF
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

  local view head_sha decision
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
  # merge step feature-probes and degrades gracefully (issue #1853).
  REVIEW_HEAD_SHA="$head_sha"

  decision="$(printf '%s' "$view" | jq -r \
    --arg marker "$KOOKR_REVIEW_MARKER" \
    --arg tlabel "$KOOKR_REVIEW_TIMEOUT_LABEL" \
    --arg head "$head_sha" '
    def strip: gsub("^\\s+|\\s+$"; "");
    def verdicts:
      [ .comments[]
        | select(.body | contains($marker))
        | .createdAt as $ts
        | (.body | split("\n") | map(strip)) as $lines
        | ( [ $lines[] | select(ascii_downcase | startswith("kookr-review-verdict:")) ] | last // "" ) as $vline
        | ( $vline | ascii_downcase | ltrimstr("kookr-review-verdict:") | strip ) as $verdict
        | select($verdict == "pass" or $verdict == "block")
        | ( [ $lines[] | select(ascii_downcase | startswith("review-head-sha:")) ] | last // "" ) as $sline
        | ( $sline | ascii_downcase | ltrimstr("review-head-sha:") | strip ) as $sha
        | { ts: ($ts // ""), verdict: $verdict, sha: $sha } ];
    ([ .labels[]?.name | ascii_downcase ] | index($tlabel)) as $hasLabel
    | ( verdicts | sort_by(.ts) | last ) as $v
    | if $v == null then
        (if $hasLabel then "block:timeout-label" else "block:no-verdict" end)
      elif $v.verdict == "block" then
        "block:blocked-finding"
      elif ($v.sha == "" or $head == "") then
        "block:unbound-verdict"
      elif $v.sha != $head then
        "block:stale-verdict"
      else
        "allow:pass"
      end
  ')"

  case "$decision" in
    allow:*)
      echo "kookr-merge: independent-review gate: ${decision#allow:}"
      return 0
      ;;
    *)
      echo "kookr-merge: BLOCKED by the independent-review gate: ${decision#block:}" >&2
      echo "kookr-merge: the latest reviewer verdict must be 'pass' with review-head-sha equal to the current head ($head_sha)." >&2
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

DELETE_BRANCH_ARG=(--delete-branch)
if [[ "$BRANCH_MODE" == "--preserve-branch" ]]; then
  DELETE_BRANCH_ARG=()
fi

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
# Unless preservation was requested, head deletion is a separate best-effort
# call (the flag-based path gets it from --delete-branch). The merge itself
# is what must be atomic.
# Returns 0 on a merged PR, 1 otherwise.
merge_pinned_via_api() {
  local head_sha="$1"
  local slug="" head_json="" head_ref="" head_slug="" resp=""
  local preserve=0
  if [[ "$BRANCH_MODE" == "--preserve-branch" ]]; then
    preserve=1
  fi

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

  # Read the head branch before merging; afterwards it may already be gone. A
  # failed read leaves head_json empty (set -e would otherwise abort the script),
  # and the branch delete below is skipped rather than aimed at a guessed ref.
  # Preservation skips this lookup: no delete request will be issued.
  if [[ "$preserve" -eq 0 ]]; then
    head_json="$(gh pr view "$PR" ${REPO_ARG[@]+"${REPO_ARG[@]}"} --json headRefName,headRepository,headRepositoryOwner)" || head_json=""
    head_ref="$(printf '%s' "$head_json" | jq -r '.headRefName // ""')"
    head_slug="$(printf '%s' "$head_json" | jq -r 'if .headRepositoryOwner.login and .headRepository.name then .headRepositoryOwner.login + "/" + .headRepository.name else "" end')"
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

  if [[ "$preserve" -eq 1 ]]; then
    echo "kookr-merge: source-branch deletion skipped (--preserve-branch); caller is responsible for later cleanup"
    return 0
  fi

  # The head repo is the fork on a cross-repo PR, so delete the ref there — not
  # in the base repo the merge just landed in.
  if [[ -z "$head_ref" || -z "$head_slug" ]]; then
    # The pre-merge head read failed. Say so: silence here is indistinguishable
    # from a branch that was deleted.
    echo "kookr-merge: could not resolve the head branch; it was left in place (delete it manually if wanted)" >&2
  elif gh api --method DELETE "repos/$head_slug/git/refs/heads/$head_ref" >/dev/null 2>&1; then
    echo "kookr-merge: deleted head branch $head_ref"
  else
    echo "kookr-merge: head branch $head_ref was not deleted (delete it manually if wanted)" >&2
  fi
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

if ! require_review_verdict; then
  exit 4
fi

echo "kookr-merge: watching checks for PR #$PR"
if ! watch_checks; then
  echo "kookr-merge: checks did not pass for PR #$PR" >&2
  exit 3
fi

echo "kookr-merge: checks passed, squash-merging PR #$PR"
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
# resulting history is identical whichever path runs.
if [[ -z "${REVIEW_HEAD_SHA:-}" ]]; then
  gh pr merge "$PR" ${REPO_ARG[@]+"${REPO_ARG[@]}"} --squash ${DELETE_BRANCH_ARG[@]+"${DELETE_BRANCH_ARG[@]}"}
elif gh pr merge --help 2>&1 | grep -q -- '--match-head-commit'; then
  gh pr merge "$PR" ${REPO_ARG[@]+"${REPO_ARG[@]}"} --squash ${DELETE_BRANCH_ARG[@]+"${DELETE_BRANCH_ARG[@]}"} \
    --match-head-commit "$REVIEW_HEAD_SHA"
else
  echo "kookr-merge: installed gh lacks --match-head-commit; pinning the head via the REST API instead"
  merge_pinned_via_api "$REVIEW_HEAD_SHA" || exit 1
  exit 0
fi

# `gh pr merge` can exit 0 after queueing rather than completing. Confirm the
# same `.merged == true` postcondition the REST path already requires before
# treating the PR as landed.
if ! merged_json="$(gh pr view "$PR" ${REPO_ARG[@]+"${REPO_ARG[@]}"} --json merged)"; then
  echo "kookr-merge: could not verify whether PR #$PR merged" >&2
  exit 1
fi
if ! printf '%s' "$merged_json" | jq -e '.merged == true' >/dev/null 2>&1; then
  echo "kookr-merge: PR #$PR did not merge according to GitHub" >&2
  exit 1
fi
if [[ "$BRANCH_MODE" == "--preserve-branch" ]]; then
  echo "kookr-merge: source-branch deletion skipped (--preserve-branch); caller is responsible for later cleanup"
fi
