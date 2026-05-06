---
name: LangChain Bug Triage
description: Browse upstream langchain-ai/langchain bug reports, score by confidence and reproducibility, maintain ranked triage issues in jeanibarz/langchain fork
cwd: $HOME/git/langchain
checklist:
  - Fetched current triage issues from jeanibarz/langchain
  - Fetched recent upstream bug reports from langchain-ai/langchain (open + recently closed)
  - Closed triage issues for bugs fixed upstream
  - Re-scored existing triage issues with new upstream information
  - Scored and created triage issues for new upstream bugs
  - Verified no duplicate triage issues exist
  - Verified all triage issues have correct confidence and repro labels
  - Verified priority scores in titles match confidence * reproducibility
  - Final ranked list reported (sorted by priority score descending)
---

## Objective

Maintain a ranked set of upstream bug triage issues in `jeanibarz/langchain`. Each issue represents a user-reported bug from `langchain-ai/langchain` that we've analyzed for reproducibility and confidence. The ranking helps decide which bugs to reproduce and fix first.

## Context

- **Upstream**: `langchain-ai/langchain` (official LangChain Python monorepo)
- **Fork**: `jeanibarz/langchain` (forked from langchain-ai/langchain)
- **Language**: Python (uv monorepo)
- **Test framework**: pytest
- **Default branch**: `master`
- **Labels**: `bug-triage`, `confidence-high`, `confidence-medium`, `confidence-low`, `repro-easy`, `repro-medium`, `repro-hard`
- **Package-specific labels**: `pkg-core`, `pkg-langchain`, `pkg-openai`, `pkg-anthropic`, `pkg-ollama`, `pkg-text-splitters`, etc.

## Monorepo structure

```
libs/
├── core/             # langchain-core — base abstractions, interfaces, protocols
├── langchain/        # langchain-classic (legacy, no new features)
├── langchain_v1/     # Actively maintained langchain package
├── partners/
│   ├── openai/       # langchain-openai
│   ├── anthropic/    # langchain-anthropic
│   ├── ollama/       # langchain-ollama
│   ├── chroma/       # langchain-chroma
│   ├── huggingface/  # langchain-huggingface
│   └── ...           # other partner integrations
├── text-splitters/   # Document chunking utilities
├── standard-tests/   # Shared test suite for integrations
└── model-profiles/   # Model configuration profiles
```

## Upstream contribution rules (from CLAUDE.md and PR template)

These rules determine what is accepted:
1. **All external PRs MUST link to an issue approved by a maintainer** — PRs without prior approval get closed
2. **You must be assigned to the issue** before submitting a PR
3. **PR title**: Conventional Commits format — `type(scope): description` (lowercase)
4. **Allowed types**: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert, release, hotfix
5. **Allowed scopes**: core, langchain, langchain-classic, model-profiles, standard-tests, text-splitters, docs, anthropic, chroma, deepseek, exa, fireworks, groq, huggingface, mistralai, nomic, ollama, openai, perplexity, qdrant, xai, infra, deps, partners
6. **Tests required**: Every bugfix must have unit tests (no network calls in unit tests)
7. **CI must pass**: `make format`, `make lint`, `make test` from the package root
8. **Type hints required**: All Python code must include type hints and return types
9. **Google-style docstrings**: Required for all public functions
10. **Don't update uv.lock or add dependencies** without explicit maintainer permission
11. **PRs should not touch more than one package** unless absolutely necessary
12. **Stable public interfaces**: Never make breaking changes to exported functions
13. **AI disclaimer**: PR description must mention AI agent involvement

## Phase 1: Survey current state

1. List existing triage issues in our fork:
   ```bash
   gh issue list -R jeanibarz/langchain --label "bug-triage" --state open --limit 200 --json number,title,body,labels,updatedAt
   ```

2. Fetch upstream bugs — prioritize high-signal sources:
   ```bash
   # Bugs with "help wanted" label (explicitly seeking contributors)
   gh api "repos/langchain-ai/langchain/issues?labels=bug,help+wanted&state=open&per_page=30"

   # Most-reacted bugs (community-validated)
   gh api "repos/langchain-ai/langchain/issues?labels=bug&state=open&sort=reactions-+1&direction=desc&per_page=50"

   # Recently opened bugs
   gh issue list -R langchain-ai/langchain --label "bug" --state open --limit 50 --json number,title,body,createdAt,comments,labels

   # Bugs by key package (focus on core, openai, anthropic — most impactful)
   gh api "repos/langchain-ai/langchain/issues?labels=bug,core&state=open&per_page=30"
   gh api "repos/langchain-ai/langchain/issues?labels=bug,openai&state=open&per_page=30"
   gh api "repos/langchain-ai/langchain/issues?labels=bug,anthropic&state=open&per_page=30"

   # Recently closed bugs (to close our triage issues)
   gh issue list -R langchain-ai/langchain --label "bug" --state closed --limit 100 --json number,title,closedAt
   ```

3. For each promising bug, read the full issue body and comments to score it:
   ```bash
   gh issue view -R langchain-ai/langchain {number} --json body,comments,labels,reactions,assignees
   ```

4. **Check if the issue is already assigned** — if someone is already assigned and working on it, skip it (unless stale >30 days).

## Phase 2: Score and act

### Confidence Score (1-5): Is this a real bug?

| Score | Meaning | Signals |
|-------|---------|---------|
| **5** | Definitely a bug | Maintainer confirmed, multiple reporters, clear stack trace, regression |
| **4** | Very likely a bug | Detailed repro steps, consistent with codebase, affects common workflow |
| **3** | Probably a bug | Single reporter but credible, plausible root cause, no contradicting evidence |
| **2** | Unclear | Vague description, could be config issue, might be expected behavior |
| **1** | Probably not a bug | User error, documented limitation, or feature request disguised as bug |

**Signals that increase confidence:**
- Maintainer tagged it with `help wanted` or `investigate`
- Multiple users confirm the same issue
- Clear stack trace pointing to langchain code
- Issue includes minimal reproduction script
- Bug is a regression from a recent release
- Has `trusted-contributor` label (experienced community member)

**Signals that decrease confidence:**
- Reporter is confused about API usage
- Issue is about a deprecated/legacy path (`langchain-classic`)
- Environment-specific (specific Python version, unusual OS)
- No reproduction steps provided
- Contradicted by other users ("works for me")
- Labeled `external` with no maintainer engagement

### Reproducibility Score (1-5): How easy to reproduce?

| Score | Meaning | Signals |
|-------|---------|---------|
| **5** | Trivial to reproduce | Clear Python script, standard setup, deterministic |
| **4** | Easy to reproduce | Clear steps but needs API keys or specific model |
| **3** | Moderate effort | Needs multi-step setup, specific model version, or async context |
| **2** | Hard to reproduce | Intermittent, race condition, requires paid API access |
| **1** | Very hard / impossible | No repro steps, depends on external service state |

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

### Extra boost for "help wanted" issues

Issues labeled `help wanted` by maintainers get a **+3 priority bonus** (capped at 25) because:
- Maintainer has pre-approved external contributions
- Assignment is more likely to be granted
- PR is more likely to be reviewed and merged

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
[P{priority}] {upstream_issue_title} (langchain-ai/langchain#{upstream_number})
```

Examples:
- `[P25] trim_messages breaks with per-message callable (langchain-ai/langchain#35629)`
- `[P18] httpx client created per instantiation (langchain-ai/langchain#32489)`
- `[P04] ChromaDB deletion not working (langchain-ai/langchain#4880)`

Use zero-padded two-digit priority (P04, P12, P25).

### Issue body template

Use this exact structure for every triage issue:

```markdown
## Upstream Issue

- **Source**: langchain-ai/langchain#{number}
- **Reporter**: @{author}
- **Created**: {date}
- **Status**: {open/closed}
- **Upstream labels**: {labels}
- **Affected package**: {core/langchain/openai/anthropic/etc.}
- **Help wanted**: {yes/no}
- **Currently assigned**: {yes — @who / no}

## Scores

| Dimension | Score | Reasoning |
|-----------|-------|-----------|
| **Confidence** | {1-5}/5 | {brief justification} |
| **Reproducibility** | {1-5}/5 | {brief justification} |
| **Priority** | **{priority}**/25 | {note if help-wanted bonus applied} |

## Summary

{One-paragraph summary of the bug in our own words}

## Reproduction Plan

{What we would need to do to reproduce this locally — Python script, specific packages, API keys needed}

## Potential Root Cause

{Our analysis of what might be causing this, based on the upstream discussion and source code references}

## Fix Approach (if obvious)

{If the fix is apparent from the discussion or code, outline it. Otherwise "Needs investigation after reproduction."}

## Contribution Readiness

- [ ] Issue has maintainer approval for external contribution
- [ ] Issue is unassigned or assigned to us
- [ ] Fix scope is limited to one package
- [ ] No dependency changes required

## Upstream Activity

- {date}: {key comment or event from upstream discussion}
- ...
```

### Creating a new triage issue

```bash
gh issue create -R jeanibarz/langchain \
  --title "[P{score}] {title} (langchain-ai/langchain#{number})" \
  --label "bug-triage,confidence-{level},repro-{level},pkg-{name}" \
  --assignee jeanibarz \
  --body "$(cat <<'EOF'
{body from template above}
EOF
)"
```

### Updating an existing triage issue (re-scoring)

```bash
gh api repos/jeanibarz/langchain/issues/{number} -X PATCH -f title="[P{new_score}] {title} (langchain-ai/langchain#{upstream})"

gh api repos/jeanibarz/langchain/issues/{number}/labels -X PUT --input - <<'EOF'
{"labels":["bug-triage","confidence-{new_level}","repro-{new_level}","pkg-{name}"]}
EOF

gh api repos/jeanibarz/langchain/issues/{number}/comments -X POST -f body="**Re-scored ({date})**: Priority {old} -> {new}. Reason: {what changed}"
```

### Closing a triage issue

```bash
gh issue close -R jeanibarz/langchain {number} -c "Closed: {reason — fixed upstream in langchain-ai/langchain#{pr}, or confirmed not a bug}"
```

## Phase 3: Verify and report

```bash
gh issue list -R jeanibarz/langchain --label "bug-triage" --state open --json number,title --jq 'sort_by(.title) | reverse | .[] | "\(.number)\t\(.title)"'
```

Verify:
- No duplicate triage issues (each upstream issue appears at most once)
- All triage issues have `bug-triage` + one confidence label + one repro label + one package label
- Priority scores in titles match confidence * reproducibility (+ help-wanted bonus if applicable)
- All issues assigned to `jeanibarz`
- Report: total count, breakdown by priority tier (20-25, 12-19, 6-11, 1-5)

## Focus Areas (highest ROI)

Priority order for triage:
1. **`help wanted` bugs** — Pre-approved for external contribution, highest merge probability
2. **`core` bugs** — High impact, affects all users
3. **`openai` bugs** — Most-used integration, high visibility
4. **`anthropic` bugs** — Growing ecosystem, good domain fit
5. **`langchain` (v1) bugs** — Actively maintained package
6. **Other partners** — Lower priority unless `help wanted`

## Skip Criteria

Don't create triage issues for:
- Feature requests disguised as bugs
- Issues about `langchain-classic` (legacy, no new features accepted)
- Issues about partner packages in separate repos (langchain-google, langchain-aws, etc.)
- Issues already assigned to a maintainer with an active PR
- Bot-filed issues (dependabot, renovate)
- Issues with `investigate` label but no maintainer engagement (wait for them to triage first)
- Issues in languages other than English
- Issues requiring dependency changes (maintainer permission needed)

## Idempotency Rules (Ralph Wiggum Loop)

1. **Don't create duplicate triage issues.** Before creating, check if a triage issue already exists for the upstream issue number.
2. **Don't re-score without new information.** Only update scores when upstream has new comments, status changes, or labels.
3. **Converge, don't diverge.** Each run should refine scores and close resolved issues.
4. **Respect manual overrides.** If the user manually changed a score or label, don't override it.
5. **Date-stamp all updates.**
6. **Batch wisely.** Focus on: `help wanted`, recently opened (last 30 days), recently updated, and high-engagement issues.

## Anti-Patterns

- Don't score based on title alone — always read the issue body and comments
- Don't create triage issues for every upstream bug — focus on ones we could realistically fix
- Don't copy the entire upstream issue body — summarize in our own words
- Don't ignore upstream discussion — it reveals whether the bug is real and if maintainers want help
- Don't set all scores to 3 by default — differentiate aggressively
- Don't triage issues that aren't approved for external contribution — check for maintainer engagement
- Don't triage issues in partner repos we don't have (langchain-google, langchain-aws, etc.)
