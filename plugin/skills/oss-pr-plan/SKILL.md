---
name: oss-pr-plan
description: Plan phase for oss-pr-lessons playbook — load state, determine next batch of PRs to analyze for any repository
keywords: oss, pr, plan, batch, pagination, state, open source, contribution, analyze
related: [oss-pr-critic, oss-pr-state, oss-pr-threshold, oss-pr-distill]
---

# OSS PR Plan

Load state and determine the next batch of PRs to analyze. Generalized version of `codex-pr-plan` that works for any repository.

## When to Use

Invoked at the start of each `oss-pr-lessons` iteration.

## Non-Negotiable Rules

| # | Rule | Violation Example | Correct Pattern |
|---|------|-------------------|-----------------|
| 1 | Always read state.json before fetching PRs | Fetching PRs without checking processed list | `cat ~/.claude/{repoSlug}-pr-lessons/state.json` first |
| 2 | Batch size is exactly 5 | Processing 10 or 20 PRs at once | Fetch 5 closed PRs per iteration |
| 3 | Use cursor for pagination | Re-fetching from page 1 every time | Use `state.json.cursor` |
| 4 | Skip already-processed PRs | Analyzing PR #123 that's in processed_prs | Filter out all IDs in processed_prs and skipped_prs |
| 5 | Include both merged AND closed-unmerged PRs | Only looking at merged PRs | Closed-unmerged PRs teach what NOT to do |
| 6 | Validate the batch manifest against state before critic work starts | Selecting #123, then noticing later it was already processed | Print the final 5 IDs and confirm none exist in processed_prs or skipped_prs |

## Parameters

- **repoFullName**: `owner/repo` (e.g., `microsoft/vscode`)
- **repoSlug**: URL-safe slug (e.g., `microsoft-vscode`)

## Pre-Plan: Registry Eligibility Check

Before planning PR analysis, check if the repo is eligible. (`~/.claude/hooks/oss-registry-check` is not yet implemented; the 126/127 branch below already degrades gracefully when it is absent.)

```bash
REPO="{{repoFullName}}"
RESULT=$(~/.claude/hooks/oss-registry-check "$REPO" 2>&1)
RC=$?
echo "$RESULT"

case $RC in
  0) ;; # Eligible — proceed
  1) # Ineligible (anti-ai or blocked)
     echo "Cannot analyze PRs: repo is not eligible for AI contributions."
     exit 0
     ;;
  2) # Unknown — not in registry
     echo "Repo not in registry. Run oss-repo-recon first to assess eligibility."
     exit 0
     ;;
  126|127) # Resolver missing
     echo "WARNING: oss-registry-check not found. Proceeding without eligibility check."
     ;;
esac
```

## Workflow

### Step 1: Initialize state if needed

```bash
SLUG="{{repoSlug}}"
REPO="{{repoFullName}}"
mkdir -p ~/.claude/${SLUG}-pr-lessons

if [ ! -f ~/.claude/${SLUG}-pr-lessons/state.json ]; then
cat > ~/.claude/${SLUG}-pr-lessons/state.json << EOF
{
  "repo": "${REPO}",
  "version": 1,
  "processed_prs": [],
  "skipped_prs": [],
  "total_processed": 0,
  "total_skipped": 0,
  "distillation_count": 0,
  "last_batch_at": null,
  "last_distillation_at": null,
  "cursor": 1,
  "notes": "State file for ${REPO} PR lessons."
}
EOF
fi

if [ ! -f ~/.claude/${SLUG}-pr-lessons/learnings-raw.md ]; then
cat > ~/.claude/${SLUG}-pr-lessons/learnings-raw.md << EOF
# Raw PR Learnings

Accumulated observations from analyzing closed PRs in ${REPO}.
Each batch appends a section below. When this file exceeds 200 lines, distillation is triggered.

---

EOF
fi
```

### Step 2: Load state

```bash
cat ~/.claude/${SLUG}-pr-lessons/state.json
```

### Step 3: Fetch next batch of closed PRs

```bash
CURSOR=$(jq '.cursor // 1' ~/.claude/${SLUG}-pr-lessons/state.json)

gh api "repos/${REPO}/pulls?state=closed&sort=updated&direction=desc&per_page=20&page=${CURSOR}" \
  --jq '.[] | {number, title, merged_at, closed_at, user: .user.login, additions, deletions, changed_files, body: (.body[:200])}'
```

### Step 4: Filter and select batch

From the fetched PRs:
1. Remove any PR whose number is in `processed_prs` or `skipped_prs`
2. Skip bot PRs (dependabot, renovate, github-actions, and repo-specific bots) — add to `skipped_prs`
3. Skip PRs with zero discussion and zero code changes — add to `skipped_prs`
4. Skip release PRs (title matches `release`, `bump version`, `chore(release)`) — add to `skipped_prs`
5. Select the first 5 remaining PRs as the batch
6. Prefer a mix of merged and closed-without-merge PRs

### Step 5: Output batch manifest

Return a list of PR numbers and titles for the critic phase to process.

### Step 6: Preflight batch validation

Before the critic phase starts, validate the exact selected IDs against state again:

```bash
SLUG="{{repoSlug}}"
SELECTED='[123,124,125,126,127]'

jq --argjson selected "${SELECTED}" '
  {
    processed_hits: [ $selected[] as $id | select(.processed_prs | index($id)) | $id ],
    skipped_hits: [ $selected[] as $id | select(.skipped_prs | index($id)) | $id ]
  }
' ~/.claude/${SLUG}-pr-lessons/state.json
```

Correct pattern:
1. Print the final batch manifest
2. Confirm `processed_hits` and `skipped_hits` are both empty
3. Only then hand the batch to `oss-pr-critic`

If any selected PR appears in `processed_prs` or `skipped_prs`, stop and re-filter before analysis.

## Skip Criteria

Add to `skipped_prs` (never revisit):
- Bot-authored PRs (dependabot, github-actions, renovate, and repo-specific bots)
- PRs opened and closed within 1 minute (accidental)
- Draft PRs never marked ready
- PRs with 0 files changed
- Release/version-bump PRs
- Dependency-only PRs (`chore(deps):`)

## Cursor Strategy

- `cursor` in state.json is the GitHub API page number (starts at 1)
- After processing a page, increment cursor if all PRs on that page were already processed or skipped
- If the batch was filled from the current page, keep the cursor the same
- If cursor reaches a page with 0 results, reset to 1 (wrap around for newly closed PRs)
