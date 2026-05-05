---
name: Implement GitHub Issue
description: Pick a GitHub issue, implement it in a worktree, and open a PR
parameters:
  - name: issueId
    description: "Issue number (leave empty for most recent open issue)"
    required: false
  - name: repo
    description: "GitHub repo (owner/name, leave empty for current repo)"
    required: false
  - name: assignee
    description: "GitHub username to assign the PR (leave empty for current user)"
    required: false
checklist:
  - Resolved target issue (specified or most recent open)
  - Read and understood the issue requirements
  - Created a git worktree with descriptive branch name
  - Implemented the solution following project conventions
  - All existing tests pass
  - New tests written for the changes
  - Type-check passes (if TypeScript project)
  - Created PR linking the issue with Closes #N
  - PR has a clear summary and test plan
---

## Objective

Implement a GitHub issue end-to-end: read the issue, create a worktree branch, write the code, verify with tests, and open a pull request.

## Phase 1: Resolve Target Issue

Determine which issue to implement:

{{issueId}} — if this is non-empty, use this issue number directly.

If empty, fetch the most recent open issue:

```bash
gh issue list --state open --limit 1 --json number,title -q '.[0]'
```

Store the resolved issue number for the rest of the workflow.

Then fetch full issue details:

```bash
gh issue view <NUMBER> --json number,title,body,labels,assignees
```

Read the issue title, body, labels, and any linked discussions to fully understand the requirements and acceptance criteria.

## Phase 2: Determine Target Repo and Branch Strategy

{{repo}} — if non-empty, use this as the target repo. Otherwise, detect from the current git remote.

Check if the repo uses a `staging` branch:

```bash
git branch -r | grep -q 'origin/staging' && echo "staging" || echo "main"
```

Use the result as the PR base branch.

## Phase 3: Create Worktree

Create a git worktree with a descriptive branch name derived from the issue. Use the `git worktree add` command:

```bash
git worktree add ../kookr-<branch-name> -b <branch-name>
```

Then `cd` into the new worktree directory and continue working from there.

Branch naming rules:
- Prefix: `feat-issue-` for features/enhancements, `fix-issue-` for bugs
- Include the issue number
- Add a 2-4 word slug from the issue title
- Use only letters, digits, dots, underscores, dashes (no `/` or `+`)

Example: Issue #42 "Add dark mode toggle" → branch `feat-issue-42-dark-mode-toggle`, worktree at `../kookr-feat-issue-42-dark-mode-toggle`

## Phase 4: Implement

1. **Read project conventions** — check for CLAUDE.md, CONTRIBUTING.md, existing code patterns
2. **Plan the implementation** — identify which files to create/modify
3. **Write the code** — follow existing project patterns, keep changes focused on the issue
4. **Don't over-engineer** — implement what the issue asks for, nothing more

## Phase 5: Verify

Run the project's standard verification commands:

1. **Type-check** (if TypeScript): `npx tsc --noEmit` or the project's type-check script
2. **Lint**: run the project's lint command if one exists
3. **Tests**: run the full test suite, or at minimum the tests related to changed files
4. **Build**: verify the project builds successfully

Fix any failures before proceeding.

## Phase 6: Create Pull Request

Create a PR targeting the appropriate base branch:

```bash
gh pr create --base <base-branch> --title "<type>: <short description>" --body "$(cat <<'EOF'
## Summary
- <1-3 bullet points describing what was done>

## Test plan
- [ ] Existing tests pass
- [ ] New tests cover the changes
- [ ] Manual verification (if applicable)

Closes #<NUMBER>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Title conventions:
- `feat:` for new features
- `fix:` for bug fixes
- `docs:` for documentation
- `refactor:` for refactoring
- `test:` for test-only changes

After creating the PR, determine the assignee and assign using the REST API (avoid `gh pr edit` which has known issues):

{{assignee}} — if non-empty, use this username. Otherwise, detect the current GitHub user:

```bash
ASSIGNEE="{{assignee}}"
if [ -z "$ASSIGNEE" ]; then
  ASSIGNEE=$(gh api user -q '.login')
fi
gh api repos/<owner>/<repo>/pulls/<PR_NUMBER> -X PATCH -f "assignees[]=$ASSIGNEE"
```

## Anti-Patterns

- **Don't start coding before understanding the issue** — read the full issue body and any linked context
- **Don't skip tests** — every PR needs verification
- **Don't bundle unrelated changes** — if you notice other issues while working, note them but don't fix them
- **Don't force-push or rewrite history** — clean commits from the start
- **Don't create the PR if tests fail** — fix first, PR second
- **Don't use `gh pr edit`** — it has known issues with GitHub Projects Classic deprecation; use `gh api` REST calls instead
