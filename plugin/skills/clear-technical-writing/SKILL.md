---
name: clear-technical-writing
description: Write clear technical prose everywhere — code documentation (docstrings, comments, module/API/reference docs, config comments), design docs and READMEs, PR bodies/changelogs/summaries, AND explanations of genuinely hard ideas (novel algorithms, subtle failure modes, non-obvious tradeoffs). Plain-language intent first, jargon defined, identifiers only after the human explanation; for hard ideas, build intuition with analogies that carry the real mechanism. Use for any writing a human must understand cold.
keywords: technical writing, code documentation, docstring, code comment, API docs, README, design doc, PR description, changelog, explaining hard ideas, analogy, intuition, clarity, jargon, plain language, cold reader, concise vs cryptic
related: pre-pr-review, git-commit-discipline, pr-contribution-excellence, pr-review-triage
---

# Clear Technical Writing

Six weeks from now someone competent — often **you**, or an agent with no
memory of this session — will open this PR or function because something
broke. Every identifier will still be there. The *story* will not. Rebuilding
that story from the diff is a tax on the *cold reader* — paid on every visit.
Pay it once, at write time, while the context is still free.

That is not niceness. A passage you cannot make clear is usually one you have
not finished understanding. Explaining is how you finish.

Write for a **teammate last here weeks ago**. Never talk down. There is no
"internal, so cryptic" tier — a docstring is read while debugging, with less
patience than a PR. **Concise ≠ cryptic:** cut filler, not the explanation
the cold reader needs. Density is not professionalism.

Optional second pass: `kookr-toolkit:clear-writing-reviewer`.

## Shape

1. **Intent first** — 2–4 plain sentences (1 for tiny fixes): problem, change, why. No function names, constants, or paths yet.
2. **Gloss jargon once** — project-specific compounds get a short definition on first use.
3. **Technical details next** — names, thresholds in words *and* constants, wiring, repo-relative paths.
4. **Verification last** — commands and outcomes (not a substitute for intent).

### Code documentation

- **Docstrings lead with what and why, not the signature.** Types already state the shape; say what it is *for*.
- **Comments explain intent, not mechanics.** The code already says *what*; a comment earns its place by saying *why*. Delete comments that only narrate the next line.
- **Gloss magic numbers in words next to the constant** (`# 0.50 — page when free-surface coverage falls below half`).
- **Module/API docs open with the problem solved and who calls it**, then the exported surface.

## Explaining hard ideas

When the *idea itself* is hard — a novel algorithm, a subtle race, a tradeoff that reshapes the mental model — the intent block is not enough; you have to *build* the idea.

- **Motivate before you formalize.** Show why the problem is hard first, then the solution. Lead the reader to the aha in the order a curious mind meets it.
- **Concrete before abstract.** One real example first; generalize after.
- **Analogies are bridges, not substitutes.** They must carry the *real mechanism*, and you must name **where they break**. As simple as possible, *but no simpler*.
- **Keep the real texture.** Do not sand off uncertainty or the reason the thing is hard. Say what is *not* yet known.
- **Name the thing precisely once you've earned it.** Intuition first, then the real term so the reader can find it elsewhere.

## Hard rules

- Full sentences; one new concept/threshold cluster per sentence.
- Symbol lists only in the technical section — never as the summary.
- Restate issue titles in your own words.
- Shared text uses repo-relative paths only (no `/home/…` or `/Users/…`).
- Clarity relocates facts; it does not drop them.

## Anti-patterns

- "Adds X wired through A / B / C matching D…" as the opening.
- Bullets that are only function or constant names.
- One sentence packing metric + threshold + sample floor + path + purpose.
- Formalism dumped before any motivation.
- An analogy that replaces the concept; "simplification" that sands off the real difficulty.
- "Be concise" used to skip the explanation the reader actually needs.

## Self-check

Could a smart engineer cold to this subsystem understand **what changed and why** after one careful read — without the diff? For a hard idea: could they *rebuild the intuition*, with the real terms intact and the analogy's limits clear? If not, rewrite the intent; do not add more identifiers.

## Examples

**Dense product alert → clear**

Bad: `Adds freeSurfaceShare — weekly free-surface share of armed tickers below 50% (armed ≥ 3) pages when free-surface collapses into EDGAR-only.`

Good: We now alert when free data coverage collapses. *Free-surface share* is the fraction of armed tickers still on free-surface sources rather than EDGAR-only. Below 50% with ≥3 armed tickers → product-metric alert on the existing Discord/digest path. Implementation: `evaluateFreeSurfaceShareAlert`, `PRODUCT_METRIC_FREE_SURFACE_SHARE_MIN` (0.50), `_MIN_ARMED` (3).

**Hard idea (analogy as a bridge)**

Flat: `The reconciler orders concurrent writes with vector clocks and resolves conflicts last-writer-wins per key.`

Illuminating: Two people edit the same doc offline; on reconnect, whose change wins? A *vector clock* is each replica keeping a tally of "how many edits I've seen from everyone." Compare two tallies and you can tell whether one edit truly happened *after* another or whether they were concurrent. The reconciler uses that ordering; true conflicts fall back to last-writer-wins per key. *(Breaks: the clock tracks causality — "saw the other's edit" — not wall-clock time.)*

**Docstring & comment**

Bad: `def evaluate(share, armed):  # if share < 0.50 and armed >= 3 return True`

Good:

```python
def evaluate(share, armed):
    """Decide whether to page on collapsing free-data coverage.

    `share` is the fraction of armed tickers still on free-surface sources
    (vs. EDGAR-only fallback). Page when it drops below half while at least
    three tickers are armed — a broad collapse, not one-off noise.
    """
    # 0.50 = less than half of armed tickers still have free coverage.
    # 3-armed floor avoids paging on a single ticker flapping.
    return share < FREE_SURFACE_SHARE_MIN and armed >= MIN_ARMED
```

## Kookr docs & PR bodies

Draft intent → gloss → details → verification. Mark `kookr:check:prose` when the Summary (and any docs this PR touches) passes the self-check; strike it only for typo/rename noise. Optional: spawn `clear-writing-reviewer` before `gh pr create`.

## See also

Always-on: `CLAUDE.md` → **Technical writing**. Related: [[pre-pr-review]], `kookr-toolkit:clear-writing-reviewer`.
