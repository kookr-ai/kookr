---
name: prompt-optimization-under-budget
group: agent-automation
description: >
  Decide whether to run an automatic prompt, skill or brief optimizer (GEPA, DSPy, a mutate-and-score loop)
  when you can afford only a few hundred evaluation calls, how to spend that budget, and which checks must
  pass before an optimized prompt ships. Covers the headroom check, a noise-sized evaluation slice, the
  selection / audit / test split, item-level reporting, unscored-requirement checks, and cheap baselines
  that often match the optimizer. Use before tuning an agent's system prompt, a skill, a worker brief or a
  CLAUDE.md against a metric, and when reviewing a claim that an optimizer improved a prompt.
keywords: prompt optimization, GEPA, DSPy, MIPRO, reflective optimizer, prompt tuning, skill tuning, eval budget, held-out set, audit set, winner's curse, overfitting, metric gaming, regression, item-level churn, headroom, hand-written baseline, mutation loop
related: autonomous-review-loop, reviewer-distillation-mutate, agent-fleet-orchestration, automation-design, token-efficiency
---

# Prompt optimization under a small evaluation budget

## The idea

An optimizer's own score is the least trustworthy number in the loop. It is measured on the data that
picked the winner, so it is inflated, and a metric that omits a requirement (output length, format,
safety) lets the optimizer break it unseen. With a few hundred model calls you cannot afford a
multi-stage search, so decide first whether to search at all, then spend the budget on measurement
rather than on candidates.

Terms: a *call* is one model run on one data row. The *seed* prompt is the one you start from. The
*reflector* is the model that reads failures and proposes the next prompt. *Churn* is the count of rows
whose outcome changed, up or down. *Paired comparison* scores two prompts on the same rows.

## Rules

1. **Check headroom before searching.** Score the seed prompt on a fixed slice at least twice to measure
   noise. If the seed is near ceiling, or run-to-run noise is as large as the gain you hope for, stop.
   Four optimizer families gave no significant gain on frontier reasoners across 8 tasks (2611.01135),
   though free-text reflective GEPA did gain +0.14 held-out on one financial task, about 0.105 of it real
   instruction refinement; in a chess benchmark 4 of 8 models gained and 21 of 141 runs left the prompt unchanged (2610.00416).
2. **Try the cheap baselines first.** One hand-written edit and a one-line chain-of-thought instruction.
   Chain-of-thought added about 164 prompt tokens against 1,741 and 1,816 for two DSPy optimizers that
   added little beyond it on average, though on one benchmark (IFEval) they beat it by about 3 points
   (2511.20836). A hand-written copy of an optimizer's discovered recipe recovered
   about 57% of its gain (0.047 of 0.083, 2610.12601). No GEPA-chosen harness beat a thinking-off
   baseline (0.620-0.631 vs 0.632, 2610.05533).
3. **At 100-400 calls use one single-stage loop.** In the one paper that tests this regime (2610.05671),
   the multi-stage GEPA returned the seed unchanged in 86% of runs at about 250 calls, against 13% for
   BudgetAPO, a single-stage optimizer; GEPA needed 500 calls to match BudgetAPO at 100 (65.1 vs 64.9).
   BudgetAPO's recipe: a 16-call probe estimates per-row score noise sigma (rows scored 0 to 1); fix one
   slice of `s = clamp((sigma/tau)^2, 10, 30)` rows, where tau = 0.10 is the target standard error; score
   it once and reuse it so each accept or reject compares two prompts on the same rows; 2 candidates per
   step; keep a candidate only if it beats the incumbent. Its ablation gains: adaptive slice +1.8
   points, slice reuse +1.4, reflective operator +1.6. Budget arithmetic: steps =
   (budget - probe - s) / (2s), so 250 calls give 11 steps at s = 10 and 4 at s = 25.
4. **Split three ways and keep one set untouched.** Selection slice, audit set the optimizer never sees,
   final test. With 16 selection items the winner's score exceeded held-out accuracy by 13-20 points; with
   256 items by 1-5 (2610.09239). A 64-item audit (128 evaluations) cut the error of the reported gain
   from 15.5 to 5.7 points. Plan the audit and the loop as one budget: at 250 calls, a probe plus a
   64-item audit leave about 106 calls, enough for roughly 1 step at s = 25 or 4 at s = 10. Shrink the
   audit, or raise the budget, and say which you did; do not skip the audit.
5. **Feed the reflector reasons, not a score.** Per-dimension feedback gave +0.075 held-out reward; a
   scalar reward gave -0.021 (2610.12601, one task).
6. **Score what you ship, not only the target.** On HotpotQA, optimizers raised exact match by 21-34 points and
   citation validity fell 10.7 to 41.6 points, but 98.4% of the new violations were answers cut off by a
   200-token cap (content regression fell below 1 point at 1,024 tokens), so the main risk is a limit the
   metric ignores (2610.13287). Add checks for
   length caps, output format and every rule outside the main metric.
7. **Report items fixed and items broken.** Churn was at least 5x the net change in 5 of 9 configurations,
   and a one-item net change hid up to 17 changed outcomes (2610.19084).
8. **Ship only on audit-set evidence.** The gain must show on data the optimizer never saw, with an
   interval that excludes zero, and beat the hand-written baseline. Even a clean topic-disjoint split
   gave +0.079 on a 0.702 baseline against a validation gain of 0.202 (2610.12601). Re-test after any
   model swap: transfer is uneven (2610.00416).
9. **Pick the acceptance gate for the failure you fear.** No tested gate beat greedy acceptance (keep any
   candidate that scores higher) on score (2610.09239). To stop an agent-editing loop from deleting
   safeguards (for example credential checks), a paired McNemar gate (a significance test on rows
   both prompts were scored on) accepted 0.04 of deliberately planted safeguard deletions against 0.48
   for greedy, in one agent-harness setting; it can still accept deletions that raise task success
   (2610.38392). Strict zero-regression gates can stall the search (2610.13287).
10. **Process rule, no effect size:** a prompt change is not a behavior change until a detection metric
    exists. Add a metric that shows whether the agent did the new thing in the same change.

## Anti-patterns

- Reporting the selection-set score as the result.
- Letting an LLM judge be the only oracle for an optimizer loop: agents that read cached answer keys scored
  100% against a true 68.1% (2609.02246).
- Long procedural scaffolds for weak models: on a 35B model a 5,200-character procedure was neutral or
  harmful while one verification sentence raised pass@1 from 2/20 to 4/20 (tiny sample, a governance scaffold rather
  than an optimizer, 2609.05531).
- Copying an optimized prompt out of the framework runtime without re-measuring (code generation 83% vs
  87.5% baseline, 2507.03620).

## Gaps

No paper tests parallel proposals or Pareto selection at 100-400 calls; batching results (3-4x faster
wall clock, 2610.36774) used 3,000-5,000 calls. No matched-cost comparison of agent-level against
single-prompt optimization. No measured safety regression after optimization. Almost all numbers come from
single papers on the authors' own benchmarks.

Source: a literature survey of 30+ papers, 2026-11-14.
