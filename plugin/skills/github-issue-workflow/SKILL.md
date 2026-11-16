---
name: github-issue-workflow
group: oss-contribution
description: Standard workflow for creating GitHub issues with assignment and worktree branch creation for immediate implementation. Includes branch strategy and worktree conventions.
keywords: issue, github, workflow, worktree, branch, assign, implementation, create issue, new issue, bug report, feature request, staging
related: git-commit-discipline, pre-push, post-push, pr-lifecycle
---

# GitHub Issue Workflow

End-to-end workflow for creating a GitHub issue and immediately setting up for implementation.

## Workflow

### 1. Create the issue

**Before any `gh issue create`** (issue #1607 — drain-coupled emission budget + mandatory dedupe):

```bash
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
# 1) Budget: when open backlog ≥ 60, new filings per run collapse to 2.
#    Plus a drain-rate cap (#1657): a low-drain target repo can refuse or
#    tighten the budget even under 60, so read allowedBudget — never assume
#    "under 60 ⇒ file freely."
#    Fail closed — do not file if plan fails or allowedBudget is 0.
PLAN=$(kookr emission plan --repo "$REPO" --requested 1 --json) || {
  echo "emission plan failed; do not file"; exit 1; }
ALLOWED=$(printf '%s' "$PLAN" | jq -r '.plan.allowedBudget')
if [ "${ALLOWED:-0}" -lt 1 ]; then
  kookr emission defer --repo "$REPO" --title "Short descriptive title" \
    --source github-issue-workflow --reason "over emission budget"
  echo "budget refused filing"; exit 0
fi
# 2) Mandatory logged dedupe. --json → one JSON on stdout; audit line on stderr.
DEDUPE=$(kookr emission dedupe --repo "$REPO" --title "Short descriptive title" --json 2>/tmp/kookr-dedupe.log) \
  || { echo "dedupe failed; do not file"; exit 1; }
cat /tmp/kookr-dedupe.log 2>/dev/null || true
if [ "$(printf '%s' "$DEDUPE" | jq -r '.isDuplicate')" = "true" ]; then
  echo "duplicate of $(printf '%s' "$DEDUPE" | jq -r '.match.url') — update it, do not create a twin"
  exit 0
fi
# 3) Observability for daily reflection (netBacklogDelta7d = opened7d − closed7d).
#    Stable path: ~/.kookr/playbook-state/emission-metrics/<repoSlug>.json
mkdir -p "$HOME/.kookr/playbook-state/emission-metrics"
kookr emission metrics --repo "$REPO" --json \
  | tee "$HOME/.kookr/playbook-state/emission-metrics/$(printf '%s' "$REPO" | tr '/.' '--').json" \
  || true
```

Use `gh issue create` with a structured body only when the budget allows and dedupe is OK:

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
5. Open the PR against the base the [Branch Strategy](#branch-strategy) section gives, then run [[post-push]]

### 5. Create the PR

Pick the base from the [Branch Strategy](#branch-strategy) section first. In a
repository whose `.kookr/delivery-gate.json` names an `integrationBranch`,
leave `--base` out: the PR targets `main`. Otherwise add
`--base staging` for a feature or fix.

```bash
gh pr create --title "feat: short description" --body "$(cat <<'EOF'
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

Check whether the repository routes merges through an integration branch:

```bash
git show origin/main:.kookr/delivery-gate.json 2>/dev/null | jq -r '.integrationBranch // empty' 2>/dev/null
```

**It prints a branch name (for example `staging`):** cut the worktree from
`origin/main` and open every PR against `main`; do not pass `--base` with the
integration branch.
The merge wrapper (`kookr merge`) retargets the PR to the integration branch
and squash-merges it there; the repository's integration train then runs the
full suite on that branch and promotes it to `main`. There is no manual
"Staging → Main" PR; never open one. "Merged" means merged into the
integration branch, and the linked issue closes when the train promotes the
change to `main`.

**It prints nothing (no such file, or no `integrationBranch`):**

| Change type | Target branch | Example |
|-------------|---------------|---------|
| Feature / fix | `staging` | `gh pr create --base staging` |
| Hotfix (production broken) | `main` | Direct to main, then backport to staging |
| Docs-only | `main` | No staging needed for docs |

In such a repository nothing promotes `staging` for you: after a staging PR is
merged and validated, open a "Staging → Main" PR yourself.

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
- [ ] PR created against the base from Branch Strategy, referencing the issue
- [ ] [[post-push]] run after PR creation
