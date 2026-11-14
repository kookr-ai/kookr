---
name: cheap-worker-adaptation
group: design-analysis
description: >
  Decide how to make a cheaper or smaller model do agent work that a stronger model does today. Covers
  the order of moves (tune the harness around the unchanged model first, fine-tune only on specific
  signals), what to change in the harness, and, when you do control the weights, how to build the
  training set: train on the cheap model's own corrected mistakes rather than on the strong model's
  runs, rank runs by how they went rather than by pass or fail, and re-test what fine-tuning breaks.
  Use when a cheap worker model underperforms a strong one, when moving a workload to a cheaper tier
  or a local model, or before starting any fine-tune or distillation of an agent model.
keywords: cheap worker, small model, model downgrade, cost reduction, harness tuning, harness adaptation, prompt optimization, fine-tuning, LoRA, distillation, teacher student, agent trajectories, trajectory selection, on-policy, behavior cloning, catastrophic forgetting, local model, held-out evaluation
related: agent-fleet-orchestration, token-efficiency, automation-design, parallel-subagent-experiments
---

# Cheap worker adaptation

## The idea

There are two ways to make a cheap model do a strong model's job. You can change what surrounds the
model (the **harness**: prompts, tool descriptions, hooks, verification steps), or you can change the
model's weights by fine-tuning it on examples from a stronger model (**distillation**). Tune the
harness first. Fine-tune only when a specific signal says the harness cannot fix the problem, and only
if you control the weights.

Terms used below. A **run** (papers say trajectory or rollout) is one full attempt at a task: the
agent's steps, tool calls and outcome. The **teacher** is the strong model and the **student** is the
cheap one. A **held-out set** is a set of tasks that tuning and training never see.

How strong the evidence is:

- No study in the local KB compares the two approaches on one agent benchmark at matched cost. The
  order below rests on separate studies of each side plus one head-to-head on a non-agent task.
- Almost all the studies use open Qwen and Gemma models as the cheap model. Applying the harness
  results to hosted tiers such as Claude Haiku is a transfer, not a measurement.
- Each rule cites its evidence by arXiv ID; `kb search` finds each note by that ID. Most rules rest
  on a single study.

For hosted models the weights are not yours to change, so only Steps 1 and 2 apply. Steps 3 to 5
apply to local open models. To decide which model tier a task needs in the first place, see
`agent-fleet-orchestration`.

## Step 1: fix a held-out set before changing anything

Pick the held-out tasks and a metric, and judge every later change on them.

- Tuning overstates its own gains. In one prompt-optimization study, the gain measured on the tasks
  used for tuning was about 2.6x the gain on held-out tasks (2610.12601).
- Training does the same. In one unpublished local run, fine-tuning on a larger teacher's
  preferred-versus-rejected answer pairs fit the training data about 12x better than training on the
  student's own pairs, and then scored worse on held-out tasks.

## Step 2: tune the harness around the unchanged model

Drive the edits from failed runs. Read where the cheap model went wrong, then change the tool
description, add a verification step, add a recovery hook, or add a corrector: a second model call
that reviews the output without seeing the conversation that produced it.

- After automated harness editing, the best small model recovered 89.7% of the large model's accuracy
  at 4% of its inference cost. The edits improved 16 of 21 task-model pairs but closed the gap fully
  in only 7. Gains were larger on repetitive tasks and with more capable small models (2607.08938).
- Automated harness editing on a frozen 27B model gained 9 to 15.5 percentage points on test tasks
  hidden from the tuning loop (2607.13683). Repairing harness code from failed runs improved held-out
  scores by 15.2%-50.0% (2606.06324).
- A scaffold of summarizer, agent and isolated corrector raised an 8B model's task completion on the
  AppWorld benchmark from 5.4% to 8.9%, above a 33B model's 7.1%. In the ablation, the corrector
  alone gave most of the gain (2604.11465).
- It needs no GPU. One study ran about 15,000 runs on a CPU-only machine for $3,667 of model spend on
  the runs and $256 on the model that proposed the edits (2608.10178). The KB has no matching dollar
  figure for a fine-tune, so this shows the scale, not a saving.

Two costs to watch:

- **Longer prompts.** One optimized prompt raised per-query input tokens by 32% (2610.12601).
- **No transfer between models.** Skills learned for one model lowered another model's score
  (2603.16112). Re-tune the harness when the worker model changes.

## Step 3: fine-tune only on one of three signals

1. **A hard constraint stays unreliable after prompt optimization.** In one study, weight training
   raised the pass rate on hard format constraints from below 2% to over 90%, and prompt optimization
   alone reached at most 28% (2610.18309; a slate-generation task, not an agent benchmark).
2. **Prompt tokens dominate cost.** A fine-tuned 4B model needed no tool descriptions in its prompt,
   which cut input length by 82.6%. Its tool-selection score (AT-F1) was 0.65, against 0.47 for a
   baseline given the full descriptions (2605.17774). The note does not say that baseline's prompt
   was tuned, so this shows fine-tuning can replace a long prompt, not that it beats a tuned one.
3. **Several harness edits in a row give no gain on the held-out set.** This is our rule of thumb;
   no study gives a threshold.

Keep the tuned harness when you train. Starting from the optimized prompt reached the same reward in
1.6-1.9x fewer training steps (2610.18309). A harness matched to the trained model beat mismatched
pairs, and tuning both together raised a 4B model's answer accuracy on the ToolHop tool-use benchmark
from 41.03% to 52.82% (2606.01779).

## Step 4: build the training set from the student's own corrected runs

- **Don't train on teacher runs alone.** The student drifts into situations the teacher never met.
  On a web benchmark, a student trained to imitate teacher runs plateaued near 25% however long it
  trained. Letting the student act, then having the teacher rewrite the student's failed steps,
  reached 41.1% with a 4B student, for 403 teacher calls, 4.0M tokens and 1.0 GPU-hour of training
  (2610.19834). In another study, training on the teacher's own runs collapsed mid-training
  (2604.10674).
- **Score passing runs on process quality and train on the top ones.** One study scored each run from
  its event log alone, on signals such as whether actions matched the stated intent and whether the
  agent narrowed its focus over time. At a fixed 1,024 passing coding-agent runs, training on the
  top-scored subset gave 27.6% of SWE-Bench Verified tasks solved, a random subset 24.8%, and the
  bottom-scored subset 21.8%, which is below the untrained model's 24.4%. The log score cost about
  $0.1-0.2 of CPU and came within 0.8 points of a GPT-4o judge that cost about $2,750 (2610.13152).
  Passing alone is a weak filter: 10.7% of passing SWE-bench runs were "lucky passes" (2605.12925).
- **Consider masking bad steps rather than dropping the failed run.** Masking means leaving those
  steps out of the training loss while keeping the rest of the run. It reached 32.2% on SWE-bench
  Verified, against 30.9% for dropping failed runs and 28.5% for training on them as they are
  (2605.10674). The gain is small (1.3 points), and the model that labelled harmful steps was right
  only 60.4% of the time.
- **Start small.** Measured gains came from about 1,700 tool-use examples (2605.17774), 1,024 runs
  (2610.13152), and 106 supervised plus 50 reinforcement-learning conversations (2610.12757). No
  study shows where more data stops helping.

## Step 5: re-test what fine-tuning breaks

Run the held-out set and a general benchmark before and after training, and decide the drop you will
accept in advance.

- **General ability.** Fine-tuned 4B models kept only 61.3%-79.8% of the untuned model's accuracy on
  general multiple-choice questions (2605.17774).
- **Training stability.** Training on the student's own runs is fragile. An asynchronous setup fell
  from 41.8% to 26.8% on SWE-bench Verified and collapsed in 3 of 5 training runs (2605.17862).
- **Safety behavior.** Fine-tuning audio models on harmless data that was chosen for its similarity
  to harmful content raised jailbreak success from single digits to 87.12%; random harmless subsets
  did not reliably do so (2604.16659). This is an analogy for agents, not a measurement.
- **The remaining gap.** The 4B web student above reached 41.1% against its teacher's roughly 70.9%
  (2610.19834). On one engineering-design benchmark, untuned open 4B models averaged 55-78% task
  completion against 96-97% for small proprietary models (2605.19743). Keep the strong model for the
  tasks the student still fails.

## Anti-patterns

- **Fine-tuning before tuning the harness.** It costs GPUs and risks forgetting, for a gap the
  harness may close for the price of some runs.
- **Judging on training or tuning scores.** Both overstate; only the held-out set counts.
- **Cloning the teacher.** Teacher-only runs teach the student situations it will not be in.
- **Pass or fail as the only filter.** Low-quality passing runs made the model worse than no training.
- **Reusing a harness across models.** Tuned prompts and skills are specific to the model they were
  tuned for.

## Gaps in the evidence

No KB note compares harness tuning with distillation on one agent benchmark at matched cost, gives a
numeric threshold for switching, plots score against the number of training runs, or prices a full
distillation. Nothing measures a student inheriting teacher errors, or the loss on unseen
repositories or tool sets after fine-tuning. Source report:
`harness-tuning-vs-trajectory-distillation-for-cheap-workers` in the `agentic-capability-reports` KB.
