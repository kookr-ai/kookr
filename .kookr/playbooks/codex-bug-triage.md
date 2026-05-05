---
name: Codex CLI Bug Triage
description: Browse upstream openai/codex bug reports, score by confidence and reproducibility, maintain ranked triage issues in jeanibarz/codex fork
cwd: /home/jean/git/codex
checklist:
  - Fetched current triage issues from jeanibarz/codex
  - Fetched recent upstream bug reports from openai/codex (open + recently closed)
  - Closed triage issues for bugs fixed upstream
  - Re-scored existing triage issues with new upstream information
  - Scored and created triage issues for new upstream bugs
  - Verified no duplicate triage issues exist
  - Verified all triage issues have correct confidence and repro labels
  - Verified priority scores in titles match confidence * reproducibility
  - Final ranked list reported (sorted by priority score descending)
---

## Objective

Maintain a ranked set of upstream bug triage issues in `jeanibarz/codex`. Each issue represents a user-reported bug from `openai/codex` that we've analyzed for reproducibility and confidence. The ranking helps decide which bugs to reproduce and fix first.

## Context

- **Fork**: `jeanibarz/codex` (forked from `openai/codex`)
- **Labels**: `bug-triage`, `confidence-high`, `confidence-medium`, `confidence-low`, `repro-easy`, `repro-medium`, `repro-hard`

## Phase 1: Survey current state

1. List existing triage issues in our fork:
   ```bash
   gh issue list -R jeanibarz/codex --label "bug-triage" --state open --limit 200 --json number,title,body,labels,updatedAt
   ```

2. Fetch upstream bugs — prioritize high-signal sources:
   ```bash
   # Most-reacted bugs (community-validated)
   gh api "repos/openai/codex/issues?labels=bug&state=open&sort=reactions-+1&direction=desc&per_page=50"

   # Recently opened bugs
   gh issue list -R openai/codex --label "bug" --state open --limit 50 --json number,title,body,createdAt,comments

   # Recently closed bugs (to close our triage issues)
   gh issue list -R openai/codex --label "bug" --state closed --limit 100 --json number,title,closedAt

   # Bugs with detailed reproduction steps
   gh api "repos/openai/codex/issues?labels=bug&state=open&per_page=100" --jq '.[] | select(.body | test("step|repro|reproduce|minimal"; "i")) | {number, title}'

   # Bugs affecting core functionality
   gh api "repos/openai/codex/issues?labels=bug&state=open&per_page=100" --jq '.[] | select(.title | test("sandbox|exec|mcp|crash|panic"; "i")) | {number, title}'
   ```

3. For each promising bug, read the full issue body and comments to score it:
   ```bash
   gh issue view -R openai/codex {number} --json body,comments,labels,reactions
   ```

## Phase 2: Score and act

### Confidence Score (1-5): Is this a real bug?

| Score | Meaning | Signals |
|-------|---------|---------|
| **5** | Definitely a bug | Maintainer confirmed, multiple reporters, clear stack trace, regression from known-good version |
| **4** | Very likely a bug | Detailed repro steps, consistent with codebase understanding, affects common workflow |
| **3** | Probably a bug | Single reporter but credible description, plausible root cause, no contradicting evidence |
| **2** | Unclear | Vague description, could be config issue, might be expected behavior, single report without repro |
| **1** | Probably not a bug | Looks like user error, documented limitation, or feature request disguised as bug |

**Signals that increase confidence:**
- Multiple users report the same issue
- Maintainer or contributor commented acknowledging the bug
- Clear error message or stack trace provided
- Issue includes a minimal reproduction case
- Regression identified (worked in version X, broken in Y)

**Signals that decrease confidence:**
- Reporter is confused about expected behavior
- Issue is about a feature behind an experimental flag
- Environment-specific (unusual OS, Docker, WSL edge case)
- No reproduction steps provided
- Contradicted by other users ("works for me")

### Reproducibility Score (1-5): How easy to reproduce?

| Score | Meaning | Signals |
|-------|---------|---------|
| **5** | Trivial to reproduce | Clear steps, common setup (Linux/macOS, standard shell), deterministic |
| **4** | Easy to reproduce | Clear steps but needs specific setup (particular project structure, MCP server, etc.) |
| **3** | Moderate effort | Steps exist but involve multi-step setup, timing-dependent, or platform-specific |
| **2** | Hard to reproduce | Intermittent, requires rare conditions, complex environment, or unclear steps |
| **1** | Very hard / impossible | No repro steps, race condition, specific hardware, or requires access we don't have |

### Priority Score Calculation

```
priority = confidence * reproducibility
```

| Priority Range | Meaning |
|----------------|---------|
| **20-25** | Top priority — real bug, easy to reproduce. Fix first. |
| **12-19** | High priority — worth investigating soon |
| **6-11** | Medium priority — investigate when time permits |
| **1-5** | Low priority — park unless more evidence appears |

### Confidence-to-label mapping

| Score | Label |
|-------|-------|
| 4-5 | `confidence-high` |
| 3 | `confidence-medium` |
| 1-2 | `confidence-low` |

### Reproducibility-to-label mapping

| Score | Label |
|-------|-------|
| 4-5 | `repro-easy` |
| 3 | `repro-medium` |
| 1-2 | `repro-hard` |

### Issue title format

```
[P{priority}] {upstream_issue_title} (openai/codex#{upstream_number})
```

Examples:
- `[P25] Sandbox crashes on symlinked /tmp directory (openai/codex#15234)`
- `[P12] MCP OAuth flow fails with custom redirect URI (openai/codex#15456)`
- `[P04] TUI flickering on Alacritty with 144Hz monitor (openai/codex#15789)`

Use zero-padded two-digit priority (P04, P12, P25) so lexicographic sort matches priority order.

### Issue body template

Use this exact structure for every triage issue:

```markdown
## Upstream Issue

- **Source**: openai/codex#{number}
- **Reporter**: @{author}
- **Created**: {date}
- **Status**: {open/closed}
- **Upstream labels**: {labels}

## Scores

| Dimension | Score | Reasoning |
|-----------|-------|-----------|
| **Confidence** | {1-5}/5 | {brief justification} |
| **Reproducibility** | {1-5}/5 | {brief justification} |
| **Priority** | **{confidence * reproducibility}**/25 | |

## Summary

{One-paragraph summary of the bug in our own words}

## Reproduction Plan

{What we would need to do to reproduce this locally — specific steps, environment setup}

## Potential Root Cause

{Our analysis of what might be causing this, based on the upstream discussion and source code references}

## Fix Approach (if obvious)

{If the fix is apparent from the discussion or code, outline it. Otherwise "Needs investigation after reproduction."}

## Upstream Activity

- {date}: {key comment or event from upstream discussion}
- ...
```

### Creating a new triage issue

```bash
gh issue create -R jeanibarz/codex \
  --title "[P{score}] {title} (openai/codex#{number})" \
  --label "bug-triage,confidence-{level},repro-{level}" \
  --assignee jeanibarz \
  --body "$(cat <<'EOF'
{body from template above}
EOF
)"
```

### Updating an existing triage issue (re-scoring)

```bash
# Update title with new priority score
gh api repos/jeanibarz/codex/issues/{number} -X PATCH -f title="[P{new_score}] {title} (openai/codex#{upstream})"

# Update labels
gh api repos/jeanibarz/codex/issues/{number}/labels -X PUT --input - <<'EOF'
{"labels":["bug-triage","confidence-{new_level}","repro-{new_level}"]}
EOF

# Add update comment
gh api repos/jeanibarz/codex/issues/{number}/comments -X POST -f body="**Re-scored ({date})**: Priority {old} -> {new}. Reason: {what changed}"
```

### Closing a triage issue

```bash
gh issue close -R jeanibarz/codex {number} -c "Closed: {reason — fixed upstream in openai/codex#{pr}, or confirmed not a bug}"
```

## Phase 3: Verify and report

```bash
# Full list sorted by title (priority in title, so lexicographic sort = priority sort)
gh issue list -R jeanibarz/codex --label "bug-triage" --state open --json number,title --jq 'sort_by(.title) | reverse | .[] | "\(.number)\t\(.title)"'

# Verify no orphans (triage issue for an upstream bug that was closed)
# For each triage issue, extract the upstream number from title and check its status
```

Verify:
- No duplicate triage issues (each upstream issue appears at most once)
- All triage issues have `bug-triage` + one confidence label + one repro label
- Priority scores in titles match confidence * reproducibility
- All issues assigned to `jeanibarz`
- Report: total count, breakdown by priority tier (20-25, 12-19, 6-11, 1-5)

## Skip Criteria

Don't create triage issues for:
- Feature requests disguised as bugs
- ChatGPT account/billing issues
- Legacy Node.js CLI bugs (only Rust CLI matters)
- Windows-only bugs (unless reproduction is available)
- Bugs with active fix PRs from maintainers
- Issues already assigned to a maintainer with an active PR

## Idempotency Rules (Ralph Wiggum Loop)

1. **Don't create duplicate triage issues.** Before creating, check if a triage issue already exists for the upstream issue number (search body for `openai/codex#{number}`).
2. **Don't re-score without new information.** Only update scores when upstream has new comments, status changes, or labels since the triage issue was last updated.
3. **Converge, don't diverge.** Each run should refine scores and close resolved issues, not grow the list unboundedly.
4. **Respect manual overrides.** If the user manually changed a score or label, don't override it.
5. **Date-stamp all updates.** Every comment should include the date for tracking.
6. **Batch wisely.** Don't process all 15,000+ upstream issues at once. Focus on: recently opened (last 30 days), recently updated, and high-engagement (many comments/reactions).

## Anti-Patterns

- Don't score based on title alone — always read the issue body and comments
- Don't create triage issues for every upstream bug — focus on ones we could realistically fix
- Don't copy the entire upstream issue body — summarize in our own words
- Don't ignore upstream discussion — it often reveals whether the bug is real
- Don't set all scores to 3 by default — differentiate aggressively to make ranking useful
