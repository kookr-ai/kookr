---
name: pr-review-triage
description: Triage, fix, and resolve PR review comments end-to-end — fetch comments, assess relevance, implement fixes, push, and resolve GitHub threads. Used by post-push when feedback arrives.
keywords: PR review, code review, codex, review comments, resolve thread, github, pull request, triage, review findings, fix review, address feedback
related: git-commit-discipline, post-push, pr-lifecycle
---

# PR Review Triage

End-to-end workflow for handling PR review comments. Covers fetching, analyzing, fixing, and closing out review threads.

## Workflow

### 1. Fetch all review comments

```bash
# REST: inline code comments
gh api repos/{owner}/{repo}/pulls/{number}/comments

# REST: top-level issue comments + review bodies
gh pr view {number} --json comments,reviews
```

### 2. Triage each comment

For each comment, assess:

| Question | Action |
|----------|--------|
| Is the finding technically correct? | Verify by reading the referenced code |
| Does it affect correctness, reliability, or analytics? | If yes → fix it |
| Is it a style/preference nit with no functional impact? | Skip or note as won't-fix |
| Is it already addressed by existing code? | Reply explaining why, then resolve |

Classify as: **Relevant (fix)**, **Already addressed**, or **Not applicable**.

### 3. Implement fixes

- Read the affected code before changing it
- One commit per logically distinct fix (atomic commits)
- Run tests + type-check before pushing

### 4. Push and resolve threads

After pushing the fix commit, **immediately resolve the corresponding GitHub review thread**:

```bash
# Step 1: Find the thread ID
gh api graphql -f query='
{
  repository(owner: "OWNER", name: "REPO") {
    pullRequest(number: NUMBER) {
      reviewThreads(first: 50) {
        nodes {
          id
          isResolved
          comments(first: 1) {
            nodes { body }
          }
        }
      }
    }
  }
}'

# Step 2: Resolve the thread
gh api graphql -f query='
mutation {
  resolveReviewThread(input: { threadId: "THREAD_ID" }) {
    thread { isResolved }
  }
}'
```

**Do not wait to be asked** — resolving threads is part of completing the fix.

### 5. Verify CI

After pushing, monitor CI checks until they pass:

```bash
gh pr checks {number}
```

## Checklist

- [ ] All review comments fetched and triaged
- [ ] Relevant findings implemented and tested
- [ ] Each fix pushed as an atomic commit
- [ ] All addressed review threads resolved via GraphQL
- [ ] CI green
