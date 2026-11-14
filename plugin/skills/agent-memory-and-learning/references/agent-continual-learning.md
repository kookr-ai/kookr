# Agent continual learning

Use when: deciding where a deployed agent's ongoing learning lives (memory, skills, prompt or weights) and
how to keep each learned change from regressing earlier tasks, including before fine-tuning a worker on its
own runs or writing new knowledge into weights instead of context.

Learning outside the weights is the cheap, reversible default, but not free of forgetting: more plasticity
(learning new tasks) came with less stability (keeping old ones), mostly when new tasks conflict with old
ones. This guide holds the regression gate for every learned change ([memory](agent-memory-policy.md),
[lessons](post-task-lesson-capture.md), [skills](skill-library-design.md)); for a loop that evolves its own
harness see [agent self-evolution](../../agent-evaluation/references/agent-self-evolution.md).

1. **Gate every learned edit on earlier tasks.** Accept a new memory, skill or prompt edit only if the
   active task improves and held-out earlier task groups do not drop beyond run-to-run noise (measure that
   noise first). Report gains and regressions separately, not one net pass rate: regressions offset about
   60% of gross skill gains in one large study, and a gain smaller than the variance is unproven.
2. **Keep a regression suite of earlier task groups** the learner did not write its lessons or skills from,
   and test in more than one order or seed: interleaving task groups cut one method's gain from +5.8 to
   +0.9 points.
3. **Govern the store.** Retire stale entries and drop what contradicts newer facts; models answered
   consistently with a superseded constraint in about 75% of episodes. Retirement evidence: [skill library
   design](skill-library-design.md); write-time superseding: [memory policy](agent-memory-policy.md). A size
   cap is harmless for retrieval memory, but no source tests a cap as the fix.
4. **Prefer lessons that external feedback confirms** (tests, a teacher, a human edit). Self-feedback skill
   generators scored far below human-authored skills (31% vs 75%) and drifted; teacher feedback improved
   steadily.
5. **Version every edit** so any single one can be reverted.
6. **Change weights only after the harness has plateaued on a measurable constraint** (signals in
   [cheap-worker adaptation](cheap-worker-adaptation.md) Step 3).
7. **If you train, replay old prompts (1-10% of the data) and measure backward transfer** (the change in
   old-task score after learning new tasks). Plain SFT lost about 14 points, vanilla replay at 1% about 4,
   on-policy replay about 2 (needs the old prompts). Report old-task scores, not only the new task.
8. **RL retains more of the base circuit than SFT but adapts slower** (old-task scores were not
   reported), and an RL-initialised model collapsed
   on a second task, so also test plasticity on the next task.
9. **Keep knowledge (facts, not skills) in context or retrieval by default;** a closed-weight model has
   nothing to write to. Keep project facts in a versioned file or retrieval store, and re-derive facts that
   change from the source of truth at task start (a checkout 116 commits behind was fixed by reading the
   fetched default branch, not by changing the model). Move knowledge into weights only when it is stable,
   heavily reused and its prompt tokens are the cost. Weight-written facts are brittle: moving tool
   descriptions into a LoRA cut input 83% but lost general accuracy, and facts stored under one query
   template failed on others. A compiled skill file on a frozen model beat BM25 retrieval.
10. **If you update weights at test time or after, mix in self-distilled targets and treat the update as a
   release:** gate it as in rule 1 and on the side effects in [cheap-worker
   adaptation](cheap-worker-adaptation.md) Step 5. Plain SFT knowledge injection kept 1% of held-out
   capability, a self-distillation mix up to 100%, though it learned few of the new facts. Test-time
   training gained about 5 points at 1.9x
   wall-clock and needed a repetition-aware loss, since naive online updates amplify drift.

Do not trust a "forgets less" LoRA claim without the same baseline; no paper compares LoRA and full
fine-tuning forgetting directly. Choosing training data by short-term gain raises later forgetting.

Evidence: kb://agentic-capability-reports/notes/2026-11-14-weights-vs-memory-for-agent-continual-learning.md,
kb://agentic-capability-reports/notes/2026-11-14-absorbing-new-knowledge-weights-vs-context-at-test-time.md
