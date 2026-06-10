---
name: codex-pr-plan
description: Plan phase for codex-pr-lessons playbook — load state, determine next batch of PRs to analyze
keywords: codex, pr, plan, batch, pagination, state
related: [codex-pr-critic, codex-pr-state, codex-pr-threshold, codex-pr-distill]
---

## When to Use

This skill is invoked at the start of each codex-pr-lessons iteration. It reads the current state, determines which PRs to fetch next, and prepares the batch.

## Non-Negotiable Rules

| # | Rule | Violation Example | Correct Pattern |
|---|------|-------------------|-----------------|
| 1 | Always read state.json before fetching PRs | Fetching PRs without checking processed list | `cat ~/.claude/codex-pr-lessons/state.json` first |
| 2 | Batch size is exactly 5 | Processing 10 or 20 PRs at once | Fetch 5 closed+merged PRs per iteration |
| 3 | Use cursor for pagination | Re-fetching from page 1 every time | Use `state.json.cursor` to continue from last position |
| 4 | Skip already-processed PRs | Analyzing PR #123 that's in processed_prs | Filter out all IDs in processed_prs and skipped_prs |
| 5 | Include both merged AND closed-unmerged PRs | Only looking at merged PRs | Closed-unmerged PRs teach what NOT to do |

## Workflow

### Step 1: Load state

```bash
cat ~/.claude/codex-pr-lessons/state.json
```

### Step 2: Fetch next batch of closed PRs

Use GitHub API with cursor-based pagination. Fetch closed PRs sorted by recently updated, mixing merged and unmerged:

```bash
# Fetch closed PRs (both merged and closed-without-merge)
# Use cursor from state to avoid re-processing pages
gh api "repos/openai/codex/pulls?state=closed&sort=updated&direction=desc&per_page=20&page={cursor_or_1}" \
  --jq '.[] | {number, title, merged_at, closed_at, user: .user.login, additions, deletions, changed_files, body: (.body[:200])}'
```

### Step 3: Filter and select batch

From the fetched PRs:
1. Remove any PR whose number is in `processed_prs` or `skipped_prs`
2. Skip bot PRs (dependabot, renovate) — add to `skipped_prs`
3. Skip PRs with zero discussion and zero code changes (empty/accidental) — add to `skipped_prs`
4. Select the first 5 remaining PRs as the batch

### Step 4: Output batch manifest

Return a list of PR numbers and titles for the critic phase to process.

## Skip Criteria

Add to `skipped_prs` (never revisit):
- Bot-authored PRs (dependabot, github-actions, renovate)
- PRs that were opened and closed within 1 minute (accidental)
- Draft PRs that were never marked ready
- PRs with 0 files changed

## Cursor Strategy

- `cursor` in state.json is the GitHub API page number (starts at 1)
- After processing a page, increment cursor if all PRs on that page were already processed or skipped
- If the batch was filled from the current page, keep the cursor the same for next iteration
- If cursor reaches a page with 0 results, reset to 1 (wrap around for newly closed PRs)

## Failure Handling

Consistent three-case shape — never guess past a broken state file:

- **Missing `state.json`** — first run: initialize it from the documented schema, then proceed.
- **Malformed `state.json`** — validate before use: `jq empty ~/.claude/codex-pr-lessons/state.json || { echo "state.json is corrupt — stopping (a default-to-fresh run would re-process every PR)"; exit 1; }`. Stop and report; never default to a fresh state.
- **Empty batch / repo exhausted** — no unprocessed PRs remain: report "repo exhausted — nothing to plan" and stop cleanly; do not loop or widen the query.

## Divergence From the oss-pr-* Twin

Intentional differences (R9 — do not "fix" by copying from the oss variant):
- Fixed target repo (`openai/codex`); no `repoSlug` parameter.
- State lives at `~/.claude/codex-pr-lessons/` (the oss family uses
  `~/.claude/{repoSlug}-pr-lessons/`).
Anything else that differs from the oss twin is drift, not design — prefer the
oss wording when reconciling.
