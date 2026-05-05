---
name: reviewer-distillation-prepare
description: Prepare isolated context files and fetch ground-truth reviews for selected PRs
keywords: [reviewer, distillation, prepare, context, isolation]
related: [reviewer-distillation-select, reviewer-distillation-predict]
---

# PREPARE Phase — Context File Assembly

## When to Use

Called by the orchestrator after SELECT. Prepares two files per PR:
1. **Context file** (for the REVIEWER) — diff, title, description, conventions
2. **Reviews file** (for the JUDGE only) — real human review comments

## Parameters

- `repo`: GitHub owner/repo
- `stateDir`: Path to state directory
- `prNumbers`: Array of PR numbers from SELECT

## For Each PR

### 1. Fetch Diff

```bash
gh api repos/{owner}/{repo}/pulls/{N} -H "Accept: application/vnd.github.v3.diff" \
  > {stateDir}/context/pr-{N}-raw.diff
```

Skip the PR if diff exceeds 120K characters. Record in `state.json.skipped_prs`.

### 2. Fetch Metadata

```bash
gh api repos/{owner}/{repo}/pulls/{N} \
  --jq '{title: .title, body: .body, additions: .additions, deletions: .deletions}'
```

### 3. Fetch File List

```bash
gh api repos/{owner}/{repo}/pulls/{N}/files \
  --jq '.[] | "\(.filename) +\(.additions)/-\(.deletions)"'
```

### 4. Write Context File

Write to `{stateDir}/context/pr-{N}.md`:

```markdown
# Code Review Task

## Repository: {owner}/{repo}
## PR Title: {title}
## PR Description
{body}

## Changed Files
{file list with +/- counts}

## Diff
```diff
{full unified diff}
```

## Repository Conventions
{CONTRIBUTING.md summary if available}
{Known linter/formatter config names}
{Test expectations from CI}
```

**Excluded from context file:** review comments, labels, reviewer names, timeline events, merge commit message, approval status.

### 5. Fetch Real Reviews (for Judge only)

```bash
gh api repos/{owner}/{repo}/pulls/{N}/comments \
  > {stateDir}/reviews/pr-{N}-raw.json
```

Format into `{stateDir}/reviews/pr-{N}.md`:

```markdown
# Real Human Review Comments for PR #{N}

## Comment 1 (by {username})
- **File**: {path}:{line}
- **Body**: {comment body}
```

## Information Isolation

The REVIEWER agent reads ONLY `context/pr-{N}.md` and `mutations/vK.md`.
The `reviews/` directory is NEVER accessible to the reviewer.
The orchestrator enforces this by controlling which files each subagent prompt references.
