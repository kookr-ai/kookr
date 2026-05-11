---
name: Codex PR Lessons
description: Analyze closed PRs from openai/codex to learn what makes contributions successful, track learnings, and distill patterns into reusable skills
cwd: $HOME/git/codex
checklist:
  - Read state file and determined next batch of PRs to process
  - Fetched batch of closed PRs from openai/codex (5 PRs per iteration)
  - Analyzed each PR for quality signals (description, reviews, outcome)
  - Recorded raw learnings with PR-specific observations
  - Updated state file with processed PR IDs
  - Checked distillation threshold (learnings-raw.md > 200 lines)
  - If threshold met: distilled patterns into codex-patterns.md and user-scoped skill
  - Verified no PRs were processed twice
  - Reported batch summary (processed count, key observations, distillation status)
---

## Objective

Learn what makes a good contribution to openai/codex by systematically analyzing closed PRs. Extract patterns about PR descriptions, review dynamics, commit discipline, test coverage, and maintainer expectations. Distill these into actionable skills that improve future contributions.

## Context

- **Upstream**: `openai/codex` (the official repository)
- **Fork**: `jeanibarz/codex` (our fork for contributions)
- **State directory**: `~/.claude/codex-pr-lessons/` (outside any repo, accessible from worktrees)
- **State file**: `~/.claude/codex-pr-lessons/state.json`
- **Raw learnings**: `~/.claude/codex-pr-lessons/learnings-raw.md`
- **Distilled learnings**: `~/.claude/codex-pr-lessons/learnings-distilled.md`
- **Codex-specific patterns**: `~/.claude/codex-pr-lessons/codex-patterns.md`
- **General skill output**: `${KOOKR_PLUGIN_DIR:-$HOME/git/kookr/plugin}/skills/pr-contribution-excellence/SKILL.md`

## Contribution Guidelines (from openai/codex docs/contributing.md)

These rules MUST be respected by any contribution we produce:

1. **Feature requests require pre-approval**: Open issue first, get OpenAI approval before coding
2. **Priority**: Bugs and security fixes only (currently)
3. **PR template**: Must answer What? Why? How? with link to issue
4. **Tests required**: Every new feature/bug-fix must have test coverage
5. **Atomic commits**: Each commit compiles and tests pass
6. **Focused PRs**: Multiple unrelated fixes = separate PRs
7. **CI clean**: No lint warnings or test failures
8. **Rust checks**: `cargo test && cargo clippy --tests && cargo fmt`
9. **CLA required**: Must sign Contributor License Agreement
10. **Stale PR policy**: External PRs inactive >14 days get auto-closed

## Phase 1: Plan (use skill `codex-pr-plan`)

Load state, determine which PRs to fetch next. Use cursor-based pagination to avoid re-fetching. Select 5 closed+merged PRs per batch.

## Phase 2: Analyze (use skill `codex-pr-critic`)

For each PR in the batch:
1. Fetch PR metadata (title, body, labels, merge status, files changed, additions/deletions)
2. Fetch review comments and review decisions (approved, changes_requested)
3. Fetch PR timeline (time from open to merge, number of review rounds)
4. Apply the critic framework to extract quality signals

## Phase 3: Record (use skill `codex-pr-state`)

Write observations to `learnings-raw.md` and update `state.json` with processed PR IDs.

## Phase 4: Threshold check (use skill `codex-pr-threshold`)

Count lines in `learnings-raw.md`. If > 200 lines, trigger distillation.

## Phase 5: Distill (use skill `codex-pr-distill`, only if threshold met)

Compress raw learnings into:
1. Codex-specific patterns → `~/.claude/codex-pr-lessons/codex-patterns.md`
2. General PR contribution patterns → `${KOOKR_PLUGIN_DIR:-$HOME/git/kookr/plugin}/skills/pr-contribution-excellence/SKILL.md`

After distillation, reset `learnings-raw.md` to the header (preserving the distilled content elsewhere).

## Idempotency Rules (Ralph Wiggum Loop)

1. **Never process the same PR twice.** Always check `state.json.processed_prs` before analyzing.
2. **Never process skipped PRs again.** Check `state.json.skipped_prs` too.
3. **Append, don't overwrite learnings.** Each batch appends to `learnings-raw.md`.
4. **Distillation replaces, raw resets.** Distilled files are rewritten; raw file is reset to header after distillation.
5. **Cursor advances monotonically.** The pagination cursor only moves forward.
6. **Batch size is fixed at 5.** Don't process more or fewer per iteration.
7. **State file is the source of truth.** Always read it first, always write it last.

## Anti-Patterns

- Don't judge PR quality by comment count alone — complex problems attract discussion
- Don't assume silent merges mean perfect PRs — they might mean trivial changes
- Don't ignore rejected/closed-without-merge PRs — they contain the most lessons
- Don't extract patterns from a single PR — wait for distillation across multiple PRs
- Don't commit any state files, learnings, or generated skills to the codex repo
- Don't modify the codex repo's tracked files during analysis
