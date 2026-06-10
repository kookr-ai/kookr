---
name: github-issue-workflow
description: Standard workflow for creating GitHub issues with assignment and worktree branch creation for immediate implementation. Includes branch strategy and worktree conventions.
keywords: issue, github, workflow, worktree, branch, assign, implementation, create issue, new issue, bug report, feature request, staging
related: git-commit-discipline, pre-push, post-push, pr-lifecycle
---

# GitHub Issue Workflow

End-to-end workflow for creating a GitHub issue and immediately setting up for implementation.

## Workflow

### 1. Create the issue

Use `gh issue create` with a structured body:

```bash
gh issue create --title "Short descriptive title" --body "$(cat <<'EOF'
## Summary
Brief description of the feature/bug.

## Implementation Plan
### Phase A: Design (ADR if needed)
### Phase B: Implementation
### Phase C: Testing & PR

## Acceptance Criteria
- [ ] Criterion 1
- [ ] Criterion 2

## Labels
enhancement, area: core, ...
EOF
)" --label "enhancement" --label "area: core"
```

### 2. Assign the issue

Always assign to the project owner immediately:

```bash
gh issue edit {number} --add-assignee "$(gh api user --jq .login)"
```

### 3. Create a worktree branch

Use `EnterWorktree` with a descriptive name matching the feature:

```
EnterWorktree(name: "feat-short-description")
```

**Name rules:** letters, digits, dots, underscores, dashes only. No `+` or `/`.

### 4. Implement

Follow the issue's implementation plan:
1. Write ADR if `needs adr` label is present
2. Implement the feature
3. Write tests
4. Run [[pre-push]]
5. Create PR into `staging`, then run [[post-push]]

### 5. Create PR into staging

```bash
gh pr create --base staging --title "feat: short description" --body "$(cat <<'EOF'
## Summary
- What was done

## Test plan
- [ ] Tests pass
- [ ] Manual verification

Closes #N

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

### 6. Update a PR description

**`gh pr edit` is broken** (GitHub Projects Classic deprecation GraphQL error). Use the REST API instead:

```bash
gh api repos/{owner}/{repo}/pulls/{number} -X PATCH -f body="new body here"
```

For title changes:

```bash
gh api repos/{owner}/{repo}/pulls/{number} -X PATCH -f title="new title"
```

## Branch Strategy

| Change type | Target branch | Example |
|-------------|---------------|---------|
| Feature / fix | `staging` | `gh pr create --base staging` |
| Hotfix (production broken) | `main` | Direct to main, then backport to staging |
| Docs-only | `main` | No staging needed for docs |

After a staging PR is merged and validated, create a "Staging → Main" merge PR (see [[pr-lifecycle]]).

## Worktree Conventions

**Naming:** Use descriptive names with letters, digits, dots, underscores, dashes only. No `+` or `/`.

| Pattern | When to use | Example |
|---------|-------------|---------|
| `feat-{description}` | New features | `feat-token-tracking` |
| `fix-issue-{N}-{description}` | Issue-linked fixes | `fix-issue-31-broaden-scanner` |
| `fix-{description}` | Fixes without issues | `fix-toast-overlap` |

**Optimization:** Don't re-read files after entering a worktree. Worktrees clone HEAD — files read before `EnterWorktree` are identical in the worktree. Use content already in context.

**Cleanup:** Worktrees are cleaned up automatically if the agent makes no changes. If changes are made, the worktree path and branch are returned in the result.

## Checklist

- [ ] Issue created with structured body and labels
- [ ] Issue assigned to you (the authenticated `gh` user)
- [ ] Worktree branch created (following naming conventions)
- [ ] Implementation follows the plan
- [ ] Tests written and passing
- [ ] [[pre-push]] run before push / PR creation
- [ ] PR created into staging, referencing the issue
- [ ] [[post-push]] run after PR creation
