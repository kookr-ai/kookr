---
name: reviewer-distillation-select
description: Select merged PRs with substantive human reviews for the reviewer-distillation experiment (improving the REVIEWER skill via F1 loops). Not for learning repo contribution conventions — that is oss-pr-lessons/oss-pr-plan.
keywords: [reviewer, distillation, select, pr, graphql]
related: [reviewer-distillation-prepare, find-best-reviewers]
---

# SELECT Phase — PR Batch Selection

## When to Use

Called by the reviewer-distillation playbook at the start of each iteration to select the next batch of PRs.

## Parameters

- `repo`: GitHub owner/repo (e.g., `grafana/grafana`)
- `batchSize`: Number of PRs per batch (default: 3 for POC, 10 for production)
- `stateDir`: Path to `~/.claude/{repoSlug}-reviewer-distillation/`

## Bot Filter

Exclude reviews from these accounts (case-insensitive, also any login ending with `[bot]` or `-bot` or containing `bot`):

```
dependabot, renovate, github-actions, copilot-pull-request-reviewer,
coderabbitai, sweep-ai, mergify, bors, grafana-delivery-bot,
grafanabot, CLAassistant, github-advanced-security, chatgpt-codex-connector,
copilot, codecov, sonarcloud, snyk-bot, allstar-app, openai-codex,
semgrep-code-grafana
```

## GraphQL Query

```bash
gh api graphql -f query='
query($owner: String!, $repo: String!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequests(states: MERGED, first: 50, after: $cursor,
                 orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        number
        title
        additions
        deletions
        mergeCommit { oid }
        baseRefName
        author { login }
        reviews(first: 30) {
          nodes {
            author { login }
            state
            comments { totalCount }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}
' -f owner="$OWNER" -f repo="$REPO"
```

## Filter Criteria

A PR qualifies when ALL of these are true:
1. `additions + deletions > 20` (non-trivial)
2. Sum of `reviews.comments.totalCount` ≥ 3 from non-bot human authors
3. PR number NOT in `state.json.processed_prs` or `state.json.skipped_prs`
4. Author is not a bot
5. Title does NOT match: `bump`, `release`, `chore(deps)`, `dependency`, `[release-`
6. `mergeCommit` exists (actually merged)
7. Total diff size < 120K characters (~30K tokens) — skip oversized PRs

## Output

Write selected PR metadata to `state.json` under `current_batch`:

```json
{
  "current_batch": [
    { "number": 121445, "title": "...", "mergeCommitOid": "abc123", "baseRefName": "main" }
  ]
}
```

Add skipped PR numbers to `state.json.skipped_prs` with reason.

## Pagination

Start from `state.json.cursor`. If fewer than `batchSize` PRs qualify in a page, advance cursor and fetch more. If no qualifying PRs remain, report "insufficient data" and stop.
