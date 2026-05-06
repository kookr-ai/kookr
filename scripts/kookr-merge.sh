#!/usr/bin/env bash
# kookr-merge — wait for a PR's checks then squash-merge with branch deletion.
#
# Drop-in substitute for `gh pr merge <PR> --auto --squash --delete-branch` on
# repos where GitHub auto-merge is unavailable (private repos on the Free plan
# without branch protection — see issue #29).
#
# Usage: kookr-merge <pr-number> [--repo OWNER/NAME]
set -euo pipefail

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
EOF
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

state_json="$(gh pr view "$PR" "${REPO_ARG[@]}" --json state,isDraft,reviewDecision)"
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

echo "kookr-merge: watching checks for PR #$PR"
if ! gh pr checks "$PR" "${REPO_ARG[@]}" --watch; then
  echo "kookr-merge: checks did not pass for PR #$PR" >&2
  exit 3
fi

echo "kookr-merge: checks passed, squash-merging PR #$PR"
gh pr merge "$PR" "${REPO_ARG[@]}" --squash --delete-branch
