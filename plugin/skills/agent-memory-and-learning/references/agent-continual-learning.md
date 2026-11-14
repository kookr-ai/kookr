---
name: agent-continual-learning
group: design-analysis
description: >
  Decide where a deployed agent's ongoing learning should live (external memory, skill library, prompt,
  or model weights) and how to stop each learned change from regressing earlier tasks. Covers the
  stability-plasticity cost of memory and skill learning, a regression gate on earlier task groups,
  store governance (retire, cap, prefer external feedback), and, when weights must change, replay,
  RL-versus-SFT and LoRA evidence with measured forgetting. Use before letting an agent write lessons,
  skills or prompts from its own finished tasks, before fine-tuning a worker on its own trajectories, or
  when a change that helped one task group is suspected of breaking another.
keywords: continual learning, catastrophic forgetting, backward transfer, regression gate, stability plasticity, self-evolving agent, skill library, lesson store, memory drift, replay, on-policy replay, LoRA, RL vs SFT, fine-tuning regression, held-out earlier tasks
related: agent-fleet-orchestration, parallel-subagent-experiments, automation-design, self-reflect
---

# Agent continual learning

## The idea

Learning that lives outside the weights (memory, skills, prompts) is the right default: it is cheap and
reversible. It is not free of forgetting. Terms: *plasticity* is how well the agent learns new tasks;
*stability* is how well it keeps performing old ones; *harness* is the prompt, tools and loop around the
model; a *task group* is a set of related tasks. The one paper that measures stability on these methods
(three self-modifying harness methods) found that more plasticity came with less stability. Damage
depends on how much new tasks conflict with old ones: topic drift was near zero in the same paper. So
the rule is the same whichever mechanism you pick: check a learned change against earlier tasks before
accepting it.

## Rules

1. **Gate every learned edit on earlier tasks.** Accept a new memory, skill or prompt edit only if the
   active task improves and held-out earlier task groups do not drop beyond run-to-run noise (measure that
   noise first; the sources give no tolerance). Report gains and regressions
   separately, not one net pass rate. Evidence: after a conflicting task block, BFCL-Miss accuracy fell
   13.0 points (GEPA) and 10.2 points (Meta-Harness) (2610.25858); across 5,832 paired runs, regressions
   offset 59% of gross skill gains (2607.22520).
2. **Keep a regression suite of earlier task groups,** made of tasks the learner did not write its
   lessons or skills from.
   Interleaving task groups cut one method's gain from +5.8 to +0.9 points (2610.25858), so test in more
   than one order.
3. **Govern the store.** Retire stale entries and drop what contradicts newer facts. On one study (a
   coding benchmark, MBPP+ hard-100, one model, 100 rounds), an unbounded skill library degraded retrieval
   and a governed one reached pass@1 (share solved on the first try) 0.584 against 0.258; retirement was
   load-bearing and explicit dedup was not (2605.19576). Models gave answers consistent with a superseded
   constraint in 75-77% of episodes (2608.25553). A size cap is harmless for retrieval memory (5,000
   entries 70.8% against 71.2% unlimited, 2605.10094) but no source tests a cap as the fix.
4. **Prefer lessons that external feedback confirms** (tests, a teacher, a human edit). The best
   self-feedback skill generator reached 31.08% average accuracy against 74.50% for human-authored
   skills, and self-feedback loops drifted; teacher feedback improved steadily, with no figure given
   (2604.20087).
5. **Version every edit** so any single one can be reverted. This is an inference from rules 1-3, not a
   measured result.
6. **Prefer weights only after the harness has plateaued on a measurable constraint** (an inference
   from one case plus the cost and forgetting numbers below). In one case, weight training took a
   constraint pass rate from under 2% to over 90% where prompt optimization reached at most 28% (a
   slate-generation task, not an agent benchmark; cited in the harness-versus-distillation report in the
   same report series).
7. **If you train, replay old prompts (1-10% of the data) and measure backward transfer (BWT, the change
   in old-task score after learning new tasks).** On a 7B model over 8 sequential tasks, plain SFT had
   BWT -13.93, vanilla replay at a 1% replay ratio -4.27, on-policy replay -2.29 (about 32
   GPU-hours on 8 H100s, needs the old prompts) (2605.29495). Report old-task scores, not only the new
   task.
8. **RL retains more of the base circuit than SFT but adapts slower.** Circuit retention was 72.5%
   against 59.0% on one 3B model and one task; old-task benchmark scores were not reported
   (2605.28860). An RL-initialised 8B model collapsed to about 0% on a second task (2605.12484), so also
   test plasticity on the next task.

## Anti-patterns

- Reading a net gain as safe. Regressions hide inside it (rule 1).
- Letting the agent grade its own lessons with no external check (rule 4).
- Trusting "forgets less" from a LoRA variant. Reported gains use different baselines (LoRA is a
  low-rank fine-tuning method): HiP-LoRA 12.3 to
  4.9 points of retained-capability loss on one 8B model (2604.17751), JumpLoRA BWT -22.9 to -11.9 against
  incremental LoRA (2604.16171). No KB paper compares LoRA and full fine-tuning forgetting directly.
- Choosing training data by short-term gain. It raises later forgetting (2605.30537).
- Fine-tuning on benign data without a safety check. A jailbreak success rate rose from 4.62% to 87.12% on
  an audio model (2604.16659); treat it as a warning, not a text-model rate.

## Where the evidence is thin

No paired LoRA-versus-full forgetting numbers; no memory-only versus weights-only versus both comparison
at matched cost; no store-size sweep over time; no comparison of retirement and cap policies; no old-task
scores for RL versus SFT on one model. Full report: the `agentic-capability-reports` knowledge base,
note `2026-11-14-weights-vs-memory-for-agent-continual-learning`.
