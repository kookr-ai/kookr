# Post-task lesson capture

Use when: deciding what to write down when a task ends; designing, reviewing or curating a notebook, lessons
file or retrospective that is growing noisy; or deciding how lessons are retrieved, injected, scoped,
promoted and retired.

For `nb` commands see the `notebook-role-reuse` skill; for storage and forgetting see
[memory policy](agent-memory-policy.md).

## Capture and admit

1. **Write a lesson only when an outcome signal exists** (failing test, reviewer correction, build result,
   operator remark); a clean run with no surprise earns none. Only fully correct reflections improved later
   behaviour.
2. **Source lessons from failures and corrections, and target the step that failed.** Success-only lessons
   were never selected. Reflecting on every failure contaminated memory for agents that were already correct.
3. **Store a short abstract rule, not the trajectory.** Insight memory gave positive forward transfer; raw
   trajectories hurt, most on cases the baseline had failed. One lesson is trigger, action and reason, with
   no task-specific names (no PR, branch or file). Abstraction loses detail, so keep the source behind it.
4. **Gate admission on a signal the writer did not choose.** Replay the rule on the task that produced it or
   on a held-out case; do not let the author model judge alone (many judges prefer their own output). Greedy
   "keep it if the score rose" committed 30-42% false edits; a paired sequential gate committed none. Record
   where each lesson came from: poisoning embedded a target behaviour in up to 91% of trials.
5. **Count helped and hurt per lesson, and deprecate instead of deleting.** Unguarded accumulation fell below
   zero-shot while governed curation gained. Condition counts on task type, compare paired with/without runs
   sized for power, and keep the evidence log when merging lessons.
6. **Keep the store small and load only the current task type's lessons** (size costs: see
   [skill library](skill-library-design.md)).
7. **Measure a lesson change under two task orders or seeds.** Gains moved from +1.5% to -4.5% with task
   order ([continual learning](agent-continual-learning.md), regression gate).
8. **Make the decision mandatory in tooling, not prose.** A voluntary "write a lesson or a skip marker" rule
   was indistinguishable from forgetting until completion was gated on it.

## Deliver

9. **Key lesson retrieval on the failure, not the task text alone.** A failure-oriented query beat a naive
   one by about 8 points on one benchmark; no study compares task, error and state keys.
10. **Let retrieval return nothing.** Always-on top-k injected a wrong lesson 17.5% of the time, against 0%
   for an abstaining controller (offline, small). Calibrate any similarity threshold on your own paired runs.
11. **Inject few, narrow rules (rule 3) and measure k per model.** A fixed rule file was flat from 0 to 50
   rules.
12. **Verify delivery live.** A skill had 0 invocations across about 1,300 sessions in a week, and
   transcripts do not record CLAUDE.md content, so check the lesson reaches the running agent.

## Scope, promotion, validity

13. **Assume stored lessons go stale and the agent will not notice; store a checkable precondition and run
   it at use time** (a grep, file path or version string). Models inspected a constraint's provenance in
   about 20% of episodes; a content-free freshness tag did not change behaviour, while forcing one
   verification recovered 61-81 points. The precondition field itself is an inference; no study ablates it.
   For environment facts read live state first
   ([memory policy](agent-memory-policy.md)): work built on a stale checkout recurred, and a "verified" date
   stamp did not stop a handed-off report going stale within a day.
14. **Scope a lesson to where it was learned; promote it to a wider shelf only on recurrence from
   independent tasks or sources.** The same skill helps some task types and hurts others, and recurring
   support drove poisoning success, so count only independent sources. Two independent confirmations is an
   unmeasured starting guess.
15. **Retire on evidence, then re-check what was derived from the retired lesson.** Cascade repair of derived
   entries took stale use from 92-99% to 0% at about 0.6-0.8 of exhaustive repair cost. The retirement
   signal must not be a biased judge: past a false-pass rate of (1 - tau) / 2 (tau is the retirement
   threshold) it disables retirement regardless of data volume, so retire on execution or unit-test
   outcomes.

Do not add machinery before the cheap version fails: a self-written note capped at about 2,000 tokens and
chosen only by scalar outcomes matched costlier loops at about two-thirds fewer tokens. Add each check in
rules 13-15 only where a stale or out-of-scope lesson has actually cost something. A zero-regression gate can
stall progress on numeric-metric loops.

Evidence: kb://agentic-capability-reports/notes/2026-11-14-post-task-lesson-capture-and-curation-policy.md,
kb://agentic-capability-reports/notes/2026-11-14-lesson-retrieval-and-injection-policy.md,
kb://agentic-capability-reports/notes/2026-11-14-lesson-scope-promotion-and-use-time-validity.md
