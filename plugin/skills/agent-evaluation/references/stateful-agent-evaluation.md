# Stateful agent evaluation

Use when: an arm under test carries memory, a notebook or skills that grow from its own finished tasks, and
you must say whether that state helps.

Checks 1-4 of the [evaluation method](agent-evaluation-method.md) still apply. What to store and retrieve:
[agent memory policy](../../agent-memory-and-learning/references/agent-memory-policy.md); this guide covers
only how to evaluate the state.

## Rules

1. **Run a no-state arm, and reset the state between paired arms.** Hold-out accuracy often matched or fell
   below memory-free baselines while online accuracy rose (+28% online at 7x tokens; 24-30% forgetting after
   32 steps).
2. **Run at least two task orders (default and shuffled) and 3 or more repeats per cell.** One memory gained
   +1.5% in default order and lost 4.5% when shuffled; best-to-worst gaps reached ~10 points. 3-6 runs show
   spread, not proof of a small gain.
3. **Build the state on one topic-disjoint split and score on another.** Validation gain overstated held-out
   gain ~2.6x.
4. **Report a profile, not a number:** online gain, hold-out gain, forgetting or backward transfer,
   pass-to-fail flips, and the tokens and wall-clock of carrying the state. Raw-trajectory memory hurt
   forward transfer (-2 to -9.5 points); abstracted memory helped (+6.5 to +9).
5. **Attribute per item, then prune.** Regressions offset ~59% of gross skill gains; individual skills help
   some task types and hurt others. Randomized per-task masking took ~180 rollouts per model.
6. **Probe stale and poisoned state directly.** A forgetting-aware metric dropped one system from 44 to 15
   (weekly to quarterly), 64% of its errors from un-forgotten outdated memory; vector memory adopted
   poisoned memories at 0.61 against 0 for causal selection.
7. **Do not treat retrieval hits or write counts as benefit.** Static relevance did not track causal utility
   (rho ~0). Lesson logs show lessons were written, not that they helped.

Evidence: kb://agentic-capability-reports/notes/2026-11-14-evaluating-agents-with-evolving-memory-or-skills.md
