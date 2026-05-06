---
name: Codex CLI Bug Fix
description: Pick the highest-priority triaged bug, reproduce it, implement and test the fix, then mark the triage issue as ready for human review
cwd: $HOME/git/codex
checklist:
  - Selected highest-priority open triage issue without "ready" or "in-progress" label
  - Read upstream issue and triage issue thoroughly
  - Created or switched to fix branch from latest main
  - Reproduced the bug locally and documented reproduction
  - Implemented the fix
  - Added or updated tests covering the bug
  - Verified all existing tests still pass
  - Commented on triage issue with fix summary and reproduction result
  - Added "ready" label to triage issue
  - Added "in-progress" label removed (if was set)
---

## Objective

Take the top-ranked bug from the triage backlog, reproduce it, fix it, verify the fix with tests, and mark it ready for human review. Do NOT create a PR — that is a separate workflow.

## Context

- **Fork**: `jeanibarz/codex` (forked from `openai/codex`)
- **Triage issues**: Labeled `bug-triage`, ranked by priority score in title `[P{score}]`
- **Labels used by this playbook**: `in-progress`, `ready`
- **Branch naming**: `fix/{upstream-issue-number}-{short-slug}`

## Phase 1: Select a bug

1. List open triage issues sorted by priority, excluding ones already in progress or ready:

   ```bash
   gh issue list -R jeanibarz/codex --label "bug-triage" --state open --json number,title,labels \
     --jq '[.[] | select(.labels | map(.name) | (contains(["ready"]) or contains(["in-progress"])) | not)] | sort_by(.title) | reverse | .[0]'
   ```

2. If no eligible issues exist, report "No triaged bugs available" and stop.

3. Read the full triage issue:
   ```bash
   gh issue view -R jeanibarz/codex {number} --json body,title,labels,comments
   ```

4. Extract the upstream issue number from the title and read the upstream issue:
   ```bash
   gh issue view -R openai/codex {upstream_number} --json body,comments,labels
   ```

5. Add `in-progress` label to the triage issue:
   ```bash
   gh api repos/jeanibarz/codex/issues/{number}/labels -X POST --input - <<'EOF'
   {"labels":["in-progress"]}
   EOF
   ```

## Phase 2: Reproduce

1. Ensure fork is up to date:
   ```bash
   git fetch upstream
   git checkout main
   git merge upstream/main --ff-only
   ```

2. Create a fix branch:
   ```bash
   git checkout -b fix/{upstream_number}-{short-slug}
   ```

3. Follow the reproduction plan from the triage issue. Document exact steps and output.

4. If reproduction fails:
   - Comment on the triage issue explaining what was tried
   - Lower the reproducibility score if appropriate
   - Remove `in-progress` label
   - Stop — do not attempt a fix for a bug that cannot be reproduced

## Phase 3: Fix

1. Identify the root cause based on reproduction and the triage issue's "Potential Root Cause" section.

2. Implement the minimal fix. Principles:
   - **Smallest possible change** — don't refactor surrounding code
   - **Match existing code style** — follow patterns in the file you're editing
   - **No unrelated changes** — don't fix formatting, add comments, or rename things
   - **Respect upstream conventions** — check CONTRIBUTING.md, existing tests, linting config

3. Add or update tests:
   - Write a test that **fails without the fix** and **passes with it**
   - Place the test in the same file/directory pattern as existing tests
   - Use the project's test framework and assertion style

4. Run the full test suite:
   ```bash
   # Adapt to the project's actual test command
   cargo test  # or npm test, etc.
   ```

5. Run linting/formatting if the project has it:
   ```bash
   cargo clippy  # or npm run lint, etc.
   cargo fmt --check
   ```

## Phase 4: Mark ready

1. Commit the fix with a clear message:
   ```
   fix: {description}

   Fixes openai/codex#{upstream_number}

   {One-paragraph explanation of root cause and fix}
   ```

2. Push the branch:
   ```bash
   git push origin fix/{upstream_number}-{short-slug}
   ```

3. Comment on the triage issue with the fix summary:
   ```bash
   gh api repos/jeanibarz/codex/issues/{number}/comments -X POST -f body="$(cat <<'EOF'
   ## Fix implemented ({date})

   **Branch**: `fix/{upstream_number}-{short-slug}`
   **Commit**: {short_sha}

   ### Reproduction result
   {What happened when reproducing — exact error, behavior observed}

   ### Root cause
   {What was actually wrong}

   ### Fix summary
   {What was changed and why}

   ### Tests
   {What tests were added/modified}

   Ready for human review before PR creation.
   EOF
   )"
   ```

4. Add `ready` label and remove `in-progress`:
   ```bash
   gh api repos/jeanibarz/codex/issues/{number}/labels -X PUT --input - <<'EOF'
   {"labels":["bug-triage","ready"]}
   EOF
   ```

## Idempotency Rules

1. **One bug per run.** Pick the single highest-priority issue and work it to completion or failure.
2. **Don't re-fix ready issues.** Skip issues that already have the `ready` label.
3. **Don't re-fix issues with linked branches.** If a `fix/` branch already exists for the upstream number, skip unless the branch is stale (no commits in 7+ days).
4. **Clean up on failure.** If reproduction fails or the fix doesn't work, remove `in-progress`, comment explaining why, and leave the issue for the next run.
5. **Don't modify triage scores.** Only the triage playbook adjusts confidence/reproducibility scores (except lowering repro on failed reproduction).

## Anti-Patterns

- Don't pick a bug you can't reproduce — reproduction is a hard gate
- Don't bundle multiple bug fixes in one branch — one branch per bug
- Don't add features or improvements alongside the fix
- Don't skip tests — every fix needs a regression test
- Don't create a PR — that's a separate playbook
- Don't force-push or rewrite history on fix branches
