---
name: post-task-lesson-capture
group: design-analysis
description: >
  Decide what an agent should write down when a task ends, and how to gate and curate the lesson store so
  later tasks improve instead of being misled. Covers when to write a lesson at all, failure versus success
  sources, abstract rule versus raw trajectory, who may judge a lesson, replay gating before admission, vote
  and deprecate curation, narrow loading, and measuring gains across task orders. Use when designing or
  reviewing a notebook, lessons file or post-task retrospective, or when a lesson store is growing noisy.
keywords: lessons, reflection, retrospective, notebook, nb, post-task, curation, admission gate, voting, negative transfer, coding agent
related: notebook-role-reuse, self-reflect, agent-fleet-orchestration
---

# Post-task lesson capture

No paper in the local KBs compares failure-only against success-only lessons, abstract rules against worked
examples, or gated against ungated admission on a persistent lesson store. These rules come from separate
studies, so each carries its own evidence and caveat. Source report: `agentic-capability-reports` note
`2026-11-14-post-task-lesson-capture-and-curation-policy`. For the `nb` commands, see [[notebook-role-reuse]].

## Rules

1. **Write a lesson only when an outcome signal exists** (a failing test, a reviewer correction, a build
   result, an operator remark). A clean run with no surprise earns no lesson. Only fully correct reflections
   improved later behaviour, and both tested models stayed below 30% end to end (2605.29225); 90% of
   prompt-level self-critiques were boilerplate (2605.05737).
2. **Source lessons from failures and corrections, and target the step that failed.** All 11 validation-
   selected skills came from conditions containing failures; success-only was never selected (2608.02636).
   Targeted reflection gained 22%, 26% and 27% on initial success over Reflexion-style baselines (2608.28264).
   A recovery mechanism gave nothing when the baseline already succeeded (2604.14399).
3. **Store a short abstract rule, not the trajectory.** Insight memory gave +6.5 to +9.0 points forward
   transfer; raw trajectories gave -2.0 to -9.5 points, and -26.1 on cases the baseline had failed
   (2604.27003). One lesson is trigger, action and reason, with no task-specific names.
4. **Gate admission on a signal the writer did not choose.** Replay the rule on the task that produced it or on
   a held-out case, and do not let the author model judge alone (6 of 20 judge models were self-preferring,
   2604.22891). Greedy "keep it if the score rose" committed 30-42% false and 10-33% harmful edits; a paired
   sequential gate committed none (2606.08106). Record where each lesson came from: a poisoning pilot embedded
   its target behaviour in up to 91.0% of trials (SkillClaw; 61.5% on Trace2Skill, 2608.05563).
5. **Count helped and hurt per lesson, and deprecate instead of deleting.** Unguarded accumulation fell 4.9
   points below zero-shot while governed curation gained 5.3 points (2606.17591). Counters tracked true utility
   at rho = 0.89 in a synthetic setting but only about -0.33 when task difficulty confounded the signal, so
   condition votes on task type (2604.12007).
6. **Keep the store small and load it narrowly.** Load the lessons for the current task type, not the whole
   list. Regressions offset 59% of gross skill gains (2607.22520), and each doubling of a skill library cost
   about 3 points (2605.16508). Removing learned on-demand retrieval cut one benchmark from 73.50% to 26.50%
   success (2604.20572).
7. **Measure a lesson change under two task orders or seeds.** Memory gains moved from +1.5% to -4.5% when task
   order changed (2608.18066), and a +0.02 gain sat inside run-to-run noise (2608.04003). Treat gains smaller
   than the variance as unproven.
8. **Make the decision mandatory in tooling, not prose.** A voluntary "write a lesson or a skip marker" rule
   was indistinguishable from forgetting until completion was gated on it. This is an operational observation
   from the operator's own lesson KB (`agent-task-lessons`), not a measured effect.

## Evidence against

- A self-written note chosen only by scalar outcomes, capped at 2,048 tokens, matched costlier loops at
  65.6-71.0% fewer tokens (2611.13524). Start with the cheapest version and add machinery only after it fails.
- Reflecting on every episode with no outcome feedback kept most of the gain on one embodied benchmark
  (2611.11509), so rule 1 is a cost rule as much as an accuracy rule.
- Acceptance gates did not beat greedy over whole prompt-optimisation runs (-2.1 +/- 1.1 points, p = 0.06), and
  a zero-regression gate can stall progress (2610.09239). Gate evidence is from numeric-metric loops.
- Abstraction loses detail: extracted facts kept 80.8% of the information against 95.3% for raw text
  (2605.19952).

## Anti-patterns

- Appending a lesson to every task, including clean ones.
- Storing the transcript, or a lesson that names a PR, branch or file.
- A lesson that the author model both writes and approves.
- One monolithic list loaded into every prompt.
- Merging many lessons into one rewrite without keeping the evidence log.
- Counting a gain from one task order as proof.

## Gaps

No controlled failure-only versus success-only arm. No rule-versus-example comparison on matched tasks. No
gated-versus-ungated ablation on a free-text lesson store. No measured effect of dedup, size caps or
append-only against edit. No sweep of how many lessons to inject. No reuse counts for real lesson files.
