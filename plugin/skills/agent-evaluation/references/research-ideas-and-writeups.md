# Research ideas and write-ups

Use when: an autonomous research agent or loop proposes ideas and you must choose which get compute, or it
produces a write-up, paper or report whose claims you must trust, act on or publish.

The middle of the loop (keep gate, noise floor, uneditable verifier) is in
[autonomous experiment loops](autonomous-experiment-loops.md); this guide covers the two ends.

## Rules

1. **Do not pick ideas by judge-rated novelty.** Experts preferred the author-written research question 78%
   and 56% of the time while LLM judges preferred the model's 82% and 52%; expert-LLM agreement fell as low
   as 22% (2606.12071). Use a judge only for constraint checks and one narrow dimension (agreement with
   human non-obviousness judgments was 72-76%), and rank survivors by running a small version of each idea.
   No study reviewed reports what fraction of generated ideas survive implementation, so budget for most
   to fail.
2. **Do not rate ideas with the model family that wrote them, and calibrate the judge on a human sample.**
   How many human reviews a judge saves depends on how well it tracks humans (figures under **When an LLM
   grades** in the [evaluation method](agent-evaluation-method.md)); at judge-human R-squared 0, extra judge
   ratings do not reduce the human need (2605.16354). Never tune a reviewer on its own agent's reviews:
   rating-6 share rose from 33.4% to 40.0% and rating entropy fell from 2.31 to 2.18 (2609.20942).
3. **Link every claim in a write-up to a stored record, and drop the unlinked ones.** Evidence gating raised
   claim-support precision from 40.58% to 90.06% without a significant change in Pass@80 (2610.19222, one
   HPC domain, 68 queries). Then re-open each cited source: link validity was above 94% but the cited claim
   passed a fact check only 39-77% of the time (2605.06635), so a link that resolves is not support.
4. **Report failed and abandoned runs next to each result.** None of 50 audited agent repositories reports
   failure counts, and reporting rules alone moved scores by up to 20.9 points (2605.12131).
5. **Plant a no-signal case and re-ask under two framings.** With no signal planted, agents claimed an effect
   16-44% of the time against 5% nominal, and one framing sentence moved one model from 32% to 61%
   (2611.04070). One study: it supports building the check, not a measured gate effect.
6. **Do not tell a judge to avoid slop.** Told to, it deleted citations to lower the score (2610.00531).
7. **Put a human at hypothesis choice and at promote** (evidence, from an author-run n = 10 benchmark, under
   **Humans at a few decision points** in [autonomous experiment loops](autonomous-experiment-loops.md)).

Evidence strength: rules 3 and 4 have measured effects; rule 1 rests on one paper; rules 2 and 5 are single
studies.

## Gaps

No survival rate of generated ideas; no fabricated-reference rate in agent-written papers; no head-to-head
of grounded against ungrounded novelty checks (the one ablation found is 2 F1 points, 2602.14367).
