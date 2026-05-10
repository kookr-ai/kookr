---
name: kookr-pr-lifecycle
description: Full PR lifecycle — creation, checklist tracking, CI monitoring, review resolution, body updates, and post-merge cleanup. Use together with post-push to finish PR follow-through.
keywords: PR, pull request, create PR, checklist, CI, review, merge, resolve thread, pr body, pr description, test plan, github
related: github-issue-workflow, post-push, pr-review-triage, git-commit-discipline
---

# PR Lifecycle

End-to-end workflow for managing a pull request from creation through merge. Consolidates all known patterns and workarounds.

## 1. Pre-Creation Checks

Before creating a PR, run these checks (see also [[pre-pr-review]] and [[pre-push]]):

```bash
pnpm build:server # must be clean
pnpm check:e2e   # must be clean
pnpm test         # must be green
git diff --stat   # review — no accidental files, no secrets
```

## 2. Create the PR

Target `staging` for feature/fix PRs. Target `main` only for hotfixes or docs-only changes.

```bash
gh pr create --base staging --title "feat: short description" --body "$(cat <<'EOF'
## Summary
- What was done

## Test plan
- [ ] `pnpm test` passes
- [ ] `pnpm build:server` clean
- [ ] `pnpm check:e2e` clean
- [ ] Manual verification (describe what to check)

Closes #N

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

## 3. Checklist Management

**Check off items immediately after completing them.** Do not wait to be asked.

After each validation step (tests pass, typecheck clean, manual verification done), update the PR body right away:

```bash
# IMPORTANT: gh pr edit is BROKEN (Projects Classic deprecation error).
# Always use the REST API:
gh api repos/{owner}/{repo}/pulls/{number} -X PATCH -f body="updated body with [x] items"
```

For title changes:
```bash
gh api repos/{owner}/{repo}/pulls/{number} -X PATCH -f title="new title"
```

## 4. Post-Creation Verification

After `gh pr create`, scan the body for unchecked `[ ]` items. For each:

| Item type | Action |
|-----------|--------|
| Tests pass | Run `pnpm test` and check off |
| Server type-check | Run `pnpm build:server` and check off |
| E2E type-check | Run `pnpm check:e2e` and check off |
| Manual UI verification | Use Playwright to verify, then check off |
| Requires human judgment | Flag explicitly to the user |

Do not declare the task done while unchecked items remain.

## 5. CI Monitoring

After pushing, check CI status:

```bash
gh pr checks {number}
```

If checks fail, investigate and fix before moving on.

## 6. Review Thread Resolution

When fixing issues raised in PR review comments, **resolve the thread immediately after pushing the fix**:

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

Do not wait to be asked — resolving threads is part of completing the fix.

## 7. Staging → Main Merge

After a staging PR is merged and validated, create a merge PR to main:

```bash
git checkout staging && git pull
gh pr create --base main --title "Staging" --body "$(cat <<'EOF'
## Summary
- Merge staging changes into main

## Changes included
- List the PRs/features included

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

## Common Mistakes to Avoid

- **Never use `gh pr edit --body` or `gh pr edit --title`** — it fails with a GraphQL Projects Classic deprecation error
- **Never leave checklist items unchecked** after they've been validated
- **Never skip thread resolution** after pushing a review fix
- **Never create a PR without running the repo checks first**

## See Also

- [[github-issue-workflow]] — Issue creation and branch setup (upstream of this skill)
- [[post-push]] — Repo follow-through after push / PR creation
- [[pr-review-triage]] — Detailed review comment triage workflow
- [[pre-pr-review]] — Self-review checklist before PR creation
- [[git-commit-discipline]] — Commit message and hygiene patterns
