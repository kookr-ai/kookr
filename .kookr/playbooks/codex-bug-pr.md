---
name: Codex CLI Bug PR
description: Find ready-labeled triage issues without linked PRs, create upstream PRs on openai/codex for human-reviewed fixes
cwd: /home/jean/git/codex
checklist:
  - Listed all triage issues with "ready" label
  - Filtered out issues that already have a linked PR
  - For each eligible issue, verified fix branch exists and is clean
  - For each eligible issue, rebased fix branch on latest upstream main
  - For each eligible issue, verified tests pass after rebase
  - Created upstream PR on openai/codex for each eligible fix
  - Commented on triage issue with PR link
  - Replaced "ready" label with "pr-submitted" on each issue
  - Final summary reported (PRs created, issues skipped and why)
---

## Objective

Find triage issues marked `ready` (fix implemented and human-reviewed) that don't yet have a PR, and create upstream pull requests on `openai/codex`. This is the final step that ships fixes to the public repository.

## Context

- **Fork**: `jeanibarz/codex` (forked from `openai/codex`)
- **Triage issues**: Labeled `bug-triage` + `ready` = fix done, reviewed, no PR yet
- **Labels used by this playbook**: `ready` (consumed), `pr-submitted` (produced)
- **Branch naming**: `fix/{upstream-issue-number}-{short-slug}` (created by bug-fix playbook)

## Phase 1: Find eligible issues

1. List ready issues:
   ```bash
   gh issue list -R jeanibarz/codex --label "bug-triage,ready" --state open --json number,title,body,comments
   ```

2. For each issue, check if a PR already exists:
   ```bash
   # Search for PRs from our fork referencing the upstream issue
   gh pr list -R openai/codex --author jeanibarz --state open --json number,title,headRefName
   gh pr list -R openai/codex --author jeanibarz --state merged --json number,title,headRefName
   ```

3. Filter out issues that already have a linked PR (check both PR list and issue comments for PR URLs).

4. If no eligible issues remain, report "No ready issues without PRs" and stop.

## Phase 2: Prepare each fix for PR

For each eligible issue:

1. Extract the upstream issue number and fix branch name from the triage issue.

2. Verify the fix branch exists locally:
   ```bash
   git branch --list "fix/{upstream_number}-*"
   ```

3. Switch to the branch and rebase on latest upstream:
   ```bash
   git checkout fix/{upstream_number}-{slug}
   git fetch upstream
   git rebase upstream/main
   ```

4. If rebase has conflicts:
   - Resolve if trivial (context shifts only)
   - If non-trivial, comment on the triage issue explaining the conflict, skip this issue
   - ```bash
     git rebase --abort  # if skipping
     ```

5. Run the test suite to verify the fix still works after rebase:
   ```bash
   cargo test  # or npm test, etc.
   ```

6. If tests fail after rebase, comment on the triage issue and skip.

7. Force-push the rebased branch (this is expected for rebase):
   ```bash
   git push origin fix/{upstream_number}-{slug} --force-with-lease
   ```

## Phase 3: Create upstream PR

For each eligible fix that passed Phase 2:

1. Read the triage issue's fix comment (from bug-fix playbook) to get the fix summary.

2. Check upstream `CONTRIBUTING.md` for PR conventions:
   ```bash
   gh api repos/openai/codex/contents/CONTRIBUTING.md --jq '.content' | base64 -d
   ```

3. Create the PR on the upstream repo:
   ```bash
   gh pr create -R openai/codex \
     --head "jeanibarz:fix/{upstream_number}-{slug}" \
     --base main \
     --title "fix: {description}" \
     --body "$(cat <<'EOF'
   ## Summary

   {One-paragraph description of the bug and fix}

   Fixes #{upstream_number}

   ## Root Cause

   {What was wrong}

   ## Fix

   {What was changed and why}

   ## Testing

   {What tests were added/modified, how to verify}
   EOF
   )"
   ```

4. Comment on the triage issue with the PR link:
   ```bash
   gh api repos/jeanibarz/codex/issues/{triage_number}/comments -X POST \
     -f body="PR submitted: openai/codex#{pr_number} ({date})"
   ```

5. Replace `ready` with `pr-submitted`:
   ```bash
   gh api repos/jeanibarz/codex/issues/{triage_number}/labels -X PUT --input - <<'EOF'
   {"labels":["bug-triage","pr-submitted"]}
   EOF
   ```

## Phase 3b: Handle closed/merged PRs

Also check for previously submitted PRs that have been merged or closed:

```bash
gh pr list -R openai/codex --author jeanibarz --state merged --json number,title
gh pr list -R openai/codex --author jeanibarz --state closed --json number,title,closedAt
```

- If PR was **merged**: close the triage issue with a comment noting the merge.
- If PR was **closed without merge**: comment on the triage issue noting rejection, remove `pr-submitted` label, add `needs-review` label for human attention.

## Idempotency Rules

1. **Don't create duplicate PRs.** Before creating, verify no open or merged PR exists from `jeanibarz` for this branch.
2. **Don't re-submit rejected PRs.** If a PR was closed without merge, flag for human attention instead of re-creating.
3. **Process all eligible issues in one run.** Unlike the fix playbook (one bug per run), this playbook handles all ready issues.
4. **Rebase, don't merge.** Always rebase on upstream/main for clean history.
5. **Date-stamp all comments.**

## Anti-Patterns

- Don't create a PR for an issue that hasn't been human-reviewed (must have `ready` label)
- Don't create a PR if tests fail after rebase — flag it instead
- Don't modify the fix code during PR creation — if changes are needed, go back to the fix playbook
- Don't create PRs for issues the upstream has already fixed — check upstream status first
- Don't squash commits at PR creation time — let upstream maintainers decide squash policy
