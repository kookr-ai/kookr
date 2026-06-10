---
name: oss-pr-critic
description: Analyze a PR from any repository and extract quality signals — description, reviews, scope, tests, CI, guidelines, outcome
keywords: oss, pr, critic, review, analysis, signals, quality, open source, contribution
related: [oss-pr-plan, oss-pr-state, oss-pr-threshold, oss-pr-distill]
---

# OSS PR Critic

Deep-read a PR from any repository and extract structured quality signals. Generalized version of `codex-pr-critic`.

## Output Destination

This skill's findings are **appended to `~/.claude/{repoSlug}-pr-lessons/learnings-raw.md`** by the state step that
follows it in the pipeline. The critic itself returns structured observations;
it does not write files. State the destination in your summary so the pipeline
stays auditable.

## When to Use

Invoked for each PR in the batch selected by `oss-pr-plan`.

## Non-Negotiable Rules

| # | Rule | Violation Example | Correct Pattern |
|---|------|-------------------|-----------------|
| 1 | Read the full PR body, not just title | Scoring based on title alone | `gh pr view -R {repo} {number} --json body,title,reviews,comments` |
| 2 | Read ALL review comments | Only reading the first review | Fetch reviews AND review comments (inline) |
| 3 | Distinguish review types | Treating all comments as equal | Separate: approval, changes_requested, comment-only, inline nit |
| 4 | Note the outcome | Ignoring whether PR was merged or abandoned | merged_at != null means merged; otherwise rejected/abandoned |
| 5 | Don't editorialize prematurely | Writing "this is a bad PR" | Record signals objectively; patterns emerge during distillation |
| 6 | Load recon report for repo conventions | Judging without knowing repo rules | `cat ~/.claude/{repoSlug}-recon/recon-report.md` if it exists |

## Parameters

- **repoFullName**: `owner/repo`
- **repoSlug**: URL-safe slug

## Data Collection Per PR

```bash
REPO="{{repoFullName}}"

# PR metadata
gh pr view -R ${REPO} {number} --json number,title,body,state,mergedAt,closedAt,author,additions,deletions,changedFiles,labels,createdAt,baseRefName,headRefName

# Reviews (approval/rejection decisions)
gh api "repos/${REPO}/pulls/{number}/reviews" --jq '.[] | {user: .user.login, state: .state, body: (.body[:300])}'

# Review comments (inline code comments)
gh api "repos/${REPO}/pulls/{number}/comments?per_page=100" --jq '.[] | {user: .user.login, body: (.body[:300]), path: .path, created_at: .created_at}'

# PR comments (general discussion)
gh api "repos/${REPO}/issues/{number}/comments?per_page=50" --jq '.[] | {user: .user.login, body: (.body[:300]), created_at: .created_at}'
```

## Signal Extraction Framework

### 1. Description Quality
- Does it follow the repo's PR template (from recon report)?
- Does it reference an issue?
- Is the motivation clear?
- Are implementation choices explained?

### 2. Review Dynamics
- How many review rounds before merge/close?
- Were changes requested? How many times?
- Feedback categories: **Blocking**, **Suggestion**, **Nit**, **Question**, **Praise**
- Did the author respond constructively?

### 3. Scope & Size
- Lines added/deleted, files changed
- Focused (single concern) or sprawling?
- Smaller, focused PRs (<300 lines) typically get reviewed faster

### 4. Test Coverage
- Tests included?
- Edge cases or just happy path?
- Tests mentioned in PR description?

### 5. Commit Discipline
- Atomic commits or single squash?
- Conventional commit messages?
- Does each commit compile?

### 6. CI Compliance
- CI pass on first push?
- Lint/format issues?

### 7. Contribution Guidelines Adherence
- CLA signed (if required per recon)?
- Issue linked (if required)?
- PR template filled out?
- Respects stated priorities?

### 8. Outcome Classification

| Outcome | Meaning | Learning Value |
|---------|---------|----------------|
| **Merged quickly** (<3 days, <2 rounds) | Well-executed | What "good" looks like |
| **Merged after discussion** (>3 days or >2 rounds) | Complex but accepted | How to navigate feedback |
| **Closed by author** | Author gave up | What discourages contributors |
| **Closed by maintainer** | Didn't meet standards | What maintainers reject |
| **Stale-closed** | Auto-closed | Process friction signals |

## Output Format

```markdown
### PR #{number}: {title}
- **Author**: {login} | **Outcome**: {merged/closed/stale} | **Duration**: {days}
- **Size**: +{additions}/-{deletions} across {files} files
- **Reviews**: {count} rounds, {approved/changes_requested/comment}
- **Description**: {good/adequate/poor/missing} — {specific note}
- **Tests**: {included/missing/partial} — {specific note}
- **Issue link**: {yes/no} — {issue number if yes}
- **CI**: {passed-first/failed-then-fixed/never-passed}
- **Guidelines adherence**: {good/partial/poor} — {specific note}
- **Key signals**:
  - {signal 1}
  - {signal 2}
- **Lesson**: {one-sentence takeaway}
```

## Deeper Analysis for Rejections

Rejected PRs (closed by maintainer, closed by author, stale-closed) contain the most lessons. They deserve **disproportionately more investigation** than merged PRs. For every non-merged PR, add these steps beyond the standard 8 dimensions:

1. **Fetch competing/superseding PRs.** If the close reason references another PR, fetch its metadata. Compare scope, description quality, and changeset size side by side. The contrast is the lesson.
2. **Trace the full comment timeline.** Quote each step: reviewer closes → author responds → community weighs in. The escalation arc (or graceful acceptance) is itself a signal.
3. **Extract technical rebuttals.** If community members debunked the PR's claims, include the specific technical reasoning (not just "community disagreed").
4. **Include CI failure details.** Don't write "CI failed twice" — include the actual error messages from rust-log-analyzer or equivalent bots. The error type (syntax error vs. test failure vs. infra flake) matters.
5. **Diagnose the root failure mode.** Was it scope (too big), overlap (duplicate work), quality (untested), framing (oversold), or fit (wrong repo/area)? Name it explicitly.

## Edge Cases

- **Very large PRs** (>1000 lines): Focus on review dynamics, not code details
- **Bot PRs**: Should have been filtered by plan phase; skip if encountered
- **Maintainer PRs**: Note different review expectations (often self-merged or 1 approval)
- **First-time contributors**: Note extra guidance/friction signals
- **Reverted PRs**: High-value signal — what went wrong post-merge?
