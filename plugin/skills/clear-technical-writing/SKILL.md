---
name: clear-technical-writing
description: Write clear technical prose for PRs, changelogs, summaries, and status updates — plain-language intent first, jargon defined, identifiers only after the human explanation. Use when drafting PR bodies, release notes, task summaries, or any agent-written technical text that humans must understand cold.
keywords: technical writing, PR description, changelog, summary, clarity, jargon, plain language, readable, cold reader, PR body, status update, release notes, concise vs cryptic, writing style
related: pre-pr-review, git-commit-discipline, pr-contribution-excellence, pr-review-triage
---

# Clear Technical Writing

Write for a **competent teammate who last touched this area weeks ago** — not for the author of the diff, and not for someone who already has the full subsystem mental model loaded.

**Concise ≠ cryptic.** Cut filler, hedging, and repetition. Do **not** cut the explanations a cold reader needs. A clear longer paragraph beats a short opaque one. Density is not professionalism.

Load this skill whenever you draft a PR body, changelog entry, task summary, release note, or similar technical prose. Pair with `kookr-toolkit:clear-writing-reviewer` when you want a second pass on a finished draft.

## Required shape

### Multi-concept changes

(New metrics, multi-file features, non-obvious bug fixes, behavior changes.)

1. **Intent first (2–4 plain-language sentences).** What problem exists? What changes in product/ops terms? Why does it matter? No function names, constants, or file paths yet.
2. **Define domain terms on first use.** Project-specific or compound jargon gets a short gloss once.
3. **Technical details next.** Exact names, thresholds (constant **and** natural language), wiring, order, repo-relative paths, design tradeoffs.
4. **Verification last.** Commands run and outcomes. Evidence of correctness — not a substitute for intent.

### Tiny changes

Single-file / one-line fixes may stay shorter, but still open with **one** plain-language sentence of intent before any symbol list.

## Hard rules

| # | Rule | Why |
|---|------|-----|
| 1 | Lead with human intent | Reviewers decide whether to care before they open the diff |
| 2 | Gloss jargon once | Compound project terms are not shared context |
| 3 | Prefer full sentences over telegraphic noun stacks | Density without grammar is noise |
| 4 | One new idea per sentence when introducing thresholds or concepts | Stacked clauses overload working memory |
| 5 | Restate numbers in words next to constants | `FOO_MIN = 0.50` alone does not say what happens |
| 6 | Symbol lists only in the technical section | `evaluateX + extractY` is not a summary |
| 7 | Restate issue titles in your own words | Titles are labels, not explanations |
| 8 | Repo-relative paths only in shared text | Machine-local `/home/…` paths do not travel |
| 9 | Keep full technical accuracy | Clarity does not mean dumbing down or omitting IDs |

## Anti-patterns (reject these)

- Leading with "Adds X wired through A / B / C matching D and E patterns."
- A bullet that is only function or constant names.
- One sentence that stacks metric id + threshold + sample floor + routing path + purpose.
- Assuming the reader already knows the subsystem vocabulary.
- "Professional" density that would fail a one-month-cold-reader test.
- Treating "be concise" as permission to omit audience reconstruction.

## Self-check (before shipping)

Could a smart engineer who last saw this code a month ago understand **what changed and why it matters** after one careful read — without opening the diff first?

If not, rewrite the intent block. Do not add more identifiers.

## Worked examples

### Example A — product alert (bad → good)

**Bad:**

> Adds freeSurfaceShare — weekly free-surface share of armed tickers below 50% (armed ≥ 3) pages when free-surface collapses into EDGAR-only.

**Good:**

> We now alert when free data coverage collapses. *Free-surface share* is the fraction of armed tickers that still have free-surface coverage rather than falling back to EDGAR-only sources. If that share drops below 50% while at least three tickers are armed, we fire a product-metric alert on the existing Discord/digest path.
>
> Implementation: `evaluateFreeSurfaceShareAlert` via `PRODUCT_METRIC_FREE_SURFACE_SHARE_MIN` (0.50) and `_MIN_ARMED` (3).

### Example B — multi-item PR summary structure

```markdown
## Summary

<2–4 plain sentences: problem, change, why it matters>

Terms used below:
- *term-a* — one-line gloss
- *term-b* — one-line gloss

## Changes

- Human-readable bullet, then optional (`symbol` / path)
- …

## Verification

\`\`\`
<command>
# outcome
\`\`\`
```

### Example C — tiny fix (still intent-first)

**Bad:** `fix parseHookEvent null branch in hook-file-watcher.ts`

**Good:** Hook file watcher no longer throws when a partial JSONL line arrives mid-write. Fix is a null-safe branch in `parseHookEvent` (`src/server/hook-file-watcher.ts`).

## When writing PR bodies in Kookr

1. Draft against this skill (intent → gloss → details → verification).
2. Mark the PR template prose checklist item (`kookr:check:prose`) when the Summary would pass the cold-reader self-check.
3. Strike that item with a one-line reason only for pure typo / formatting / mechanical renames where a multi-sentence intent block would be noise.
4. Optional: spawn `kookr-toolkit:clear-writing-reviewer` on the draft body before `gh pr create`.

## See also

- Project always-on rules: `CLAUDE.md` / `AGENTS.md` → **Technical writing**
- [[pre-pr-review]] — run this skill when composing the PR description
- [[git-commit-discipline]] — commit subjects stay short; bodies still explain why
- [[pr-contribution-excellence]] — OSS PR description quality
- `kookr-toolkit:clear-writing-reviewer` — second-pass reviewer for dense or multi-concept prose
