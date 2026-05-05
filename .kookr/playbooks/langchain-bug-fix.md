---
name: LangChain Bug Fix
description: Pick the highest-priority triaged bug, get assigned upstream, reproduce it, implement and test the fix, then mark the triage issue as ready for human review
cwd: /home/jean/git/langchain
checklist:
  - Selected highest-priority open triage issue without "ready" or "in-progress" label
  - Read upstream issue and triage issue thoroughly
  - Verified upstream issue is unassigned or we are assigned
  - Requested assignment on upstream issue if not already assigned
  - Created or switched to fix branch from latest master
  - Reproduced the bug locally and documented reproduction
  - Implemented the fix (single package only)
  - Added or updated pytest unit tests covering the bug
  - Ran make format, make lint, make test in affected package
  - Verified type hints and docstrings are complete
  - Commented on triage issue with fix summary and reproduction result
  - Added "ready" label to triage issue
  - Removed "in-progress" label
---

## Objective

Take the top-ranked bug from the triage backlog, get assigned upstream, reproduce it, fix it, verify with pytest, and mark ready for human review. Do NOT create a PR — that is a separate workflow.

## Context

- **Upstream**: `langchain-ai/langchain` (default branch: `master`)
- **Fork**: `jeanibarz/langchain` (forked from langchain-ai/langchain)
- **Triage issues**: Labeled `bug-triage`, ranked by priority score in title `[P{score}]`
- **Labels used by this playbook**: `in-progress`, `ready`
- **Branch naming**: `fix/{upstream-issue-number}-{short-slug}`
- **Package manager**: `uv`
- **Test framework**: `pytest`
- **Linter/formatter**: `ruff`, `mypy`

## Package Paths

| Package | Path | Scope (for PR title) |
|---------|------|------|
| langchain-core | `libs/core/` | `core` |
| langchain (v1) | `libs/langchain_v1/` | `langchain` |
| langchain-classic | `libs/langchain/` | `langchain-classic` |
| langchain-openai | `libs/partners/openai/` | `openai` |
| langchain-anthropic | `libs/partners/anthropic/` | `anthropic` |
| langchain-ollama | `libs/partners/ollama/` | `ollama` |
| langchain-chroma | `libs/partners/chroma/` | `chroma` |
| langchain-huggingface | `libs/partners/huggingface/` | `huggingface` |
| text-splitters | `libs/text-splitters/` | `text-splitters` |
| standard-tests | `libs/standard-tests/` | `standard-tests` |

## Phase 1: Select a bug

1. List open triage issues sorted by priority, excluding ones already in progress or ready:

   ```bash
   gh issue list -R jeanibarz/langchain --label "bug-triage" --state open --json number,title,labels \
     --jq '[.[] | select(.labels | map(.name) | (contains(["ready"]) or contains(["in-progress"])) | not)] | sort_by(.title) | reverse | .[0]'
   ```

2. If no eligible issues exist, report "No triaged bugs available" and stop.

3. Read the full triage issue:
   ```bash
   gh issue view -R jeanibarz/langchain {number} --json body,title,labels,comments
   ```

4. Extract the upstream issue number and read the upstream issue:
   ```bash
   gh issue view -R langchain-ai/langchain {upstream_number} --json body,comments,labels,assignees
   ```

5. **Check assignment status** — this is CRITICAL for langchain:
   ```bash
   # Check if anyone is assigned
   gh api repos/langchain-ai/langchain/issues/{upstream_number} --jq '.assignees[].login'
   ```
   - If assigned to someone else: **skip this bug**, pick the next one
   - If assigned to us (`jeanibarz`): proceed
   - If unassigned: **request assignment first** by commenting on the upstream issue:
     ```bash
     gh api repos/langchain-ai/langchain/issues/{upstream_number}/comments -X POST \
       -f body="I'd like to work on this. Could you assign it to me? I'll submit a fix with tests."
     ```
     Then **stop and wait** — do not implement a fix before being assigned. Move to the next bug or end the run.

6. Add `in-progress` label to the triage issue (only if assigned or assignment is pending):
   ```bash
   gh api repos/jeanibarz/langchain/issues/{number}/labels -X POST --input - <<'EOF'
   {"labels":["in-progress"]}
   EOF
   ```

## Phase 2: Reproduce

1. Ensure fork is up to date:
   ```bash
   git fetch upstream
   git checkout master
   git merge upstream/master --ff-only
   ```

2. Set up the affected package:
   ```bash
   cd libs/{package-path}
   uv sync --all-groups
   ```

3. Create a fix branch:
   ```bash
   git checkout -b fix/{upstream_number}-{short-slug}
   ```

4. Follow the reproduction plan from the triage issue. Typical reproduction:
   ```bash
   # Write a minimal reproduction script
   cat > /tmp/repro.py << 'PYEOF'
   # Minimal reproduction for langchain-ai/langchain#{upstream_number}
   from langchain_core.xxx import YYY
   # ... reproduction code
   PYEOF

   cd libs/{package-path}
   uv run python /tmp/repro.py
   ```

5. If reproduction fails:
   - Comment on the triage issue explaining what was tried
   - Lower the reproducibility score if appropriate
   - Remove `in-progress` label
   - Stop — do not attempt a fix for a bug that cannot be reproduced

## Phase 3: Fix

1. Identify the root cause based on reproduction and the triage issue's "Potential Root Cause" section.

2. Identify the affected package and source files:
   ```bash
   ls libs/{package-path}/
   cat libs/{package-path}/pyproject.toml
   ```

3. Implement the minimal fix. Principles:
   - **Smallest possible change** — don't refactor surrounding code
   - **Single package only** — PRs should not touch more than one package (per CONTRIBUTING)
   - **Match existing code style** — follow patterns in the file you're editing
   - **No unrelated changes** — don't fix formatting, add comments, or rename things
   - **Type hints required** — all code must include type hints and return types
   - **No breaking changes** — preserve function signatures for exported/public methods
   - **No dependency changes** — don't modify `pyproject.toml` or `uv.lock` without permission
   - **Use keyword-only args** for any new parameters: `*, new_param: str = "default"`

4. Add or update pytest unit tests:
   - Write a test that **fails without the fix** and **passes with it**
   - Place tests in `tests/unit_tests/` mirroring source structure
   - **No network calls** in unit tests — use mocks for external services
   - Use fixtures/mocks for external dependencies

   ```python
   import pytest
   from langchain_core.xxx import YYY


   def test_yyy_handles_edge_case() -> None:
       """Test that YYY correctly handles {edge case that was buggy}."""
       # Arrange
       ...
       # Act
       result = YYY(...)
       # Assert
       assert result == expected
   ```

5. Run the full quality checks for the affected package:
   ```bash
   cd libs/{package-path}
   make format   # Auto-format with ruff
   make lint     # Lint + type check (ruff + mypy)
   make test     # Run pytest unit tests
   ```

6. Verify all three pass before proceeding.

## Phase 4: Mark ready

1. Commit the fix with Conventional Commits format:
   ```
   fix({scope}): {description in lowercase}

   Fixes langchain-ai/langchain#{upstream_number}

   {One-paragraph explanation of root cause and fix}
   ```

   Valid scopes: core, langchain, openai, anthropic, ollama, chroma, huggingface, text-splitters, etc.

2. Push the branch:
   ```bash
   git push origin fix/{upstream_number}-{short-slug}
   ```

3. Comment on the triage issue with the fix summary:
   ```bash
   gh api repos/jeanibarz/langchain/issues/{number}/comments -X POST -f body="$(cat <<'EOF'
   ## Fix implemented ({date})

   **Branch**: `fix/{upstream_number}-{short-slug}`
   **Commit**: {short_sha}
   **Affected package**: {package name}
   **Upstream assignment**: {assigned to us / pending}

   ### Reproduction result
   {What happened when reproducing — exact error, behavior observed}

   ### Root cause
   {What was actually wrong}

   ### Fix summary
   {What was changed and why}

   ### Tests
   {What pytest tests were added/modified}

   ### Quality checks
   - make format: PASS
   - make lint: PASS
   - make test: PASS

   Ready for human review before PR creation.
   EOF
   )"
   ```

4. Add `ready` label and remove `in-progress`:
   ```bash
   gh api repos/jeanibarz/langchain/issues/{number}/labels -X PUT --input - <<'EOF'
   {"labels":["bug-triage","ready","pkg-{name}"]}
   EOF
   ```

## Idempotency Rules

1. **One bug per run.** Pick the single highest-priority issue and work it to completion or failure.
2. **Don't re-fix ready issues.** Skip issues that already have the `ready` label.
3. **Don't re-fix issues with linked branches.** If a `fix/` branch already exists for the upstream number, skip unless stale (no commits in 7+ days).
4. **Clean up on failure.** If reproduction fails or the fix doesn't work, remove `in-progress`, comment explaining why.
5. **Don't modify triage scores.** Only the triage playbook adjusts scores.
6. **Don't implement without assignment.** Always request assignment first and wait.

## Anti-Patterns

- Don't pick a bug you can't reproduce — reproduction is a hard gate
- Don't bundle multiple bug fixes in one branch — one branch per bug
- Don't add features or improvements alongside the fix
- Don't skip tests — every fix needs regression tests (pytest)
- Don't create a PR — that's a separate playbook
- Don't force-push or rewrite history on fix branches
- Don't touch multiple packages in one fix
- Don't update uv.lock or pyproject.toml dependencies
- Don't use `eval()`, `exec()`, bare `except:`, or `pickle` on user input
- Don't make changes to langchain-classic — it's legacy, no new features
- Don't submit a PR before being assigned to the upstream issue
