# Post-task lesson capture

Use when: deciding what to write down when a task ends, or designing, reviewing or curating a notebook,
lessons file or post-task retrospective that is growing noisy.

No paper compares lesson sources, forms or admission gates on a persistent lesson store; each rule rests on
a separate study. For `nb` commands see the `notebook-role-reuse` skill; for storage and forgetting see
[memory policy](agent-memory-policy.md).

## Rules

1. **Write a lesson only when an outcome signal exists** (failing test, reviewer correction, build result,
   operator remark); a clean run with no surprise earns none. Only fully correct reflections improved later
   behaviour, and both tested models stayed below 30% end to end (2605.29225).
2. **Source lessons from failures and corrections, and target the step that failed.** All 11
   validation-selected skills came from conditions containing failures; success-only was never selected
   (2608.02636). Targeted reflection gained 22-27% on initial success over Reflexion-style baselines
   (2608.28264).
3. **Store a short abstract rule, not the trajectory.** Insight memory gave +6.5 to +9.0 points forward
   transfer; raw trajectories gave -2.0 to -9.5, and -26.1 on cases the baseline had failed (2604.27003).
   One lesson is trigger, action and reason, with no task-specific names (no PR, branch or file).
4. **Gate admission on a signal the writer did not choose.** Replay the rule on the task that produced it or
   on a held-out case, and do not let the author model judge alone (6 of 20 judge models were
   self-preferring, 2604.22891). Greedy "keep it if the score rose" committed 30-42% false and 10-33%
   harmful edits; a paired sequential gate committed none (2606.08106). Record where each lesson came from:
   a poisoning pilot embedded its target behaviour in up to 91.0% of trials (SkillClaw, 2608.05563).
5. **Count helped and hurt per lesson, and deprecate instead of deleting.** Unguarded accumulation fell 4.9
   points below zero-shot while governed curation gained 5.3 (2606.17591). Condition counts on task type
   ([memory policy](agent-memory-policy.md) rule 6) and keep the evidence log when merging lessons.
6. **Keep the store small and load only the current task type's lessons.** Removing learned on-demand
   retrieval cut one benchmark from 73.50% to 26.50% (2604.20572); size costs: [skill library](skill-library-design.md) 4.
7. **Measure a lesson change under two task orders or seeds** ([continual learning](agent-continual-learning.md) 1-2).
8. **Make the decision mandatory in tooling, not prose.** A voluntary "write a lesson or a skip marker" rule
   was indistinguishable from forgetting until completion was gated on it (observed, not measured).

## Evidence against

- A self-written note chosen only by scalar outcomes, capped at 2,048 tokens, matched costlier loops at
  65.6-71.0% fewer tokens (2611.13524): start cheapest, add machinery only after it fails.
- Reflecting on every episode without outcome feedback kept most of the gain on one embodied benchmark
  (2611.11509), so rule 1 is a cost rule as much as an accuracy rule.
- Acceptance gates did not beat greedy over whole prompt-optimisation runs (-2.1 +/- 1.1 points, p = 0.06),
  and a zero-regression gate can stall progress (2610.09239). Gate evidence is from numeric-metric loops.
- Abstraction loses detail (rule 3 versus [memory policy](agent-memory-policy.md) rule 3).

## Gaps

- No controlled failure-only versus success-only arm; no rule-versus-example comparison on matched tasks.
- No gated-versus-ungated ablation on a free-text lesson store.
- No reuse counts for real lesson files.
- No measured effect of dedup, size caps, append-only against edit, or how many lessons to inject.
