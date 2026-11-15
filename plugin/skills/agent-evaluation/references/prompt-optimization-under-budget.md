# Prompt optimization under a small evaluation budget

Use when: deciding whether to tune an agent's system prompt, a skill, a worker brief or a CLAUDE.md with an
automatic optimizer (GEPA, DSPy, a mutate-and-score loop) on a few hundred evaluation calls, or reviewing a
claim that an optimizer improved a prompt.

The optimizer's own score is measured on the data that picked the winner, so it is inflated; spend the
budget on measurement, not candidates. Shared keep gate: [autonomous experiment
loops](autonomous-experiment-loops.md). A *call* is one model run on one data row; the *reflector* reads
failures and proposes the next prompt; *churn* is the count of rows whose outcome changed, up or down.

## Rules

1. **Check headroom before searching.** Score the seed prompt on a fixed slice at least twice to measure
   noise. If the seed is near ceiling, or noise is as large as the gain you hope for, stop (four optimizer
   families gave no significant gain on frontier reasoners).
2. **Try the cheap baselines first**: one hand-written edit and a one-line chain-of-thought instruction.
   Chain-of-thought cost ~10x fewer prompt tokens than two DSPy optimizers that added little beyond it. A
   hand-written copy of an optimizer's recipe recovered ~57% of its gain.
3. **At 100-400 calls use one single-stage loop.** At ~250 calls multi-stage GEPA returned the seed
   unchanged in 86% of runs, against 13% for a single-stage optimizer. Its recipe: a 16-call probe estimates
   per-row noise sigma (rows scored 0 to 1); fix one slice of `s = clamp((sigma/tau)^2, 10, 30)` rows (tau =
   0.10, the target standard error); score it once and reuse it so every accept or reject compares two
   prompts on the same rows; 2 candidates per step; keep a candidate only if it beats the incumbent. Steps =
   (budget - probe - s) / (2s): 11 steps at s = 10, 4 at s = 25 for 250 calls.
4. **Split three ways and keep one set untouched**: selection slice, audit set the optimizer never sees,
   final test. The winner overshot held-out accuracy by 13-20 points with 16 selection items, 1-5 with 256.
   A 64-item audit cut the reported-gain error from ~15 to ~6 points. At 250 calls a probe plus a 64-item
   audit (128 evaluations) leave ~106 calls (about 1 step at s = 25, 4 at s = 10). Shrink the audit or raise the budget and
   say which; do not skip the audit.
5. **Feed the reflector reasons, not a score.** Per-dimension feedback gained held-out reward; a scalar
   reward lost it (one task).
6. **Score what you ship, not only the target.** Optimizers raised exact match 21-34 points while citation
   validity fell 11-42 points, almost all from answers cut off by a 200-token cap. Add checks for length
   caps, output format and every rule outside the main metric.
7. **Report items fixed and items broken.** Churn was at least 5x the net change in 5 of 9 configurations; a
   one-item net change hid up to 17 changed outcomes.
8. **Ship only on audit-set evidence.** The gain must show on data the optimizer never saw, with an interval
   excluding zero, and beat the hand-written baseline (see **Held-out split** in [autonomous experiment
   loops](autonomous-experiment-loops.md)). Re-test after any model swap (transfer is uneven) and after
   copying an optimized prompt out of the framework runtime (one case fell below baseline).
9. **Pick the acceptance gate for the failure you fear.** No tested gate beat greedy acceptance on score. To
   stop an agent-editing loop from deleting safeguards (credential checks), a paired McNemar gate accepted
   4% of planted safeguard deletions against 48% for greedy, but can still accept deletions that raise task
   success. Strict zero-regression gates can stall the search.
10. **Keep scaffolds for weak models short.** On a 35B model a 5,200-character procedure was neutral or
    harmful while one verification sentence helped (tiny sample).
11. **A prompt change is not a behavior change until a detection metric exists.** Add a metric showing
    whether the agent did the new thing in the same change.

## When the system has several prompted roles (lead, workers, judge)

1. **Update the role that failed, not every role.** Rerun a failed task with a hint or corrected output
   injected into one role at a time, latest role first, and edit only the role whose fix resolves it (beat
   MIPROv2, TextGrad and GEPA; ~12 points over no optimization, 2.5x faster). Treat blame as a guess (best
   step-level attribution accuracy 43%); log which role each edit touched.
2. **Freeze the protocol; optimize content.** Keep schemas, output formats and tool-call shapes outside the
   optimizer's reach (naive TextGrad hit 0% stability on a multi-agent pipeline).
3. **Optimize modules sequentially, about 3 rounds each**; a fourth round lowered accuracy.
4. **Gate on previously solved tasks as well as held-out ones.** GEPA reached 73% on the final set but 55%
   on transfer tasks, below the 57% baseline; a no-regression optimizer reached 73% transfer. This pulls
   against rule 9's stall warning: use 3+ runs or shuffled task order (Check 3 of the [evaluation
   method](agent-evaluation-method.md)).
5. **Freeze any judge you optimize against.** Validate it on human or deterministic labels first and keep
   canary cases where a perfect score means cheating (runs scored 100% on the judge, 68% on a deterministic
   check).
6. **Check first that optimization can pay.** Gains shrink with strong sub-agents, and only 5 of 39 built
   configurations beat human baselines. Compare against single-agent and hand-written baselines first.

Evidence: kb://agentic-capability-reports/notes/2026-11-14-when-automatic-prompt-optimization-pays-off-tight-budget.md, kb://agentic-capability-reports/notes/2026-11-14-optimizing-multi-role-agent-prompts-jointly-or-per-role.md
