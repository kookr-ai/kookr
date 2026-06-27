---
name: codex-pr-distill
description: Distillation phase for codex-pr-lessons playbook — compress raw learnings into patterns and update skills
keywords: codex, pr, distill, patterns, generalize, skill, synthesis
related: [codex-pr-threshold, codex-pr-state, codex-pr-critic]
---

# Codex PR Distill

> **Requires:** the `pr-contribution-excellence` skill at `~/.claude/skills/pr-contribution-excellence/SKILL.md` (bundled with the `kookr-toolkit` plugin since 0.5 — see `docs/hooks-setup.md`). If absent, the plugin is not installed; stop and report the missing dependency rather than fabricating distilled patterns.

## When to Use

This skill is invoked when `codex-pr-threshold` returns `DISTILL`. It reads all accumulated raw learnings, identifies patterns, and writes them to the appropriate output files.

## Non-Negotiable Rules

| # | Rule | Violation Example | Correct Pattern |
|---|------|-------------------|-----------------|
| 1 | Read ALL raw learnings before distilling | Only reading the latest batch | Read entire learnings-raw.md |
| 2 | Preserve prior distilled content as foundation | Overwriting previous distillation from scratch | Read existing distilled files, merge new patterns |
| 3 | Separate codex-specific from general patterns | Putting "use cargo fmt" in general skill | Codex-specific → repo/openai-codex.md; General → user skill SKILL.md |
| 4 | Reset learnings-raw.md after distillation | Leaving raw file to grow unboundedly | Reset to header template (6 lines) |
| 5 | Update distillation_count in state.json | Forgetting to track distillation | Increment count, set last_distillation_at |
| 6 | Patterns must be evidence-based | "I think PRs should..." | "PRs that {observed pattern} were {merged/rejected} — seen in #{n1}, #{n2}" |

## Distillation Process

### Step 1: Read inputs

```bash
cat ~/.claude/codex-pr-lessons/learnings-raw.md
cat ~/.claude/skills/pr-contribution-excellence/repo/openai-codex.md
cat ~/.claude/codex-pr-lessons/learnings-distilled.md
cat ~/.claude/skills/pr-contribution-excellence/SKILL.md
cat ~/.claude/skills/pr-contribution-excellence/evidence.md
```

### Step 2: Identify patterns across batches

Look for:
- **Recurring signals**: Same observation appearing in 3+ PRs
- **Contrasts**: What merged PRs had that rejected ones lacked
- **Maintainer preferences**: Consistent feedback themes from reviewers
- **Failure modes**: Common reasons for rejection or abandonment
- **Success factors**: Common traits of quickly-merged PRs

### Step 3: Classify patterns

| Pattern Type | Output Target | Example |
|-------------|---------------|---------|
| Codex repo conventions | `repo/openai-codex.md` | "Rust PRs must pass `cargo clippy --tests`" |
| Codex reviewer preferences | `repo/openai-codex.md` | "Maintainer X prefers exhaustive match over if-else" |
| Codex process rules | `repo/openai-codex.md` | "Feature PRs without pre-approved issues get closed" |
| General PR description patterns | User skill SKILL.md | "Link to issue in first line of PR body" |
| General review navigation | User skill SKILL.md | "Address blocking feedback before nits" |
| General contribution etiquette | User skill SKILL.md | "Respond to every review comment, even nits" |
| General scope management | User skill SKILL.md | "Keep PRs under 300 changed lines" |

### Step 4: Write codex-specific patterns

Update `~/.claude/skills/pr-contribution-excellence/repo/openai-codex.md` with the format:

```markdown
# Codex-Specific Contribution Patterns

Last updated: {date} | Distillation #{count} | Based on {N} PRs analyzed

---

## Repository Conventions
{patterns about code style, testing, tooling specific to openai/codex}

## Reviewer Expectations
{patterns about what maintainers look for, common feedback themes}

## Process & Workflow
{patterns about the contribution process, issue-first requirements, CLA}

## Common Rejection Reasons
{patterns about why PRs get closed without merge}

## Success Patterns
{patterns about what gets merged quickly and cleanly}
```

### Step 5: Write general patterns to user-scoped skill

Update `~/.claude/skills/pr-contribution-excellence/SKILL.md` with **only universal patterns** (no evidence entries). Evidence and distillation log entries go to `~/.claude/skills/pr-contribution-excellence/evidence.md`.

SKILL.md format (universal patterns only):

```markdown
---
name: pr-contribution-excellence
description: Patterns for excellent open-source PR contributions, distilled from analyzing real PRs
keywords: pr, contribution, review, open source, pull request, code review
---

## When to Use
When preparing a PR for any open-source project.

## Non-Negotiable Rules
| # | Rule | Violation Example | Correct Pattern |
|---|------|-------------------|-----------------|
{Numbered rules distilled from observations}

## Patterns
{Detailed patterns with evidence references}

## Anti-Patterns
{Common mistakes observed in rejected PRs}
```

evidence.md format (append new entries):

```markdown
## Distillation #{count} ({date})
- {pattern}: evidence from PR #{a}, #{b}, #{c}
```

### Step 6: Update distilled learnings summary

Update `~/.claude/codex-pr-lessons/learnings-distilled.md`:

```markdown
# Distilled PR Learnings

Last updated: {date} | Distillation #{count}

---

## Distillation #{count} ({date})

### New patterns identified
- {pattern 1} (evidence: PR #{a}, #{b}, #{c})
- {pattern 2} (evidence: PR #{d}, #{e})

### Patterns reinforced
- {existing pattern} now supported by {N} additional PRs

### Patterns revised
- {old pattern} updated because {new evidence}

---
{Previous distillation entries preserved below}
```

### Step 7: Reset raw learnings

Reset `~/.claude/codex-pr-lessons/learnings-raw.md` to:

```markdown
# Raw PR Learnings

Accumulated observations from analyzing closed PRs in openai/codex.
Each batch appends a section below. When this file exceeds 200 lines, distillation is triggered.

---

```

### Step 8: Update state

```bash
# Increment distillation_count
# Set last_distillation_at to current ISO timestamp
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)

cat ~/.claude/codex-pr-lessons/state.json | jq \
  ".distillation_count += 1 | .last_distillation_at = \"${NOW}\"" \
  > /tmp/state-tmp.json && mv /tmp/state-tmp.json ~/.claude/codex-pr-lessons/state.json
```

## Quality Criteria for Distilled Patterns

A good distilled pattern must be:
- **Evidence-based**: Supported by observations from at least 3 PRs
- **Actionable**: Tells the contributor what to DO, not just what to know
- **Specific**: "Link the issue in the first line" not "write good descriptions"
- **Non-obvious**: Don't distill "write tests" — distill "snapshot tests with insta crate are preferred over manual assertions in this repo"
- **Falsifiable**: Could be contradicted by future evidence (allows revision)
