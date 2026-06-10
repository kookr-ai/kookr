---
name: oss-pr-distill
description: Distillation phase for oss-pr-lessons playbook — compress raw learnings into repo-specific patterns and update shared general skill
keywords: oss, pr, distill, patterns, generalize, skill, synthesis, open source
related: [oss-pr-threshold, oss-pr-state, oss-pr-critic]
---

# OSS PR Distill

> **Requires:** the `pr-contribution-excellence` skill at `~/.claude/skills/pr-contribution-excellence/SKILL.md` (bundled with the `kookr-toolkit` plugin since 0.5 — see `docs/hooks-setup.md`). If absent, the plugin is not installed; stop and report the missing dependency rather than fabricating distilled patterns.

Read all accumulated raw learnings, identify patterns, and write them to repo-specific and general output files. Generalized version of `codex-pr-distill`.

## When to Use

Invoked when `oss-pr-threshold` returns `DISTILL`.

## Non-Negotiable Rules

| # | Rule | Violation Example | Correct Pattern |
|---|------|-------------------|-----------------|
| 1 | Read ALL raw learnings before distilling | Only reading the latest batch | Read entire learnings-raw.md |
| 2 | Preserve prior distilled content | Overwriting previous distillation | Read existing distilled files, merge new patterns |
| 3 | Separate repo-specific from general patterns | Putting repo-specific convention in general skill | Repo-specific -> patterns.md; General -> pr-contribution-excellence |
| 4 | Reset learnings-raw.md after distillation | Leaving raw file to grow unboundedly | Reset to header template (6 lines) |
| 5 | Update distillation_count in state.json | Forgetting to track | Increment count, set last_distillation_at |
| 6 | Patterns must be evidence-based | "I think PRs should..." | "PRs that {pattern} were {outcome} — seen in #{n1}, #{n2}" |

## Parameters

- **repoFullName**: `owner/repo`
- **repoSlug**: URL-safe slug

## Distillation Process

### Step 1: Read inputs

```bash
SLUG="{{repoSlug}}"
REPO="{{repoFullName}}"

cat ~/.claude/${SLUG}-pr-lessons/learnings-raw.md
cat ~/.claude/skills/pr-contribution-excellence/repo/${SLUG}.md 2>/dev/null || echo "(new file)"
cat ~/.claude/${SLUG}-pr-lessons/learnings-distilled.md 2>/dev/null || echo "(new file)"
cat ~/.claude/skills/pr-contribution-excellence/SKILL.md 2>/dev/null || echo "(new file)"
cat ~/.claude/skills/pr-contribution-excellence/evidence.md 2>/dev/null || echo "(new file)"
```

### Step 2: Identify patterns across batches

Look for:
- **Recurring signals**: Same observation in 3+ PRs
- **Contrasts**: What merged PRs had that rejected ones lacked
- **Maintainer preferences**: Consistent feedback themes
- **Failure modes**: Common rejection reasons
- **Success factors**: Traits of quickly-merged PRs

### Step 3: Classify patterns

| Pattern Type | Output Target | Example |
|-------------|---------------|---------|
| Repo conventions | `pr-contribution-excellence/repo/{repoSlug}.md` | "PRs must pass `cargo clippy --tests`" |
| Repo reviewer preferences | `pr-contribution-excellence/repo/{repoSlug}.md` | "Maintainer X prefers exhaustive match" |
| Repo process rules | `pr-contribution-excellence/repo/{repoSlug}.md` | "Feature PRs need pre-approved issues" |
| General PR patterns | `pr-contribution-excellence/SKILL.md` | "Link issue in first line of body" |
| General review navigation | `pr-contribution-excellence/SKILL.md` | "Address blocking feedback before nits" |
| General scope management | `pr-contribution-excellence/SKILL.md` | "Keep PRs under 300 lines" |

### Step 4: Write repo-specific patterns

Update `~/.claude/skills/pr-contribution-excellence/repo/{repoSlug}.md`:

```markdown
# {repoFullName} Contribution Patterns

Last updated: {date} | Distillation #{count} | Based on {N} PRs analyzed

---

## Repository Conventions
{Patterns about code style, testing, tooling specific to this repo}

## Reviewer Expectations
{What maintainers look for, common feedback themes}

## Process & Workflow
{Contribution process, issue-first requirements, CLA}

## Common Rejection Reasons
{Why PRs get closed without merge}

## Success Patterns
{What gets merged quickly and cleanly}
```

### Step 5: Write general patterns to shared skill

Update `~/.claude/skills/pr-contribution-excellence/SKILL.md` with **universal patterns only** (no evidence base, no repo-specific references). Append evidence and distillation log entries to `~/.claude/skills/pr-contribution-excellence/evidence.md`.

**SKILL.md** should contain only universal rules and patterns:

```markdown
---
name: pr-contribution-excellence
description: Patterns for excellent open-source PR contributions, distilled from analyzing real PRs across repositories
keywords: pr, contribution, review, open source, pull request, code review
related: [[oss-pr-distill]], [[pr-lifecycle]], [[pre-pr-review]]
---

# PR Contribution Excellence

Patterns distilled from analyzing real PRs across multiple repositories.

## Non-Negotiable Rules
| # | Rule | Violation Example | Correct Pattern |
|---|------|-------------------|-----------------|
{Numbered rules distilled from cross-repo observations}

## Patterns
{Detailed universal patterns — no repo-specific refs}

## Anti-Patterns
{Common mistakes observed in rejected PRs}
```

**evidence.md** receives the distillation log and evidence references:

```markdown
## Distillation from {repoFullName} ({date})

### Patterns added/updated
- {pattern} (evidence: PR #{a}, #{b}, #{c})

### Evidence base
- PR #{n}: {what was observed}
```

### Step 6: Update distilled learnings summary

Update `~/.claude/{repoSlug}-pr-lessons/learnings-distilled.md`:

```markdown
## Distillation #{count} ({date})

### New patterns identified
- {pattern 1} (evidence: PR #{a}, #{b}, #{c})

### Patterns reinforced
- {existing pattern} now supported by {N} additional PRs

### Patterns revised
- {old pattern} updated because {new evidence}

---
{Previous distillation entries preserved below}
```

### Step 7: Reset raw learnings

```bash
SLUG="{{repoSlug}}"
REPO="{{repoFullName}}"
cat > ~/.claude/${SLUG}-pr-lessons/learnings-raw.md << EOF
# Raw PR Learnings

Accumulated observations from analyzing closed PRs in ${REPO}.
Each batch appends a section below. When this file exceeds 200 lines, distillation is triggered.

---

EOF
```

### Step 8: Update state

```bash
SLUG="{{repoSlug}}"
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)

cat ~/.claude/${SLUG}-pr-lessons/state.json | jq \
  ".distillation_count += 1 | .last_distillation_at = \"${NOW}\"" \
  > /tmp/state-tmp.json && mv /tmp/state-tmp.json ~/.claude/${SLUG}-pr-lessons/state.json
```

## Dedup Before Adding a Pattern

Before adding any pattern, check the existing corpus for an equivalent:
grep the current skill patterns and `evidence.md` for the pattern's key
phrase. If an equivalent already exists, **strengthen it** — append the new
PR numbers to its evidence entry and tighten its wording if the new
observations justify it — instead of appending a near-duplicate line. The
check is against pattern *text* (the evidence log is chronological and has no
index yet); read the matches you find before deciding new-vs-strengthen.

## Quality Criteria for Distilled Patterns

A good pattern must be:
- **Evidence-based**: Supported by 3+ PR observations
- **Actionable**: Tells the contributor what to DO
- **Specific**: "Link the issue in the first line" not "write good descriptions"
- **Non-obvious**: Don't distill "write tests" — distill repo-specific conventions
- **Falsifiable**: Could be contradicted by future evidence

## Failure Handling

Consistent three-case shape — never guess past a broken state file:

- **Missing `state.json`** — first run: initialize it from the documented schema, then proceed.
- **Malformed `state.json`** — validate before use: `jq empty ~/.claude/{{repoSlug}}-pr-lessons/state.json || { echo "state.json is corrupt — stopping (a default-to-fresh run would re-process every PR)"; exit 1; }`. Stop and report; never default to a fresh state.
- **Empty batch / repo exhausted** — learnings-raw.md missing or has no entries since the last distillation: report "nothing to distill" and stop; never run the compression on an empty corpus (it would fabricate patterns).
