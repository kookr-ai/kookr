#!/usr/bin/env bash
# simulate-batch-selection.sh — dry-run the parallel-issue-batch eligibility
# filters for a repository, read-only.
#
# Reproduces the two filters the `parallel-issue-batch` playbook applies to the
# blank selector shape (plugin/playbooks/implement-github-issue.md, Phase 0d):
#   1. Author trust  — allowOtherAuthors=false keeps only issues opened by the
#                      authenticated gh user (issue bodies are untrusted input).
#   2. Blocked-label — skip issues labelled automation-blocked, architecture,
#                      blocked, duplicate, invalid, wontfix, not planned, or
#                      question.
#
# It never claims, edits, or closes an issue — the only GitHub calls are
# `gh api user` and a single `gh issue list`.
#
# Usage: scripts/simulate-batch-selection.sh <owner/repo>
#   e.g. scripts/simulate-batch-selection.sh kookr-ai/kookr
set -euo pipefail

REPO="${1:-}"
if [ -z "$REPO" ]; then
  echo "usage: $0 <owner/repo>" >&2
  exit 2
fi

ME="$(gh api user --jq .login)"

# One anchored regex per playbook-named skip label (matched case-insensitively).
SKIP='^automation-blocked$|^architecture$|^blocked$|^duplicate$|^invalid$|^wontfix$|^not planned$|^question$'

gh issue list -R "$REPO" --state open --limit 200 \
  --json number,title,author,labels \
| jq -r --arg me "$ME" --arg skip "$SKIP" '
    def blocked: (.labels | map(.name | ascii_downcase) | any(test($skip)));
    def mine:    (.author.login == $me);
    (map(select(mine)))                       as $trusted
    | ($trusted | map(select(blocked | not))) as $ok
    | ($trusted | map(select(blocked)))       as $no
    | "author-trusted open issues (@\($me)): \($trusted | length)",
      "",
      "ELIGIBLE (\($ok | length)) — surface to batch:",
      ($ok | sort_by(.number) | reverse | .[]
        | "  #\(.number)  [\(.labels | map(.name) | join(", "))]  \(.title)"),
      "",
      "SKIPPED by blocked-label (\($no | length)):",
      ($no | sort_by(.number) | reverse | .[]
        | "  #\(.number)  [\(.labels | map(.name) | join(", "))]")
  '
