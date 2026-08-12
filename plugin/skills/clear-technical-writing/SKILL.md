---
name: clear-technical-writing
description: Write clear technical prose everywhere — code documentation (docstrings, comments, module/API/reference docs, config comments), design docs and READMEs, PR bodies/changelogs/summaries, AND explanations of genuinely hard ideas (novel algorithms, subtle failure modes, non-obvious tradeoffs). Plain-language intent first, jargon defined, identifiers only after the human explanation; for hard ideas, build intuition with analogies that carry the real mechanism. Use for any writing a human must understand cold.
keywords: technical writing, code documentation, docstring, code comment, API docs, reference docs, README, design doc, PR description, changelog, summary, explaining hard ideas, analogy, intuition, clarity, jargon, plain language, cold reader, concise vs cryptic, writing style, great explainer
related: pre-pr-review, git-commit-discipline, pr-contribution-excellence, pr-review-triage
---

# Clear Technical Writing

Write for a **competent teammate who last touched this area weeks ago** — not the diff author. Assume a capable mind that is simply missing *this* context. **Respect the reader's intelligence: never talk down.** The goal is to leave the reader feeling smart, not to make you look smart.

Good explanation is not decoration on top of understanding — it *is* a deeper form of understanding. A passage you cannot make clear is usually one you have not fully grasped yet; the effort to explain is the effort to understand.

**This applies to *everything* you write, not just human-facing summaries.** A docstring, inline comment, module header, API/reference doc, or config comment is read by exactly that cold teammate — often *while debugging*, with less patience than a PR reviewer has. There is no "internal, so it can be cryptic" tier.

**Concise ≠ cryptic.** Cut filler and repetition; do **not** cut the explanation a cold reader needs. Density is not professionalism.

Use for any technical text: docstrings and code comments, module/API/reference docs, READMEs and design docs, PR bodies, changelogs, summaries — and for explaining hard ideas. Optional second pass: `kookr-toolkit:clear-writing-reviewer`.

## Shape

1. **Intent first** — 2–4 plain sentences (1 for tiny fixes): problem, change, why. No function names, constants, or paths yet.
2. **Gloss jargon once** — project-specific compounds get a short definition on first use.
3. **Technical details next** — names, thresholds in words *and* constants, wiring, repo-relative paths.
4. **Verification last** — commands and outcomes (not a substitute for intent).

### Code documentation

Same principles, adapted to code:

- **Docstrings lead with what and why, not the signature.** The types already state the shape; say what it is *for*. Re-typing the parameter list in English is not documentation.
- **Comments explain intent, not mechanics.** The code already says *what*; a comment earns its place by saying *why* — the constraint, edge case, or non-obvious reason this branch exists. Delete comments that only narrate the next line.
- **Gloss magic numbers in words next to the constant** (`# 0.50 — page when free-surface coverage falls below half`).
- **Module/API/reference docs open with the problem solved and who calls it**, then the exported surface.

## Explaining hard ideas

Most writing just needs the shape above. But when the *idea itself* is hard — a novel algorithm, a subtle race, a non-obvious tradeoff, a design that reshapes the reader's mental model — the intent block is not enough; you have to *build* the idea. These techniques scale with difficulty: a one-line fix gets one sentence; a new consensus protocol earns an analogy and a run-up.

- **Motivate before you formalize.** Show why the problem is hard or interesting *first*, then the solution. Lead the reader to the "aha" in the order a curious mind meets it — do not just assert the result.
- **Concrete before abstract.** One specific, real example first; generalize after. A reader who has seen the mechanism work once can then hold the general rule.
- **Analogies are bridges, not substitutes.** Reach for one when a concept resists direct statement — but it must carry the *real mechanism*, and you must name **where it breaks**. An analogy that quietly replaces the concept is a comfortable lie. Make it as simple as possible, *but no simpler*.
- **Keep the real texture.** Do not sand off the uncertainty, the edge cases, or the reason the thing is hard or elegant. Accuracy and wonder are not in tension — a truthful account of something deep should still feel deep. Say what is *not* yet known.
- **Name the thing precisely once you've earned it.** Intuition first, but then give the real term and the real symbols, so the reader can find it elsewhere. Illuminating ≠ vague.

## Hard rules

- Full sentences over telegraphic noun stacks; one new concept/threshold cluster per sentence.
- Symbol lists only in the technical section — never as the summary.
- An analogy must carry the real mechanism and state where it breaks; never let it stand in for the concept.
- Restate issue titles in your own words; titles are labels, not explanations.
- Shared text uses repo-relative paths only (no `/home/…` or `/Users/…`).
- Keep full technical accuracy — clarity relocates facts, it does not drop them, and never trades truth for a tidy story.

## Anti-patterns

- "Adds X wired through A / B / C matching D…" as the opening.
- Bullets that are only function or constant names.
- One sentence packing metric + threshold + sample floor + path + purpose.
- Formalism (equations, types, protocol steps) dumped before any motivation.
- An analogy that replaces the concept and never says where it breaks; "simplification" that sands off the real difficulty (false clarity).
- Assuming subsystem vocabulary; "be concise" used to skip the explanation the reader actually needs.

## Self-check

Could a smart engineer cold to this subsystem understand **what changed and why** after one careful read — without the diff? For a hard idea: would they come away able to *rebuild the intuition themselves*, with the real terms intact and the analogy's limits clear — not just nodding at a metaphor? If not, rewrite the intent; do not add more identifiers.

## Examples

**Dense product alert → clear**

Bad: `Adds freeSurfaceShare — weekly free-surface share of armed tickers below 50% (armed ≥ 3) pages when free-surface collapses into EDGAR-only.`

Good: We now alert when free data coverage collapses. *Free-surface share* is the fraction of armed tickers still on free-surface sources rather than EDGAR-only. Below 50% with ≥3 armed tickers → product-metric alert on the existing Discord/digest path. Implementation: `evaluateFreeSurfaceShareAlert`, `PRODUCT_METRIC_FREE_SURFACE_SHARE_MIN` (0.50), `_MIN_ARMED` (3).

**Hard idea (analogy as a bridge, not a substitute)**

Flat: `The reconciler orders concurrent writes with vector clocks and resolves conflicts last-writer-wins per key.`

Illuminating: Two people edit the same doc offline; on reconnect, whose change wins? A *vector clock* is each replica keeping a tally of "how many edits I've seen from everyone." Compare two tallies and you can tell whether one edit truly happened *after* another or whether they were concurrent — a genuine conflict. The reconciler uses that ordering; for the rare true conflict it falls back to last-writer-wins per key. *(Where the analogy breaks: the clock tracks causality — "saw the other's edit" — not wall-clock time, so "after" is not "later o'clock.")*

Why it works: the analogy carries the actual mechanism (causal ordering), keeps the real term intact, and marks its own limit instead of leaving a tidy lie.

**Docstring & comment**

Bad:

```python
def evaluate(share, armed):
    # if share < 0.50 and armed >= 3 return True
    return share < 0.50 and armed >= 3
```

Good:

```python
def evaluate(share, armed):
    """Decide whether to page on collapsing free-data coverage.

    `share` is the fraction of armed tickers still on free-surface sources
    (vs. EDGAR-only fallback). Page when it drops below half while at least
    three tickers are armed — a broad collapse, not one-off noise.
    """
    # 0.50 = "less than half of armed tickers still have free coverage".
    # 3-armed floor avoids paging on a single ticker flapping.
    return share < FREE_SURFACE_SHARE_MIN and armed >= MIN_ARMED
```

## Kookr docs & PR bodies

Draft intent → gloss → details → verification; for a docstring or comment, apply the code-documentation rules above; for a hard idea, build the intuition first. Mark `kookr:check:prose` (the PR template's prose checklist item) when the Summary — and any docs the PR adds or changes — passes the self-check; strike it (delete the line with a one-word reason) only for pure typo/rename noise. Optional: spawn `clear-writing-reviewer` before `gh pr create`.

## See also

Always-on: `CLAUDE.md` → **Technical writing**. Related: [[pre-pr-review]], [[git-commit-discipline]], [[pr-contribution-excellence]], `kookr-toolkit:clear-writing-reviewer`.
