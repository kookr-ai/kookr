---
name: LangChain PR Lessons
description: Analyze closed PRs from langchain-ai/langchain to learn what makes contributions successful, track learnings, and distill patterns into reusable skills
cwd: $HOME/git/langchain
checklist:
  - Read state file and determined next batch of PRs to process
  - Fetched batch of closed PRs from langchain-ai/langchain (5 PRs per iteration)
  - Analyzed each PR for quality signals (description, reviews, outcome)
  - Recorded raw learnings with PR-specific observations
  - Updated state file with processed PR IDs
  - Checked distillation threshold (learnings-raw.md > 200 lines)
  - If threshold met: distilled patterns into langchain-patterns.md and user-scoped skill
  - Verified no PRs were processed twice
  - Reported batch summary (processed count, key observations, distillation status)
---

## Objective

Learn what makes a good contribution to langchain-ai/langchain by systematically analyzing closed PRs. Extract patterns about PR descriptions, review dynamics, commit discipline, test coverage, and maintainer expectations. Distill these into actionable skills that improve future contributions.

## Context

- **Upstream**: `langchain-ai/langchain` (the official repository)
- **Fork**: `jeanibarz/langchain` (our fork for contributions)
- **State directory**: `~/.claude/langchain-pr-lessons/` (outside any repo, accessible from worktrees)
- **State file**: `~/.claude/langchain-pr-lessons/state.json`
- **Raw learnings**: `~/.claude/langchain-pr-lessons/learnings-raw.md`
- **Distilled learnings**: `~/.claude/langchain-pr-lessons/learnings-distilled.md`
- **LangChain-specific patterns**: `~/.claude/langchain-pr-lessons/langchain-patterns.md`
- **General skill output**: `~/.claude/skills/pr-contribution-excellence/SKILL.md`

## Contribution Guidelines (from CLAUDE.md and PR template)

These rules MUST be respected by any contribution we produce:

1. **External PRs must link to a maintainer-approved issue** — PRs without prior approval get closed
2. **Must be assigned to the issue** before submitting PR
3. **PR title**: Conventional Commits format — `type(scope): description` (all lowercase)
4. **Allowed types**: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert, release, hotfix
5. **Allowed scopes**: core, langchain, openai, anthropic, ollama, chroma, huggingface, text-splitters, etc.
6. **Tests required**: Unit tests (no network calls), pytest
7. **CI must pass**: `make format`, `make lint`, `make test`
8. **Type hints required**: All Python code
9. **Google-style docstrings** for public functions
10. **Single package per PR**
11. **No dependency changes** without permission
12. **Stable public interfaces**: No breaking changes
13. **AI disclaimer** in PR description
14. **American English** spelling
15. **Stale PR policy**: External PRs with no activity get closed

## Phase 1: Plan

Initialize state if needed:

```bash
mkdir -p ~/.claude/langchain-pr-lessons

# Create state.json if it doesn't exist
if [ ! -f ~/.claude/langchain-pr-lessons/state.json ]; then
cat > ~/.claude/langchain-pr-lessons/state.json << 'EOF'
{
  "repo": "langchain-ai/langchain",
  "version": 1,
  "processed_prs": [],
  "skipped_prs": [],
  "total_processed": 0,
  "total_skipped": 0,
  "distillation_count": 0,
  "last_batch_at": null,
  "last_distillation_at": null,
  "cursor": 1,
  "notes": "State file for langchain-ai/langchain PR lessons."
}
EOF
fi

# Create learnings-raw.md if it doesn't exist
if [ ! -f ~/.claude/langchain-pr-lessons/learnings-raw.md ]; then
cat > ~/.claude/langchain-pr-lessons/learnings-raw.md << 'EOF'
# Raw PR Learnings

Accumulated observations from analyzing closed PRs in langchain-ai/langchain.
Each batch appends a section below. When this file exceeds 200 lines, distillation is triggered.

---

EOF
fi

cat ~/.claude/langchain-pr-lessons/state.json
```

### Fetch next batch of closed PRs

Use cursor-based pagination. Fetch closed PRs sorted by recently updated, mixing merged and unmerged:

```bash
gh api "repos/langchain-ai/langchain/pulls?state=closed&sort=updated&direction=desc&per_page=20&page={cursor_or_1}" \
  --jq '.[] | {number, title, merged_at, closed_at, user: .user.login, additions, deletions, changed_files, body: (.body[:200])}'
```

### Filter and select batch

From the fetched PRs:
1. Remove any PR whose number is in `processed_prs` or `skipped_prs`
2. Skip bot PRs (dependabot, renovate, github-actions, langchain-model-profile-bot) — add to `skipped_prs`
3. Skip release PRs (`release(scope): x.y.z`) — add to `skipped_prs`
4. Skip PRs with zero discussion and zero code changes — add to `skipped_prs`
5. Select the first 5 remaining PRs as the batch
6. **Prefer a mix**: try to include both merged and closed-without-merge PRs

## Phase 2: Analyze (per PR)

For each PR in the batch, collect:

```bash
# PR metadata
gh pr view -R langchain-ai/langchain {number} --json number,title,body,state,mergedAt,closedAt,author,additions,deletions,changedFiles,labels,createdAt,baseRefName,headRefName

# Reviews (approval/rejection decisions)
gh api "repos/langchain-ai/langchain/pulls/{number}/reviews" --jq '.[] | {user: .user.login, state: .state, body: (.body[:300])}'

# Review comments (inline code comments)
gh api "repos/langchain-ai/langchain/pulls/{number}/comments?per_page=100" --jq '.[] | {user: .user.login, body: (.body[:300]), path: .path, created_at: .created_at}'

# PR comments (general discussion)
gh api "repos/langchain-ai/langchain/issues/{number}/comments?per_page=50" --jq '.[] | {user: .user.login, body: (.body[:300]), created_at: .created_at}'
```

### Signal Extraction Framework

For each PR, evaluate:

#### 1. Issue Linkage & Pre-Approval
- Does it reference an approved issue with `Fixes #xxx`?
- Was the author assigned to the issue before submitting?
- **Signal**: PRs without issue links or assignment get closed immediately in langchain

#### 2. PR Title Compliance
- Does it follow Conventional Commits: `type(scope): description`?
- Is the type valid? Is the scope valid?
- Is it lowercase?
- **Signal**: PR title lint fails → PR blocked until fixed

#### 3. Description Quality
- Does it explain "why" not just "what"?
- Is there an AI disclaimer?
- Is it concise (1-2 sentences + context) or bloated?
- **Signal**: LangChain maintainers explicitly say "Limit prose" and warn against AI-generated boilerplate

#### 4. Review Dynamics
- How many review rounds?
- What types of feedback? (blocking, suggestion, nit, question)
- Did the author respond constructively?
- Key maintainers to watch: eyurtsev, ccurme, baskaryan, efriis
- **Signal**: Who reviewed and how fast correlates with merge success

#### 5. Scope & Size
- Lines added/deleted, files changed
- Does it touch only one package?
- **Signal**: Multi-package PRs get more scrutiny; small focused PRs merge faster

#### 6. Test Coverage
- Are tests included in `tests/unit_tests/`?
- Do tests have type hints and proper structure?
- **Signal**: No tests → changes_requested consistently

#### 7. CI Compliance
- Did `make format`, `make lint`, `make test` pass on first push?
- Any type hint issues caught by mypy?
- **Signal**: CI failures correlate with more review rounds and longer merge times

#### 8. Outcome Classification

| Outcome | Meaning | Learning Value |
|---------|---------|----------------|
| **Merged quickly** (<3 days, <2 rounds) | Well-executed, aligned with maintainer expectations | What "good" looks like |
| **Merged after discussion** (>3 days or >2 rounds) | Complex but ultimately accepted | How to navigate feedback |
| **Closed — no issue link** | Violated contribution requirements | Process compliance lesson |
| **Closed — not assigned** | Submitted before getting approval | Workflow violation |
| **Closed by author** | Author gave up | What discourages contributors |
| **Closed by maintainer** | Didn't meet standards | What maintainers reject |
| **Stale-closed** | Auto-closed for inactivity | Process friction signals |

### Output Format

For each PR, produce:

```markdown
### PR #{number}: {title}
- **Author**: {login} | **Outcome**: {merged/closed/stale} | **Duration**: {days}
- **Size**: +{additions}/-{deletions} across {files} files
- **Package**: {affected package scope}
- **Reviews**: {count} rounds, {approved/changes_requested/comment}
- **Issue link**: {yes — #{num} / no}
- **Assigned**: {yes/no/unknown}
- **PR title compliant**: {yes/no — what was wrong}
- **Description**: {good/adequate/poor/missing} — {specific note}
- **Tests**: {included/missing/partial} — {specific note}
- **CI**: {passed-first/failed-then-fixed/never-passed}
- **AI disclaimer**: {present/missing}
- **Key signals**:
  - {signal 1}
  - {signal 2}
- **Lesson**: {one-sentence takeaway}
```

## Phase 3: Record

Append batch learnings to `~/.claude/langchain-pr-lessons/learnings-raw.md`:

```markdown
## Batch {YYYY-MM-DD} (PRs: #{n1}, #{n2}, #{n3}, #{n4}, #{n5})

{Critic output for each PR}

### Batch-Level Observations

- {Cross-PR pattern noticed in this batch}
- {Contrast between merged vs rejected PRs in this batch}
- ...

---
```

Update `state.json`:
```bash
cat ~/.claude/langchain-pr-lessons/state.json | jq \
  '.processed_prs += [NEW_IDS] | .total_processed = (.processed_prs | length) | .last_batch_at = "TIMESTAMP"' \
  > /tmp/state-tmp.json && mv /tmp/state-tmp.json ~/.claude/langchain-pr-lessons/state.json
```

## Phase 4: Threshold check

```bash
LINE_COUNT=$(wc -l < ~/.claude/langchain-pr-lessons/learnings-raw.md)
TOTAL_PROCESSED=$(jq '.total_processed' ~/.claude/langchain-pr-lessons/state.json)
echo "Lines: $LINE_COUNT | Processed: $TOTAL_PROCESSED"

if [ "$LINE_COUNT" -gt 200 ] && [ "$TOTAL_PROCESSED" -ge 10 ]; then
  echo "DECISION: DISTILL"
else
  echo "DECISION: SKIP (need >200 lines and >=10 PRs)"
fi
```

## Phase 5: Distill (only if threshold met)

Read all inputs:
```bash
cat ~/.claude/langchain-pr-lessons/learnings-raw.md
cat ~/.claude/langchain-pr-lessons/langchain-patterns.md 2>/dev/null || echo "(new file)"
cat ~/.claude/langchain-pr-lessons/learnings-distilled.md 2>/dev/null || echo "(new file)"
cat ~/.claude/skills/pr-contribution-excellence/SKILL.md 2>/dev/null || echo "(new file)"
```

### Classify patterns

| Pattern Type | Output Target | Example |
|-------------|---------------|---------|
| LangChain conventions | `langchain-patterns.md` | "PRs must include `Fixes #N` with assigned issue" |
| LangChain reviewer prefs | `langchain-patterns.md` | "eyurtsev prefers X pattern for core changes" |
| LangChain process rules | `langchain-patterns.md` | "Multi-package PRs always get changes_requested" |
| General PR patterns | User skill | "Link to issue in first line of PR body" |
| General review navigation | User skill | "Address blocking feedback before nits" |

### Write outputs

1. Update `langchain-patterns.md` with langchain-specific patterns
2. Update `pr-contribution-excellence/SKILL.md` with general patterns
3. Update `learnings-distilled.md` with distillation summary
4. Reset `learnings-raw.md` to header template
5. Increment `distillation_count` in `state.json`

## Skip Criteria for PRs

Add to `skipped_prs` (never revisit):
- Bot-authored PRs (dependabot, github-actions, renovate, langchain-model-profile-bot)
- Release PRs (`release(scope): x.y.z`)
- PRs opened and closed within 1 minute (accidental)
- Draft PRs never marked ready
- PRs with 0 files changed
- Dependency-only PRs (chore(deps): bump X)

## Idempotency Rules (Ralph Wiggum Loop)

1. **Never process the same PR twice.** Always check `state.json.processed_prs`.
2. **Never process skipped PRs again.** Check `state.json.skipped_prs`.
3. **Append, don't overwrite learnings.** Each batch appends.
4. **Distillation replaces, raw resets.** Distilled files rewritten; raw reset after distillation.
5. **Cursor advances monotonically.**
6. **Batch size is fixed at 5.**
7. **State file is the source of truth.**

## Anti-Patterns

- Don't judge PR quality by comment count alone
- Don't assume silent merges mean perfect PRs
- Don't ignore rejected PRs — they contain the most lessons
- Don't extract patterns from a single PR — wait for distillation
- Don't commit state files to the langchain repo
- Don't modify the langchain repo's tracked files during analysis
