# Agent continual learning

Use when: deciding where a deployed agent's ongoing learning lives (memory, skills, prompt or weights) and
how to keep each learned change from regressing earlier tasks, including before fine-tuning a worker on its
own runs or writing new knowledge into weights instead of context.

Learning outside the weights is the cheap, reversible default, but not free of forgetting: in the one paper
measuring it on three self-modifying harness methods, more plasticity (learning new tasks) came with less
stability (keeping old ones), and damage depended on how much new tasks conflict with old ones (topic drift
was near zero). This guide holds the regression gate for every learned change
([memory](agent-memory-policy.md), [lessons](post-task-lesson-capture.md),
[skills](skill-library-design.md)); for a loop that evolves its own harness see [agent
self-evolution](../../agent-evaluation/references/agent-self-evolution.md).

## Rules

1. **Gate every learned edit on earlier tasks.** Accept a new memory, skill or prompt edit only if the
   active task improves and held-out earlier task groups do not drop beyond run-to-run noise (measure that
   noise first; the sources give no tolerance). Report gains and regressions separately, not one net pass
   rate. After a conflicting task block, BFCL-Miss accuracy fell 13.0 points (GEPA) and 10.2 (Meta-Harness)
   (2610.25858); across 5,832 paired runs, regressions offset 59% of gross skill gains (2607.22520). Treat a
   gain smaller than the variance as unproven: a +0.02 gain sat inside run-to-run noise (2608.04003).
2. **Keep a regression suite of earlier task groups** the learner did not write its lessons or skills from,
   and test in more than one order (or seed): interleaving task groups cut one method's gain from +5.8 to
   +0.9 points (2610.25858).
3. **Govern the store.** Retire stale entries and drop what contradicts newer facts; models gave answers
   consistent with a superseded constraint in 75-77% of episodes (2608.25553). Retirement evidence: [skill
   library design](skill-library-design.md) rule 6; write-time superseding: [memory
   policy](agent-memory-policy.md) rule 5. A size cap is harmless for retrieval memory (5,000 entries 70.8%
   vs 71.2% unlimited, 2605.10094), but no source tests a cap as the fix.
4. **Prefer lessons that external feedback confirms** (tests, a teacher, a human edit). The best
   self-feedback skill generator reached 31.08% average accuracy against 74.50% for human-authored skills,
   and self-feedback loops drifted; teacher feedback improved steadily, with no figure given (2604.20087).
5. **Version every edit** so any single one can be reverted (an inference from rules 1-3, not measured).
6. **Change weights only after the harness has plateaued on a measurable constraint** (an inference; signals
   and evidence in [cheap-worker adaptation](cheap-worker-adaptation.md) Step 3).
7. **If you train, replay old prompts (1-10% of the data) and measure backward transfer** (BWT, the change
   in old-task score after learning new tasks). On a 7B model over 8 sequential tasks, plain SFT had BWT
   -13.93, vanilla replay at a 1% ratio -4.27, on-policy replay -2.29 (about 32 GPU-hours on 8 H100s, needs
   the old prompts) (2605.29495). Report old-task scores, not only the new task.
8. **RL retains more of the base circuit than SFT but adapts slower.** Circuit retention was 72.5% against
   59.0% on one 3B model and one task; old-task scores were not reported (2605.28860). An RL-initialised 8B
   model collapsed to about 0% on a second task (2605.12484), so also test plasticity on the next task.
9. **Keep knowledge (facts, not skills) in context or retrieval by default;** a closed-weight model has
   nothing to write to. Keep project facts in a versioned file or retrieval store, and re-derive facts that
   change from the source of truth at task start (in the author's runs a checkout 116 commits behind and a
   stale wrapper that hid a merge gate were both fixed by reading the fetched default branch, not by changing
   the model; stale-memory rejection: [memory policy](agent-memory-policy.md) rule 5). Move knowledge into
   weights only when it is stable, heavily reused and its prompt tokens are the cost. Weight-written facts
   are brittle: tool descriptions moved into a LoRA cut input 82.6% but kept only 61.3-79.8% of general
   multiple-choice accuracy (2605.17774); facts stored under one query template scored 91-100% on the same
   queries and 42-100% on others (2510.08734); against a strong prior, deep-conflict accuracy was 46.4% and
   53.6% on two models (2604.23750, one benchmark). The simple baseline is often enough: retrieval-style
   memory used 658 prompt tokens against 23,265 (2510.23730), and a compiled skill file on a frozen Claude
   model answered 20/20 where BM25 got 15-17 (2609.00453).
10. **If you update weights at test time or after, mix in self-distilled targets and treat the update as a
   release:** gate it as in rule 1 and on the side effects in [cheap-worker
   adaptation](cheap-worker-adaptation.md) Step 5. Plain SFT knowledge injection kept 1% of held-out
   capability, a self-distillation mix up to 100%, though SimpleQA train accuracy was only 10.5%
   (2605.16865). Test-time training gained +5.0 points on ALFWorld (50.7 to 55.7) and +4.9 on SWE-bench Lite
   (57.8 to 62.7) at 1.9x wall-clock, and needed a repetition-aware loss because naive online updates amplify
   drift (2607.03441). A post-training update dropped IFEval from 0.743 to 0.684 on LLaMA-3.1-8B (2605.30021).

Caveats: "forgets less" LoRA claims use different baselines (HiP-LoRA 12.3 to 4.9 points of
retained-capability loss on one 8B model, 2604.17751; JumpLoRA BWT -22.9 to -11.9 against incremental LoRA,
2604.16171), and no paper reviewed compares LoRA and full fine-tuning forgetting directly. Choosing training data by
short-term gain raises later forgetting (2605.30537). For the safety risk of benign fine-tuning see
[cheap-worker adaptation](cheap-worker-adaptation.md) Step 5.

## Gaps

- No paired LoRA-versus-full forgetting numbers; no old-task scores for RL versus SFT on one model.
- No memory-only versus weights-only versus both comparison at matched cost; no store-size sweep over time.
- No comparison of retirement and cap policies.
- No weight versus context versus retrieval comparison on one recall set; no cost figure for gating a weight
  update; no frozen-model-plus-same-memory baseline for agent test-time training.
- No collapse count for ROME/MEMIT-style sequential weight edits (the 5,000-edit result, 2604.19089, uses a
  method that does not change weights).
