# Stateful agent evaluation

Use when: an arm under test carries memory, a notebook or skills that grow from its own finished tasks, and
you must say whether that state helps.

Checks 1-4 of the [evaluation method](agent-evaluation-method.md) still apply. What to store and retrieve
is in [agent memory policy](../../agent-memory-and-learning/references/agent-memory-policy.md); this guide
covers only how to evaluate the state.

## Rules

1. **Run a no-state arm, and reset the state between paired arms.** Hold-out accuracy often matched or fell
   below memory-free baselines while online accuracy rose (+28.1% online at 7.4x tokens; forgetting of
   24-30% after 32 steps on ALFWorld; 2605.15384).
2. **Run at least two task orders (default and shuffled) and 3 or more repeats per cell.** One
   self-improving memory gained +1.5% in the default order and lost 4.5% under shuffled orders; variance
   rose in 17 of 24 cases and best-to-worst gaps reached 10.4 points (2608.18066). That study's best fix was
   p = 0.07 at n = 6, so 3-6 runs show spread, not proof of a small gain.
3. **Build the state on one topic-disjoint split and score on another.** Validation gain was 0.202 against
   +0.079 held out, a 2.6x overstatement (2610.12601).
4. **Report a profile, not a number:** online gain, hold-out gain, forgetting or backward transfer,
   pass-to-fail flips, and the tokens and wall-clock of carrying the state. Raw-trajectory memory gave -2.0
   to -9.5 points forward transfer, abstracted memory +6.5 to +9.0 (2604.27003); test-time training gained
   up to +5.0 points at 1.9x wall-clock (2607.03441).
5. **Attribute per item, then prune.** Regressions offset 59% of gross skill gains across 5,832 paired runs
   (2607.22520); individual skills help some task types and hurt others (2606.15390). Randomized per-task
   masking took about 180 rollouts per model.
6. **Probe stale and poisoned state directly.** A forgetting-aware metric dropped one system from 43.60 to
   15.18 (weekly to quarterly), and 64% of its recommendation errors came from un-forgotten outdated memory
   (2604.20006). Vector memory reached a 0.839 task score yet adopted poisoned memories at 0.609, against 0
   for causal selection (87 examples, 2605.17641).
7. **Do not treat retrieval hits or write counts as benefit.** Static relevance against causal utility was
   rho = -0.026 over 23,322 observations (2607.15253). In the author's runs, lesson logs showed that lessons
   were written, not that they helped.

Evidence against: memory gains are real in tight contexts (+14.5 points over the backbone at 16K,
2605.18421) and on hard splits; the order and variance numbers come from web-agent benchmarks of 267-910
tasks; FinEvo-Bench (2608.06144) reports gains under three shuffled streams with state-reset controls, and
no source reviewed reconciles it with the fragility study (2608.18066); a "+8.9 points" skills result was
null (p = 0.71, CI -6.8 to +24.6, about 60x tokens, 2605.20023) against a no-skill baseline already at
77.8%.

## Gaps

No power analysis for seeds or orderings; almost no forward-transfer, learning-curve or plateau metrics; no
shuffled or irrelevant-memory control; no measured read or apply rate for lessons in coding agents; no
benchmark-contamination study for memory or skill evaluation.
