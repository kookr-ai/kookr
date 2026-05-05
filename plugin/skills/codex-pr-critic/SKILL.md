---
name: codex-pr-critic
description: Critic phase for codex-pr-lessons playbook — analyze a PR and extract quality signals
keywords: codex, pr, critic, review, analysis, signals, quality
related: [codex-pr-plan, codex-pr-state, codex-pr-threshold, codex-pr-distill]
---

## When to Use

This skill is invoked for each PR in the batch selected by `codex-pr-plan`. It deep-reads the PR and extracts structured quality signals.

## Non-Negotiable Rules

| # | Rule | Violation Example | Correct Pattern |
|---|------|-------------------|-----------------|
| 1 | Read the full PR body, not just title | Scoring based on title alone | `gh pr view -R openai/codex {number} --json body,title,reviews,comments` |
| 2 | Read ALL review comments | Only reading the first review | Fetch reviews AND review comments (inline) |
| 3 | Distinguish review types | Treating all comments as equal | Separate: approval, changes_requested, comment-only, inline nit |
| 4 | Note the outcome | Ignoring whether PR was merged or abandoned | merged_at != null means merged; otherwise rejected/abandoned |
| 5 | Don't editorialize prematurely | Writing "this is a bad PR" | Record signals objectively; patterns emerge during distillation |

## Data Collection Per PR

For each PR, collect these fields:

```bash
# PR metadata
gh pr view -R openai/codex {number} --json number,title,body,state,mergedAt,closedAt,author,additions,deletions,changedFiles,labels,createdAt,baseRefName,headRefName

# Reviews (approval/rejection decisions)
gh api "repos/openai/codex/pulls/{number}/reviews" --jq '.[] | {user: .user.login, state: .state, body: (.body[:300])}'

# Review comments (inline code comments)
gh api "repos/openai/codex/pulls/{number}/comments?per_page=100" --jq '.[] | {user: .user.login, body: (.body[:300]), path: .path, created_at: .created_at}'

# PR comments (general discussion)
gh api "repos/openai/codex/issues/{number}/comments?per_page=50" --jq '.[] | {user: .user.login, body: (.body[:300]), created_at: .created_at}'
```

## Signal Extraction Framework

For each PR, evaluate these dimensions and record observations:

### 1. Description Quality
- Does it follow the PR template (What? Why? How?)?
- Does it reference an issue?
- Is the motivation clear?
- Are implementation choices explained?
- **Signal**: Well-described PRs with issue links get merged faster and with fewer review rounds

### 2. Review Dynamics
- How many review rounds before merge/close?
- Were changes requested? How many times?
- What types of feedback? Categories:
  - **Blocking**: Design disagreements, missing tests, wrong approach
  - **Suggestion**: Better way to do something, style improvement
  - **Nit**: Formatting, naming, minor style
  - **Question**: Clarification needed, understanding the change
  - **Praise**: Positive feedback, good approach noted
- Did the author respond constructively to feedback?
- **Signal**: PRs that address feedback promptly and completely get merged; defensive responses correlate with abandonment

### 3. Scope & Size
- Lines added/deleted, files changed
- Is the change focused (single concern) or sprawling?
- **Signal**: Smaller, focused PRs (<300 lines) get reviewed faster; large PRs get more scrutiny and blocking feedback

### 4. Test Coverage
- Are tests included?
- Do tests cover edge cases or just happy path?
- Are tests mentioned in the PR description?
- **Signal**: PRs without tests for behavioral changes get changes_requested consistently

### 5. Commit Discipline
- Atomic commits or single squash?
- Conventional commit messages?
- Does each commit compile?
- **Signal**: The repo uses squash-and-merge, so individual commits matter less, but clean history shows care

### 6. CI Compliance
- Did CI pass on first push?
- Were there lint/format issues?
- **Signal**: CI failures on first push correlate with more review rounds

### 7. Contribution Guidelines Adherence
- CLA signed?
- Issue linked?
- PR template filled out?
- Focused on bugs/security (current priority)?
- **Signal**: PRs violating contribution guidelines get closed without review

### 8. Outcome Classification

| Outcome | Meaning | Learning Value |
|---------|---------|----------------|
| **Merged quickly** (<3 days, <2 review rounds) | Uncontroversial, well-executed | What "good" looks like |
| **Merged after discussion** (>3 days or >2 rounds) | Complex but ultimately accepted | How to navigate feedback |
| **Closed by author** | Author gave up or decided against | What discourages contributors |
| **Closed by maintainer** | Didn't meet standards or align with roadmap | What maintainers reject and why |
| **Stale-closed** | Auto-closed for inactivity | Process friction signals |

## Output Format

For each PR, produce a structured observation block:

```markdown
### PR #{number}: {title}
- **Author**: {login} | **Outcome**: {merged/closed/stale} | **Duration**: {days}
- **Size**: +{additions}/-{deletions} across {files} files
- **Reviews**: {count} rounds, {approved/changes_requested/comment}
- **Description**: {good/adequate/poor/missing} — {specific note}
- **Tests**: {included/missing/partial} — {specific note}
- **Issue link**: {yes/no} — {issue number if yes}
- **CI**: {passed-first/failed-then-fixed/never-passed}
- **Key signals**:
  - {signal 1}
  - {signal 2}
  - ...
- **Lesson**: {one-sentence takeaway from this PR}
```

## Handling Edge Cases

- **Very large PRs** (>1000 lines): Focus on review dynamics, not code details
- **Bot PRs** (dependabot): Should have been filtered by plan phase; skip if encountered
- **Maintainer PRs** (openai team members): Note different review expectations (often self-merged)
- **First-time contributors**: Note extra guidance/friction signals
- **Reverted PRs**: High-value signal — what went wrong post-merge?
