#!/usr/bin/env bash
# kookr-merge — wait for a PR's checks then squash-merge with branch deletion.
#
# Drop-in substitute for `gh pr merge <PR> --auto --squash --delete-branch` on
# repos where GitHub auto-merge is unavailable (private repos on the Free plan
# without branch protection — see issue #29).
#
# Before merging, an independent-review gate (issue #1717) refuses to merge
# unless the PR carries a fresh-context reviewer verdict of `pass` for the
# current head, or the sanctioned `review-skipped-timeout` label. This makes
# zero-review autonomous merges unreachable. The gate literals below are kept in
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
# the current head SHA, or the PR carries the timeout label. Returns 0 to allow,
# 4 to block. Set KOOKR_MERGE_REQUIRE_REVIEW=0 to skip entirely.
require_review_verdict() {
  local require="${KOOKR_MERGE_REQUIRE_REVIEW:-1}"
  if [[ "$require" == "0" || "$require" == "false" ]]; then
    echo "kookr-merge: independent-review gate disabled (KOOKR_MERGE_REQUIRE_REVIEW=$require)"
    return 0
  fi

  local view head_sha decision
  if ! view="$(gh pr view "$PR" ${REPO_ARG[@]+"${REPO_ARG[@]}"} --json comments,labels,headRefOid)"; then
    echo "kookr-merge: could not read PR comments/labels for the review gate" >&2
    return 4
  fi
  head_sha="$(printf '%s' "$view" | jq -r '.headRefOid // "" | ascii_downcase')"
  # Export the reviewed head so the final merge can pin to it (--match-head-commit),
  # closing the TOCTOU window where the head advances during the check-watch wait
  # and an unreviewed commit would otherwise merge.
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
        (if $hasLabel then "allow:timeout-label" else "block:no-verdict" end)
      elif $v.verdict == "block" then
        "block:blocked-finding"
      elif ($v.sha != "" and $head != "" and $v.sha != $head) then
        (if $hasLabel then "allow:timeout-label-stale" else "block:stale-verdict" end)
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
      echo "kookr-merge: the latest reviewer verdict must be 'pass' for the current head ($head_sha)," >&2
      echo "kookr-merge: or the PR must carry the '$KOOKR_REVIEW_TIMEOUT_LABEL' label." >&2
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
      shift 2
      ;;
    --repo=*)
      REPO_ARG=(--repo "${1#--repo=}")
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

watch_checks() {
  if gh pr checks --help 2>/dev/null | grep -q -- '--watch'; then
    gh pr checks "$PR" ${REPO_ARG[@]+"${REPO_ARG[@]}"} --watch
    return $?
  fi

  local timeout="${KOOKR_MERGE_CHECK_TIMEOUT_SECONDS:-3600}"
  local interval="${KOOKR_MERGE_CHECK_INTERVAL_SECONDS:-15}"
  local start now elapsed checks failed pending total
  start=$(date +%s)
  echo "kookr-merge: gh pr checks --watch unavailable; polling statusCheckRollup"

  while true; do
    checks="$(gh pr view "$PR" ${REPO_ARG[@]+"${REPO_ARG[@]}"} --json statusCheckRollup)" || return 3
    # A PR with no reported checks has statusCheckRollup=null (repos without CI)
    # or []; `// []` keeps the jq iterations from erroring on null.
    total="$(printf '%s' "$checks" | jq '(.statusCheckRollup // []) | length')"
    failed="$(printf '%s' "$checks" | jq '[(.statusCheckRollup // [])[] | select(.status == "COMPLETED" and (.conclusion as $c | $c != "SUCCESS" and $c != "SKIPPED" and $c != "NEUTRAL"))] | length')"
    pending="$(printf '%s' "$checks" | jq '[(.statusCheckRollup // [])[] | select(.status != "COMPLETED")] | length')"

    # No checks reported → nothing to wait on; treat as passing (matches the
    # `gh pr checks --watch` path's "no checks reported" behavior). Without this,
    # a null rollup errors and an empty [] rollup would poll until timeout.
    if [[ "$total" == "0" ]]; then
      echo "kookr-merge: no status checks reported — nothing to wait on"
      return 0
    fi

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
# set inside require_review_verdict). If the head advanced during the wait, gh
# refuses the merge rather than merging an unreviewed commit.
HEAD_PIN=()
if [[ -n "${REVIEW_HEAD_SHA:-}" ]]; then
  HEAD_PIN=(--match-head-commit "$REVIEW_HEAD_SHA")
fi
gh pr merge "$PR" ${REPO_ARG[@]+"${REPO_ARG[@]}"} --squash --delete-branch ${HEAD_PIN[@]+"${HEAD_PIN[@]}"}
