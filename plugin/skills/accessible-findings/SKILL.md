---
name: accessible-findings
description: Make a findings write-up understandable to a reader NEW to the topic without weakening a single claim — a PR description, results report, journal entry, status update, or any document presenting data, analysis, plots, or tables. Covers the WHOLE artifact, not just figures — every claim, number, table, method, code change, bug/fix, caveat, and decision gets explained in plain words (what it is, what it means, what we expected and why, what we found, why, and so what). Provides the document structure, a general explanation contract for any element, element-specific checklists (a mandatory seven-item per-figure template, plus tables, claims, methods, fixes, decisions), concept- and jargon-glossing, accuracy/honesty guardrails that forbid trading truth for clarity (self-consistency, claim-strength calibration, real-world units, flagged extrapolations, source fidelity), and the PR figure-embedding mechanic. Use before writing any findings artifact and run the self-check before finishing — and whenever a write-up is dense or jargon-first, a plot or table needs explaining, you are asked to make something readable, or a reviewer says it is hard to understand.
keywords: accessible findings, explain results, PR description, results report, findings write-up, journal entry, status update, explain a plot, explain a chart, figure caption, axes explanation, read the plot, table reading key, glossary, jargon, plain language, cold reader, newcomer, bug explanation, claim calibration, over-claiming, real-world units, data visualization explanation, communicate findings
related: clear-technical-writing, communication-quality-review, pre-pr-review, pr-contribution-excellence
---

# Write findings a newcomer can actually understand — all of them, not just the plots

The reader is **a smart person who is new to this sub-topic** — a competent engineer
or scientist who has *not* read the earlier entries, does *not* know the model
codenames, and may *not* know the domain concepts (the precedence effect, ITD, DRR, a
reference equalisation…). Your job is to get the work into that reader's head.
Accessibility and rigor are **not** a trade-off: keep every number, caveat, and
negative result — just explain the concepts first, lead with meaning, and make every
piece legible on its own.

**This applies to the whole artifact, not only the figures.** A crisp plot explanation
wrapped around an obscure headline, an unexplained table, or a bug described only in
jargon (`apply_dtf` / "CTF estimated from the batch") still fails the reader. Treat
*every* substantive element as something to be explained.

The test you must pass (self-check at the end): *a reader who has never heard of this
topic can read the write-up top to bottom and, for every claim, number, plot, table,
method, fix, and decision, say what it is, what it means, and why — without asking you
anything.*

## Required document structure

Write in this order. The point lands before any term of art appears.

1. **What this is about (plain paragraph).** The real-world question in everyday words:
   what we were trying to find out and why it matters for the project's goal. No
   codenames, no undefined terms.
2. **Bottom line (TL;DR).** 2–4 plain sentences: the answer and its one practical
   consequence, before any table or figure.
3. **Background you need (plain-language primer).** Define the handful of domain
   concepts the reader must hold to follow the rest — each ≤2 lines, plain words first,
   ideally an everyday analogy that carries the *real* mechanism. Cover every concept
   the findings rely on (figures *and* prose). See *Glossing* below.
4. **What we evaluated / did.** The experiments or changes in plain terms — what was
   varied, what was measured, or what was built.
5. **How to read the results (shared key).** Define ONCE the conventions the results
   share — a score's scale and its 0/mid/1 meaning, a table's columns and units, any
   coloured bands/regimes, any reference lines — so each result doesn't repeat them.
6. **The findings.** Figures, tables, and claims, each explained with the general
   contract below (plus the element-specific checklist that fits).
7. **So what / decision.** What this changes, the concrete next step or handoff — in
   plain words, explaining *why*.
8. **Details for the record.** What changed in the code and why, any bug/fix (explained,
   not just named), verification (commands + outcome), and a **glossary** of every term
   and codename used.

## The general explanation contract (applies to ANY substantive element)

For every element that carries meaning — a headline claim, a number, a table, a plot,
a method, a bug/fix, a caveat, a decision — a newcomer should come away able to answer:

- **What is it?** In plain words, before any name/codename/symbol.
- **What does it mean / why does it matter?** The real-world reading, not the formal one.
- **What did we expect, and why?** (for a result/claim) — and what a different outcome
  would have looked like, so the reader knows the contrast.
- **What did we actually get?** Tied to the concrete numbers.
- **What explains it?** The mechanism — *why* it came out that way.
- **So what?** The consequence: what we now know, what we can/can't conclude, what it
  implies for the decision or next step.

Not every element needs all six spelled out, but none should be left as bare jargon or
a bare number. A method needs *what we did and why that way*; a bug/fix needs *what went
wrong in plain terms, why it mattered, how it's handled*; a claim needs *what it means
and why*; a number needs *what it means in real-world terms*.

## Element-specific checklists

**A figure / plot (all seven, every figure).** A caption is not enough.
1. **What it shows** (one line — the takeaway).
2. **Axes** — x (name, unit, scale; say if logarithmic) and y (name, unit, scale), then
   every series / colour / line style / shaded band / reference marker on the plot. The
   reader must be able to point at any mark and know what it is.
3. **What the numbers mean** — a value in real-world terms; what 0 / mid / 1 / a dashed
   reference line correspond to physically. ("0.5 = the image is heard dead centre.")
4. **What we expected, and why** — the hypothesis, and what a *different* outcome would
   look like on this very plot.
5. **What we actually see** — the pattern, tied to the numbers and where on the plot.
6. **What explains it** — the mechanism, flagged by how well established it is
   (*measured* here vs *likely* vs *not established*); do not assert an untested internal
   cause, and "unexplained" is an honest answer for a feature you did not run down.
7. **What it means** — the consequence / decision, in units a reader can weigh.

**A table.** Give a reading key: what the rows and columns are, the units, and what a
value means (what 0 vs 1, high vs low, signifies). Then state the pattern it shows and
what it proves — don't drop a table and move on.

**A headline claim / result.** The number(s) + what they mean physically + expected vs
actual + why + consequence. Replace term-of-art shorthand with the plain statement
first ("the image is pulled to the midpoint between the two sources", then the metric).

**A method / experiment.** A short checklist, in plain terms: the **input/stimulus**
(what sound was used), **what was varied** and over what range, **what was measured**
and **how the single reported number is read out** (e.g. how one "heard angle" is taken
from a probability distribution — the peak? the mean?), and the **parameters of each
experiment** (levels, delays, angle pairs — state them *per experiment*, don't let the
reader assume). Define every derived metric by what it computes (e.g. the pull-fraction
formula; what "half-pull delay" is decayed *from* and *to*). Name the real quantity
before the code symbol. **If the source does not specify one of these, say so** ("the
stimulus type is not recorded in the source") rather than inventing it or silently
omitting it.

**A bug / fix / caveat.** What went wrong in **plain terms** (not just the function
name), why it mattered to the result, and how it is handled now — with the number that
shows the impact. (E.g. don't write "`apply_dtf` CTF-from-batch pitfall"; write "the
listener normalises each batch of sounds against their shared spectrum, so judging one
sound alone makes it normalise against itself and destroys the direction cue — a lone
frontal sound then mislocalised by ~100° — so every call includes the full set of
directions as the reference.")

**A decision / next step.** What and why, and who/what it is handed to.

## Accuracy and honesty — never trade truth for clarity (mandatory)

Making a write-up readable must not make it wrong. Accessibility *fails* the moment it
over-claims, smooths away a caveat, or states a guess as a fact — a confident, clear
falsehood is worse than obscure truth. Before you finish, run these checks explicitly:

- **Self-consistency against your own numbers.** Every interpretive/summary sentence
  must be true of the numbers in the same section. If you write "X is not lower than Y",
  check X and Y; if the data says 0.59 → 0.53, the honest sentence is "slightly lower,
  and nowhere near the lead." Re-read each claim beside the figures/tables it summarizes.
- **Calibrate claim strength to the evidence.** Use *proved / shows / demonstrates* only
  for what the data in this write-up directly establishes; use *consistent with /
  suggests / likely / we think* for inferences; say *not tested here* for the rest. If
  you write "proven N ways," count only the items that actually bear on that claim — a
  robustness check or an unrelated sweep is not a proof of a windowing mechanism.
- **Don't assert internal mechanisms you didn't test.** "The model has no X mechanism",
  "these dips are spectral coincidences", "the model reads this cue" — unless measured,
  mark them as the *likely* explanation, or say the cause is not established. A mandatory
  "what explains it" slot is an invitation to fabricate; resist it. "Unexplained" is a
  valid, honest answer for a feature (e.g. an outlier spike) you did not run down.
- **Put derived scores into real-world units before judging them.** A fraction, ratio, or
  normalized score means little to a reader until you convert it (a "pull of 0.24" for
  sources 80° apart is a **~19° image shift**). Do the conversion *before* calling
  something "small", "negligible", or "large", so the adjective is honest.
- **State the conditions a derived quantity was measured under, and flag extrapolations.**
  A budget or rule-of-thumb carries the scope it was measured in (e.g. "measured at one
  delay and one angle pair, equal level"). If you apply it beyond that (to other delays,
  levels, angles), say explicitly that this is an extrapolation. If a number comes from
  an instrument whose behavior you called an artifact elsewhere, note that too.
- **Source fidelity — every concrete fact traces to the source.** Do not add a specific
  detail (a direction, a number, a cause) that is not in the source material. If you add
  an illustration to aid understanding, mark it as illustrative. When the source is vague,
  stay vague (or say "not specified"); do not sharpen it into a false precision.
- **Cross-section consistency.** If two sections give explanations that seem to conflict
  (an "energy-weighted centre" in one place, an "echo-dominated cue" in another),
  reconcile them in the text or name the tension — don't leave the reader to collide with
  it. Fix cross-references (a pointer to "§6.4" must point at the section that supports
  the claim).

## Glossing — explain the science, not just the word

A term of art with no gloss is a wall; a glossed word with no *concept* behind it is
still a wall. The first time a newcomer would trip:

- **Plain-language first, identifier second.** Explain what the thing *is* and *does*
  in everyday words, then give its name/codename. "A trained model that listens to a
  sound and reports which direction it came from — our *synthetic listener*
  (`pooled8_distribution_v2`)."
- **Build intuition for hard concepts** with an analogy that carries the real mechanism
  (an *analysis window* = "each listener only hears a fixed slice of time from the
  sound's start; an echo after that slice simply isn't in what it looks at").
- **Gloss every concept the findings depend on** — figures and prose alike (ITD,
  comb-filtering, a reference equalisation, a regime boundary, an acronym).
- **Gloss project/process vocabulary too, not just the science.** An outsider also trips
  on internal shorthand — "slice 3", issue/PR numbers, a module/tool codename, "the
  owner-ears rule", "learnings #85–88". Give each a one-line plain meaning, and avoid
  overloading one word with two senses (don't use "slice" for both a time-slice and a
  project-phase in the same piece without distinguishing them).
- **Define every term before (or at) its first use in the body** — including derived
  metric names (pull fraction, half-pull delay) and any `code_symbol`. A term that first
  appears mid-report and is only defined in the glossary has already lost the reader.
- Keep a **Glossary** at the end, one line each, and expand internal pointers (a
  journal/entry/issue reference → what it is and where it lives). "None needed" is valid
  only if the piece genuinely uses no jargon.

## Embedding the figures (so they actually render)

- **In a GitHub PR description or an issue/PR comment:** relative image paths do **not**
  render — embed by an absolute raw URL **pinned to the commit SHA** (not the branch,
  which 404s once the branch is deleted on merge). With `git rev-parse HEAD`:
  `![caption](https://github.com/<owner>/<repo>/raw/<commit-sha>/<path>/<file>.png)`.
  (Alternatively, drag-drop upload gives a `user-attachments` URL that also persists.)
- **On a private repo** that raw URL renders for signed-in members viewing in a browser,
  but an anonymous/CLI `curl` of it returns `404` (a false negative, because the web raw
  endpoint uses session-cookie auth) — so **verify figures render in the browser, not
  with curl.**
- **Inside the repo's own `.md` files** (docs, journal entries): keep repo-relative
  paths (e.g. `../figures/x.png`); they render in the file/blob view.
- Make plots legible: titled axes with units, an opaque/light background (a committed
  PNG can't adapt to the viewer's dark theme), accessible colour. Defer to a chart-design
  skill (e.g. `dataviz`) for palette/encoding and **`clear-technical-writing`** for prose.

## Self-check before you finish (do not skip)

Read your draft as the newcomer. Fix it if any is "no":

- Does the opening paragraph explain the *point* with zero undefined jargon?
- Is every domain concept the findings rely on glossed in plain words before it is used?
- **For every figure:** are all seven items answered, and could the reader read its axes
  and say what it proves *unaided*?
- **For every table, headline claim, method, bug/fix, and decision** (not just the
  plots): is it explained per the general contract, or left as bare jargon/numbers?
  Pick the most jargon-dense sentence in each section and confirm you unpacked it.
- **Term audit:** is every term, acronym, metric name, and project/process word defined
  at or before its first use in the body (not only in the glossary)?
- **Accuracy pass (run the "Accuracy and honesty" checks):** does every summary sentence
  match its own numbers? Is each claim's strength calibrated to the evidence (no "proved"
  for the unproven, no untested internals as fact)? Are derived scores converted to real
  units before any "small/large" judgement, and are extrapolations and
  measured-under-which-conditions flagged? Does every concrete fact trace to the source?
  Do cross-references point where they claim, and are conflicting explanations reconciled?
- Did you keep every number, caveat, and negative result from the source?
- Do the embedded figures use the correct absolute (SHA-pinned, for a PR) URL and render?
- **Final claim & fidelity audit:** did you run the whole-document pass below?

## Final claim & fidelity audit (mandatory last pass, over the WHOLE document)

The per-element checks fire section by section; this pass catches what only shows up
*across* the write-up — an inflated word in the summary, two sections that disagree, a
plain-language gloss that quietly added a fact. Do it last, re-reading the finished draft
end to end:

- **Tag and downgrade every strong claim — especially in the TL;DR, "so what", and
  headline.** For each *proved / confirmed / shows / demonstrates / nailed down / N ways*:
  name the specific test behind it and ask *could that test have come out the other way?*
  If not — if it is the headline observation restated, or an indirect/suggestive signal —
  downgrade to *observed / consistent with / suggests / evidence that*. The thing you are
  explaining is not its own proof; "proven N ways" must be N **independent** tests that
  each could have failed (a coarse two-point bracket is "consistent with", not a proof).
  When you downgrade a word, propagate it everywhere that claim appears.
- **Reconcile mechanisms across sections.** List the cause each section gives for the same
  phenomenon. If two differ (e.g. "the image is the energy-weighted average of the two
  directions" vs "the in-window cue is an unphysical echo-gap offset, not a direction"),
  reconcile them or scope each to where its evidence holds — a mechanism shown at one
  condition is not established at all of them. Never leave the reader to hit two
  incompatible stories.
- **Gloss & background fidelity — plain language must not add or bend facts.** Every
  explanatory detail is either traceable to the source, or correct general background
  *marked as such* — and in both cases actually correct. Do not sharpen a vague source
  into a false specific (a "~100° error for a few-stimulus batch" is not "a sound straight
  ahead mislocalised by 100°"); do not rename a thing into something it isn't (a "common
  transfer function" is not "the recording rig"); do not state a physical fact loosely
  (−6 dB is half the amplitude / a quarter of the power, not "half the loudness"). When
  unsure, stay exactly as vague as the source.
- **Expectations must be honest and discriminating.** A "what we expected" must be a
  genuine prior consistent with your own primer, and the experiment must actually be able
  to tell the hypotheses apart. If a condition cannot separate two explanations (a sub-ms
  delay cannot distinguish "energy-weighted" from "precedence", since humans pull toward
  the louder source there too), do not claim it does.
- **Summaries must respect the distribution, not the mean.** Before "stays near X" or
  "never does Y", check the min/max and the per-group/per-subject spread (extremum-first).
  Report the dips and exceptions a regime average hides (a pair that falls mid-range, the
  subjects that don't follow the trend) — they are often the most informative part, and
  omitting them is itself an over-claim.
- **A universal claim must survive its own exceptions.** If you disclose an exception
  anywhere, no headline, TL;DR, reading key, or decision may still assert the universal
  ("never / always / all / none / stays near X / does not Y"). Weaken the universal to
  match the data and scope it ("near centre from ~2 ms, but pulls part-way to the lead at
  1–1.5 ms") — a caveat buried in one section does not license an absolute in another.
  After editing any exception, re-scan the summary surfaces for a now-false absolute.
- **Test every causal attribution against the raw distribution, not the mean.** Before you
  attach a mechanism label to a feature, check that the per-subject/per-group data actually
  fit it: "individual" or "comb-filtering" variation implies the subjects *disagree* at
  that point — if instead 7–8 of 8 show the same dip, it is *systematic*, not individual,
  so say that (and revise whatever claim the label was propping up). Never attach an
  explanation the distribution you already have contradicts.

## Compact worked examples

**A figure** (embedded above its explanation):
> ❌ "The window cross-correlation lag tracks `−delay` then releases to the lead's true
> ITD (`reverb-image-shift-windowlag.png`)."
> ✅ **1. Shows:** the signal-level reason the heard image snaps to the lead.
> **2. Axes:** x = echo delay (ms, log, 0.3→16); y = best-fit time difference between
> the two ears (µs) measured inside the listener's fixed onset window; purple = that
> lag, dotted = "lag = −delay", dashed vertical = window edge (10.7 ms).
> **3. Numbers mean:** ≈−400 µs is the lead's own ear-to-ear delay (a normal head);
> "−delay" means the window is dominated by the gap between direct sound and echo.
> **4. Expected & why:** inside the window the echo's spacing dominates (lag ≈ −delay);
> outside it only the lead is left (lag → the lead's ITD) — a single elbow at the edge.
> **5. Actual:** follows −delay to ~−9000 µs at 9 ms, then jumps to ≈−400 µs past 10.7 ms.
> **6. Explains:** the listener reads a fixed time-slice; inside it the echo corrupts the
> timing cue, outside it the cue is the lead's alone.
> **7. Means:** the "echo threshold" is the window boundary — a measurement artifact, not
> a perceived echo — so the real threshold must come from the listener's ears.

**A non-figure claim** (a bug — same discipline, no plot):
> ❌ "Subject-major judge calls fix an `apply_dtf`/batch pitfall (CTF estimated from the
> batch, so a few-stimulus batch localizes to ~100° error)."
> ✅ "Before reading a sound's direction, the model first removes the *shared* part of the
> spectrum common to all the sounds in the batch it's given (its way of cancelling the
> rig's fixed colouration). If you hand it only one sound, the 'shared' part it removes is
> that sound's *own* spectrum — so it erases the very direction cue it was meant to read,
> and a sound straight ahead gets mislocalised by ~100°. Fix: every call includes the
> subject's full set of measured directions, so the shared-spectrum estimate is correct,
> and we read the sound of interest off the end."

Treat making the work readable — all of it — as part of the work, like keeping the
journal current, interrogating the extrema, and keeping the tests green.
