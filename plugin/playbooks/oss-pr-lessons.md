---
name: OSS PR Lessons
description: Analyze closed PRs from any repository to learn contribution patterns — parameterized replacement for per-repo playbooks
repo-tags: [github]
parameters:
  - name: repoFullName
    description: "Full repository name (owner/repo, e.g., microsoft/vscode)"
    required: true
    type: select
    source: tracked-projects
checklist:
  - Read state file and determined next batch of PRs to process
  - Fetched batch of 5 closed PRs from the target repository
  - Analyzed each PR for quality signals (description, reviews, outcome)
  - Recorded raw learnings with PR-specific observations
  - Updated state file with processed PR IDs
  - Checked distillation threshold (learnings-raw.md > 200 lines)
  - If threshold met — distilled patterns into patterns.md and shared skill
  - Verified no PRs were processed twice
  - Reported batch summary (processed count, key observations, distillation status)
---

## Derived values

Compute these from `{{repoFullName}}`:
- **repoSlug**: replace `/` with `-` (e.g., `microsoft/vscode` → `microsoft-vscode`)
- **forkName**: `<your-login>/<repo>` where `<your-login>` is the authenticated `gh` user (`gh api user --jq .login`) and `<repo>` is the part after `/` (e.g., `microsoft/vscode` → `<your-login>/vscode`)

Use these derived values wherever repoSlug and forkName appear below.

## Objective

Learn what makes a good contribution to {{repoFullName}} by systematically analyzing closed PRs. Extract patterns about PR descriptions, review dynamics, commit discipline, test coverage, and maintainer expectations. Distill these into actionable skills that improve future contributions.

## Context

- **Upstream**: `{{repoFullName}}` (the repository to analyze)
- **Fork**: `<forkName>` (our fork for contributions, if applicable)
- **State directory**: `~/.claude/<repoSlug>-pr-lessons/` (outside any repo)
- **State file**: `~/.claude/<repoSlug>-pr-lessons/state.json`
- **Raw learnings**: `~/.claude/<repoSlug>-pr-lessons/learnings-raw.md`
- **Distilled learnings**: `~/.claude/<repoSlug>-pr-lessons/learnings-distilled.md`
- **Repo-specific patterns**: `~/.claude/<repoSlug>-pr-lessons/patterns.md`
- **General skill output**: `~/.claude/skills/pr-contribution-excellence/SKILL.md`

## Contribution Guidelines

Before analyzing PRs, load the recon report if it exists — it contains the repo's contribution rules:

```bash
cat ~/.claude/<repoSlug>-recon/recon-report.md 2>/dev/null || echo "(No recon report found — consider running oss-repo-recon first)"
```

If no recon report exists, at minimum fetch CONTRIBUTING.md:

```bash
gh api "repos/{{repoFullName}}/contents/CONTRIBUTING.md" --jq '.content' 2>/dev/null | base64 -d || echo "(no CONTRIBUTING.md)"
```

## Phase 1: Plan (use skill `oss-pr-plan`)

Load state, determine which PRs to fetch next. Use cursor-based pagination. Select 5 closed PRs per batch.

The skill references:
- State path: `~/.claude/<repoSlug>-pr-lessons/`
- API target: `repos/{{repoFullName}}/pulls`

## Phase 2: Analyze (use skill `oss-pr-critic`)

For each PR in the batch:
1. Fetch PR metadata, reviews, review comments, and PR comments from `{{repoFullName}}`
2. Apply the 8-dimension signal extraction framework
3. Classify outcome (merged quickly, merged after discussion, closed by author/maintainer, stale)
4. Produce structured observation blocks

## Phase 3: Record (use skill `oss-pr-state`)

Write observations to `~/.claude/<repoSlug>-pr-lessons/learnings-raw.md` and update `state.json`.

## Phase 4: Threshold check (use skill `oss-pr-threshold`)

Count lines in `~/.claude/<repoSlug>-pr-lessons/learnings-raw.md`. If > 200 lines AND total_processed >= 10, trigger distillation.

## Phase 5: Distill (use skill `oss-pr-distill`, only if threshold met)

Compress raw learnings into:
1. Repo-specific patterns -> `~/.claude/<repoSlug>-pr-lessons/patterns.md`
2. General PR contribution patterns -> `~/.claude/skills/pr-contribution-excellence/SKILL.md`

After distillation, reset `learnings-raw.md` to the header.

## Idempotency Rules (Ralph Wiggum Loop)

1. **Never process the same PR twice.** Always check `state.json.processed_prs`.
2. **Never process skipped PRs again.** Check `state.json.skipped_prs`.
3. **Append, don't overwrite learnings.** Each batch appends.
4. **Distillation replaces, raw resets.** Distilled files rewritten; raw reset after distillation.
5. **Cursor advances monotonically.**
6. **Batch size is fixed at 5.**
7. **State file is the source of truth.**

## Skip Criteria

Add to `skipped_prs` (never revisit):
- Bot-authored PRs (dependabot, github-actions, renovate, repo-specific bots)
- PRs opened and closed within 1 minute (accidental)
- Draft PRs never marked ready
- PRs with 0 files changed
- Release/version-bump PRs
- Dependency-only PRs

## Anti-Patterns

- Don't judge PR quality by comment count alone
- Don't assume silent merges mean perfect PRs
- Don't ignore rejected PRs — they contain the most lessons
- Don't extract patterns from a single PR — wait for distillation
- Don't commit state files to any repo
- Don't modify the target repo's tracked files during analysis
