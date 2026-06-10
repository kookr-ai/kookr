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
| 3 | Separate repo-specific from general patterns | Putting repo-specific convention in the shared corpus | Repo-specific -> `repo/{repoSlug}.md`; universal -> `pr-contribution-excellence/patterns.md` (+ index line in SKILL.md) |
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
cat ~/.claude/skills/pr-contribution-excellence/patterns.md 2>/dev/null || echo "(new file)"
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
| General PR patterns | `pr-contribution-excellence/patterns.md` (+ index line in SKILL.md) | "Link issue in first line of body" |
| General review navigation | `pr-contribution-excellence/patterns.md` (+ index line in SKILL.md) | "Address blocking feedback before nits" |
| General scope management | `pr-contribution-excellence/patterns.md` (+ index line in SKILL.md) | "Keep PRs under 300 lines" |

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

Write to the **three-file structure** (split 2026-06-10):

- **`patterns.md`** — the full pattern/anti-pattern text. A NEW pattern is
  appended at the end of its section with the next sequential stable ID
  (`P{n+1}` / `AP{n+1}`). A REINFORCED pattern is updated **in place** (sharpen
  wording, extend its inline evidence) — never append a near-duplicate.
- **`SKILL.md`** — lean by contract (rules + Pattern Index). Touch it only to
  add a one-line index entry for a new pattern (`- P{n} {name}`) or, rarely, a
  new Non-Negotiable Rule. **Never write pattern bodies into SKILL.md** — that
  is the unbounded growth this structure exists to stop.
- **`evidence.md`** — two parts. The Pattern -> Evidence Index gets a new row
  per new pattern, or — for a reinforced pattern — the new PR refs appended to
  its row and `citations:` incremented (this count is the dedup signal). The
  chronological Distillation Log below it gets one entry per run.

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

Before adding any pattern, check the existing corpus for an equivalent —
cheapest first: scan the Pattern Index in `SKILL.md` and the Pattern ->
Evidence Index in `evidence.md` for the pattern's key phrase, then grep
`patterns.md` for the full text. If an equivalent exists, **reinforce it**:
update the `patterns.md` entry in place, append the new PR refs to its
`evidence.md` row, and increment its `citations:` count. Only a genuinely new
pattern gets a new sequential ID, index line, and evidence row.

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
