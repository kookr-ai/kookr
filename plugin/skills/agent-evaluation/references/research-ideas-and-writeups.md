# Research ideas and write-ups

Use when: an autonomous research agent or loop proposes ideas and you must choose which get compute, or it
produces a write-up, paper or report whose claims you must trust, act on or publish.

The middle of the loop (keep gate, noise floor, uneditable verifier) is in [autonomous experiment
loops](autonomous-experiment-loops.md); this guide covers the two ends.

## Rules

1. **Do not pick ideas by judge-rated novelty.** LLM judges preferred the model-written research question
   where experts preferred the author's, with agreement as low as 22%. Use a judge only for constraint
   checks and one narrow dimension (non-obviousness: 72-76% agreement with humans), and rank survivors by
   running a small version of each idea. Budget for most to fail.
2. **Do not rate ideas with the model family that wrote them, and calibrate the judge on a human sample.**
   How many human reviews a judge saves depends on how well it tracks humans (see **When an LLM grades** in
   the [evaluation method](agent-evaluation-method.md)); at zero agreement extra judge ratings save nothing.
   Never tune a reviewer on its own agent's reviews (ratings drift upward and flatten).
3. **Link every claim in a write-up to a stored record, and drop the unlinked ones.** Evidence gating raised
   claim-support precision from 41% to 90% (one domain). Then re-open each cited source: links resolved
   >94% of the time but the cited claim passed a fact check only 39-77%.
4. **Report failed and abandoned runs next to each result.** None of 50 audited agent repositories reports
   failure counts, and reporting rules alone moved scores up to ~21 points.
5. **Plant a no-signal case and re-ask under two framings.** With no signal planted, agents claimed an effect
   16-44% of the time against 5% nominal, and one framing sentence moved one model from 32% to 61% (one
   study: supports building the check).
6. **Do not reward fewer flagged claims alone, or tell a judge to avoid slop.** Told to, it deleted
   citations to lower the score.
7. **Put a human at hypothesis choice and at promote** (see **Humans at a few decision points** in
   [autonomous experiment loops](autonomous-experiment-loops.md)).

Evidence: kb://agentic-capability-reports/notes/2026-11-14-judging-ai-research-ideas-and-writeups.md
