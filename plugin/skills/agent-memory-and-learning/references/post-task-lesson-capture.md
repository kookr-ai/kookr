# Post-task lesson capture

Use when: deciding what to write down when a task ends; designing, reviewing or curating a notebook,
lessons file or post-task retrospective that is growing noisy; or deciding how lessons are retrieved,
injected, scoped, promoted and retired.

No paper reviewed compares lesson sources, forms or admission gates on a persistent lesson store; each rule rests on
a separate study. For `nb` commands see the `notebook-role-reuse` skill; for storage and forgetting see
[memory policy](agent-memory-policy.md).

## Rules

1. **Write a lesson only when an outcome signal exists** (failing test, reviewer correction, build result,
   operator remark); a clean run with no surprise earns none. Only fully correct reflections improved later
   behaviour, and both tested models stayed below 30% end to end (2605.29225).
2. **Source lessons from failures and corrections, and target the step that failed.** All 11
   validation-selected skills came from conditions containing failures; success-only was never selected
   (2608.02636). Targeted reflection gained 22-27% on initial success over Reflexion-style baselines, and
   reflecting on every failure contaminated memory for agents that were already correct (2608.28264).
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
   ([memory policy](agent-memory-policy.md) rule 6), compare paired with/without runs sized for power, and
   keep the evidence log when merging lessons.
6. **Keep the store small and load only the current task type's lessons.** Removing learned on-demand
   retrieval cut one benchmark from 73.50% to 26.50% (2604.20572); size costs: [skill library](skill-library-design.md) 4.
7. **Measure a lesson change under two task orders or seeds** ([continual learning](agent-continual-learning.md) 1-2):
   gains moved from +1.5% to -4.5% with task order (2608.18066).
8. **Make the decision mandatory in tooling, not prose.** A voluntary "write a lesson or a skip marker" rule
   was indistinguishable from forgetting until completion was gated on it (observed, not measured).

## Delivering lessons

9. **Key lesson retrieval on the failure, not the task text alone.** A failure-oriented query reached
   75.00% Pass@1 against 66.96% for a naive query and 62.50% with no memory on one environment-setup
   benchmark (2609.07357); its ablations are confounded with memory structure, and no paper compares task,
   error and state keys on one memory.
10. **Let retrieval return nothing.** Always-on top-k gave 17.5% false-positive injection against 0.0% for
   an abstaining controller (2604.27283, 200 offline cases, smoke scale). No paper reviewed supports a
   similarity threshold value; calibrate one on your own paired runs.
11. **Inject few, narrow rules (rule 3) and measure k per model.** No k sweep exists; a fixed rule file was
   flat from 0 to 50 rules (2604.11088).
12. **Verify delivery live.** In the author's runs a skill had 0 invocations across about 1,300 sessions in
   a week, and transcripts do not record CLAUDE.md content, so check the lesson reaches the running agent.

## Scope, promotion and validity

13. **Assume stored lessons go stale and the agent will not notice; store a checkable precondition and run
   it at use time** (a grep, file path or version string the agent can run in the current repo). Sixteen
   models inspected a constraint's provenance in about 20% of episodes and made stale-consistent decisions
   in about 75-77% of superseded ones; a content-free freshness tag did not redirect behaviour, while forcing
   one verification onto the stated constraint recovered +61 to +81 points, with an experimenter-known
   critical path (2608.25553). No paper ablates a precondition field; this is an inference. For environment
   facts read live state first ([memory policy](agent-memory-policy.md) rule 8): in the author's runs work
   built on a stale checkout recurred (10 incidents), and a "verified" date stamp did not stop a handed-off
   report going stale within a day.
14. **Scope a lesson to where it was learned; promote it to a wider shelf only on recurrence from
   independent tasks or sources.** The same skill helps some task types and hurts others (per-task masking
   +7.5 points, 2606.15390), and skill reliability depends on skill, bank and domain (2608.22610). Recurring
   support was a main determinant of poisoning success (91.0% and 61.5% embedded at 10% attacker support,
   2608.05563), so count only independent sources. No promotion threshold is measured; two independent
   confirmations is a starting guess.
15. **Retire on evidence, then re-check what was derived from the retired lesson.** One method evicts after
   an evidence floor with a size cap (2605.22148), against rule 5's deprecate-not-delete; they are not
   compared. The retirement signal must not be a biased judge, which disables retirement past a false-pass
   rate of (1 - tau)/2 (2607.07436). Cascade repair of derived entries took stale use from 92.4-99.7% to 0%
   at 0.57-0.76 of exhaustive repair cost (2605.07242, memory stores, not skill libraries). Limit: the
   retirement numbers come largely from one author group, and a maintenance transfer study found no benefit
   (mean -0.09, CI -0.28 to +0.10, 2609.05677).

## Evidence against

- A self-written note chosen only by scalar outcomes, capped at 2,048 tokens, matched costlier loops at
  65.6-71.0% fewer tokens (2611.13524): start cheapest, add machinery only after it fails, and add each
  check in rules 13-15 only where a stale or out-of-scope lesson has actually cost something.
- Reflecting on every episode without outcome feedback kept most of the gain on one embodied benchmark
  (2611.11509), so rule 1 is a cost rule as much as an accuracy rule.
- Acceptance gates did not beat greedy over whole prompt-optimisation runs (-2.1 +/- 1.1 points, p = 0.06),
  and a zero-regression gate can stall progress (2610.09239). Gate evidence is from numeric-metric loops.
- Abstraction loses detail (rule 3 versus [memory policy](agent-memory-policy.md) rule 3).
- Rule 3's "reason" part disagrees with one result: attaching reasoning to rules hurt compliance
  (2611.08644, one self-built 71-scenario benchmark; [preference memory](preference-memory.md) rule 6).

## Gaps

- No controlled failure-only versus success-only arm; no rule-versus-example comparison on matched tasks.
- No gated-versus-ungated ablation on a free-text lesson store.
- No reuse counts for real lesson files.
- No measured effect of dedup, size caps, append-only against edit, or how many lessons to inject.
- No head-to-head of retrieval keys or injection timing; no lesson hit-rate data.
- No ablation of scope tags; no stale rate or half-life for coding lessons; no re-validation study after a
  model or tool upgrade.
