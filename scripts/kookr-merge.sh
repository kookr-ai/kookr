#!/usr/bin/env bash
# kookr-merge — wait for a PR's checks then squash-merge with branch deletion.
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
# Usage: kookr-merge <pr-number> [--repo OWNER/NAME]
set -euo pipefail

# --- independent-review gate literals (keep in sync with src/core/independent-review.ts) ---
KOOKR_REVIEW_MARKER='<!-- kookr-independent-review -->'
KOOKR_REVIEW_TIMEOUT_LABEL='review-skipped-timeout'

PR=""
REPO_ARG=()
REPO_SLUG=""

print_usage() {
  cat <<'EOF'
Usage: kookr-merge <pr-number> [--repo OWNER/NAME]

Watches the PR's checks via `gh pr checks --watch` and squash-merges with
branch deletion once they pass. Aborts before merging if the PR is closed,
a draft, has changes requested, or any check fails.

A drop-in substitute for:
  gh pr merge <pr-number> --auto --squash --delete-branch

Options:
  --repo OWNER/NAME   Target repo (defaults to the current git remote).
  -h, --help          Show this help.

Exit codes:
  0  merged successfully
  1  pre-flight failed (state/draft/review) or merge command failed
  2  bad usage
  3  one or more checks failed (gh pr checks --watch returned non-zero)
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
      REPO_ARG=(--repo "$2")
      REPO_SLUG="$2"
      shift 2
      ;;
    --repo=*)
      REPO_ARG=(--repo "${1#--repo=}")
      REPO_SLUG="${1#--repo=}"
      shift
      ;;
    -h|--help)
      print_usage
      exit 0
      ;;
    --)
      shift
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
    gh pr checks "$PR" ${REPO_ARG[@]+"${REPO_ARG[@]}"} --watch
    return $?
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
# Deleting the head branch is a separate call here (the flag-based path gets it
# from --delete-branch) and is best-effort: the merge is what must be atomic.
# Returns 0 on a merged PR, 1 otherwise.
merge_pinned_via_api() {
  local head_sha="$1"
  local slug head_json head_ref head_slug resp

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
  head_json="$(gh pr view "$PR" ${REPO_ARG[@]+"${REPO_ARG[@]}"} --json headRefName,headRepository,headRepositoryOwner)" || head_json=""
  head_ref="$(printf '%s' "$head_json" | jq -r '.headRefName // ""')"
  head_slug="$(printf '%s' "$head_json" | jq -r 'if .headRepositoryOwner.login and .headRepository.name then .headRepositoryOwner.login + "/" + .headRepository.name else "" end')"

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
  gh pr merge "$PR" ${REPO_ARG[@]+"${REPO_ARG[@]}"} --squash --delete-branch
elif gh pr merge --help 2>&1 | grep -q -- '--match-head-commit'; then
  gh pr merge "$PR" ${REPO_ARG[@]+"${REPO_ARG[@]}"} --squash --delete-branch \
    --match-head-commit "$REVIEW_HEAD_SHA"
else
  echo "kookr-merge: installed gh lacks --match-head-commit; pinning the head via the REST API instead"
  merge_pinned_via_api "$REVIEW_HEAD_SHA" || exit 1
fi
