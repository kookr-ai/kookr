# Prompt optimization under a small evaluation budget

Use when: deciding whether to tune an agent's system prompt, a skill, a worker brief or a CLAUDE.md with an
automatic optimizer (GEPA, DSPy, a mutate-and-score loop) on a few hundred evaluation calls, or reviewing a
claim that an optimizer improved a prompt.

The optimizer's own score is measured on the data that picked the winner, so it is inflated; spend the
budget on measurement rather than on candidates. The shared keep gate (uneditable verifier, noise floor,
paired keep, held-out split) is in [autonomous experiment loops](autonomous-experiment-loops.md).
Terms: a *call* is one model run on one data row; the *reflector* reads failures and proposes the next
prompt; *churn* is the count of rows whose outcome changed, up or down.

## Rules

1. **Check headroom before searching.** Score the seed prompt on a fixed slice at least twice to measure
   noise. If the seed is near ceiling, or run-to-run noise is as large as the gain you hope for, stop.
   Four optimizer families gave no significant gain on frontier reasoners across 8 tasks (2611.01135),
   though free-text reflective GEPA did gain +0.14 held-out on one financial task, about 0.105 of it real
   instruction refinement.
2. **Try the cheap baselines first.** One hand-written edit and a one-line chain-of-thought instruction.
   Chain-of-thought added about 164 prompt tokens against 1,741 and 1,816 for two DSPy optimizers that
   added little beyond it on average, though on one benchmark (IFEval) they beat it by about 3 points
   (2511.20836). A hand-written copy of an optimizer's discovered recipe recovered about 57% of its gain
   (0.047 of 0.083, 2610.12601).
3. **At 100-400 calls use one single-stage loop.** In the one paper that tests this regime (2610.05671),
   the multi-stage GEPA returned the seed unchanged in 86% of runs at about 250 calls, against 13% for
   BudgetAPO, a single-stage optimizer.
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
6. **Score what you ship, not only the target.** On HotpotQA, optimizers raised exact match by 21-34 points
   and citation validity fell 10.7 to 41.6 points, but 98.4% of the new violations were answers cut off by a
   200-token cap (content regression fell below 1 point at 1,024 tokens), so the main risk is a limit the
   metric ignores (2610.13287). Add checks for length caps, output format and every rule outside the main
   metric.
7. **Report items fixed and items broken.** Churn was at least 5x the net change in 5 of 9 configurations,
   and a one-item net change hid up to 17 changed outcomes (2610.19084).
8. **Ship only on audit-set evidence.** The gain must show on data the optimizer never saw, with an interval
   that excludes zero, and beat the hand-written baseline; validation overstates held-out gains (rule
   **Held-out split** in [autonomous experiment loops](autonomous-experiment-loops.md)). Re-test after any
   model swap: transfer is uneven (2610.00416). Re-measure an optimized prompt copied out of the framework
   runtime (code generation 83% vs 87.5% baseline, 2507.03620).
9. **Pick the acceptance gate for the failure you fear.** No tested gate beat greedy acceptance (keep any
   candidate that scores higher) on score (2610.09239). To stop an agent-editing loop from deleting
   safeguards (for example credential checks), a paired McNemar gate (a significance test on rows
   both prompts were scored on) accepted 0.04 of deliberately planted safeguard deletions against 0.48
   for greedy, in one agent-harness setting; it can still accept deletions that raise task success
   (2610.38392). Strict zero-regression gates can stall the search (2610.13287).
10. **Keep scaffolds for weak models short.** On a 35B model a 5,200-character procedure was neutral or
    harmful while one verification sentence raised pass@1 from 2/20 to 4/20 (tiny sample, a governance
    scaffold rather than an optimizer, 2609.05531).
11. **Process rule, no effect size:** a prompt change is not a behavior change until a detection metric
    exists. Add a metric that shows whether the agent did the new thing in the same change.

## When the system has several prompted roles (lead, workers, judge)

1. **Update the role that failed, not every role.** Rerun a failed task with a hint or corrected output
   injected into one role at a time, latest role first, and edit only the role whose fix resolves it.
   AgentGrad beat MIPROv2, TextGrad and GEPA on 5 benchmarks this way (+11.76 points over no optimization,
   2.5x faster; 2609.08572). Treat the blame as a guess: best step-level attribution accuracy was 42.73%
   (2604.17658), and a trained attributor fell to about 50% held out (2608.28264). Log which role each
   edit touched.
2. **Freeze the protocol; optimize content.** Keep schemas, output formats and tool-call shapes outside the
   optimizer's reach. Naive TextGrad reached 0% stability on a multi-agent pipeline; separating control
   from data reached 100% eventual protocol validity (2609.00621).
3. **Optimize modules sequentially, about 3 rounds each.** Six-module sequential search beat full-prompt
   search on 4 of 5 backbones (Gemma -0.85; 2610.13386). CEPO's best was 3 rounds; 4 lowered accuracy
   (2610.34722).
4. **Gate on previously solved tasks as well as held-out ones.** GEPA reached 72.7% on the final set but
   54.5% on transfer tasks, below the 56.8% baseline; a no-regression optimizer reached 72.7% transfer
   (2607.14004). This pulls against rule 9's warning that strict zero-regression gates can stall the
   search (2610.13287). Use 3 or more runs or shuffled task order (figures in Check 3 of the
   [evaluation method](agent-evaluation-method.md)).
5. **Freeze any judge you optimize against.** Validate it on human or deterministic labels first and keep
   canary cases where a perfect score means cheating: optimizer runs scored 100% on the judge and 68.1% on a
   deterministic check (2609.02246).
6. **Check first that optimization can pay.** Gains shrink with strong sub-agents (2601.14652), and only 5
   of 39 automatically built agent configurations beat human baselines (2606.04455). Compare against the
   single-agent and hand-written baselines before spending budget.

## Gaps

No paper tests parallel proposals or Pareto selection at 100-400 calls; batching results (3-4x faster
wall clock, 2610.36774) used 3,000-5,000 calls. No matched-cost comparison of agent-level against
single-prompt optimization. No head-to-head of attribution-guided, all-role and random-role updates at
matched compute; no sweep against module count; no measured before-and-after for edits to real fleet
briefs. No measured safety regression after optimization. Almost all numbers come from single papers on
the authors' own benchmarks.
