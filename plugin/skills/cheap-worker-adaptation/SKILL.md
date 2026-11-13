---
name: cheap-worker-adaptation
group: design-analysis
description: >
  Decide how to make a cheaper or smaller model do agent work that a stronger model does today. Covers
  the order of moves (tune the harness around the unchanged model first, fine-tune only on specific
  signals), what to change in the harness, and, when you do control the weights, how to build the
  training set: train on the student's own corrected mistakes rather than on teacher trajectories,
  rank trajectories by how the run went rather than by pass or fail, and re-test what fine-tuning
  breaks. Use when a cheap worker model underperforms a strong one, when moving a workload to a
  cheaper tier or a local model, or before starting any fine-tune or distillation of an agent model.
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

No study in the local KB compares the two on one agent benchmark at matched cost. The order below
rests on separate studies of each side plus one head-to-head on a non-agent task. Each rule cites its
evidence by arXiv ID; `kb search` finds each note by that ID.

For hosted models such as the Claude tiers, the weights are not yours to change, so only Steps 1 and 2
apply. Steps 3 to 5 apply to local open models. To decide which model tier a task needs in the first
place, see `agent-fleet-orchestration`.

## Step 1: fix a held-out test before changing anything

Pick a task set the tuning never sees, and a metric. Judge every later change on it.

- Tuning overstates its own gains. In one prompt-optimization study the validation gain overstated
  the gain on held-out tasks by about 2.6x (2610.12601).
- A local run found the same for training: preference pairs from a larger teacher reached about 12x
  the training margin of the student's own pairs, yet lost on held-out evaluation.

## Step 2: tune the harness around the unchanged model

Drive the edits from failed runs: read where the cheap model went wrong and change the tool
description, add a verification step, add a recovery hook, or add a corrector that sees the output
with a fresh context.

- After automated harness editing, the best small model recovered 89.7% of the large model's accuracy
  at 4% of its inference cost. The edits improved 16 of 21 task-model pairs but closed the gap fully
  in only 7. Gains were larger on repetitive tasks and with more capable small models (2607.08938).
- Harness evolution on a frozen 27B model gained 9 to 15.5 percentage points on sealed tests
  (2607.13683). Repairing harness code from failed trajectories improved held-out scores by
  15.2%-50.0% (2606.06324).
- A corrector with a fresh context raised an 8B model on AppWorld from 5.4% to 8.9%, above a 33B
  model's 7.1% (2604.11465).
- It needs no GPU. One study ran about 15,000 rollouts on a CPU-only machine for $3,667 of rollout
  spend and $256 of optimizer-model spend (2608.10178).

Two costs to watch:

- **Longer prompts.** One optimized prompt raised per-query input tokens by 32% (2610.12601).
- **No transfer between models.** Skills learned for one model failed on another (2603.16112). Re-tune
  the harness when the worker model changes.

## Step 3: fine-tune only on one of three signals

1. **A hard constraint stays unreliable** however the prompt is written. Weight training raised a
   constraint pass rate from below 2% to over 90%; prompt optimization alone reached at most 28%
   (2610.18309; a slate-generation task, not an agent benchmark).
2. **Prompt tokens dominate cost.** A fine-tuned 4B model needed no tool descriptions, which cut input
   length by 82.6%, and it scored AT-F1 0.65 against 0.47 for a prompted baseline that had the
   descriptions (2605.17774; that baseline prompt was not optimized).
3. **Harness changes have stopped improving the held-out set.**

Keep the tuned harness when you train. Starting from the optimized prompt reached the same reward in
1.6-1.9x fewer training steps (2610.18309). A harness matched to the trained policy beat mismatched
pairs, and joint tuning raised a 4B model on ToolHop from 41.03% to 52.82% (2606.01779).

## Step 4: build the training set from the student's own corrected runs

- **Don't train on teacher trajectories alone.** The student drifts into situations the teacher never
  met. On a web benchmark, imitating teacher runs plateaued near 25% regardless of epochs. Having the
  teacher rewrite the failed steps of the student's own runs reached 41.1% with a 4B student, for 403
  teacher calls, 4.0M tokens and 1.0 GPU-hour of training (2610.19834). In another study, training on
  the teacher's own rollouts collapsed mid-run (2604.10674).
- **Rank runs by how they went, not only by whether they passed.** At a fixed 1,024 passing
  coding-agent trajectories, the best-ranked subset scored 27.6 on SWE-Bench Verified, a random
  subset 24.8, and the worst-ranked 21.8, below the untrained model's 24.4. A score computed from
  event logs cost about $0.1-0.2 of CPU and came within 0.8 points of a GPT-4o judge that cost about
  $2,750 (2610.13152). 10.7% of passing SWE-bench trajectories were "lucky passes" (2605.12925).
- **Mask bad steps instead of dropping the run.** Masking the loss on harmful steps in failed runs
  reached 32.2%, against 30.9% for dropping failed runs and 28.5% for including them unmasked
  (2605.10674). The gain is small (1.3 points) and the step critic was only 60.4% precise.
- **Start small.** Measured gains came from about 1,700 tool-use examples (2605.17774), 1,024
  trajectories (2610.13152), and 106 supervised plus 50 reinforcement conversations (2610.12757). No
  study shows where more data stops helping.

## Step 5: re-test what fine-tuning breaks

- **General ability.** Fine-tuned 4B models kept only 61.3%-79.8% of their general multiple-choice
  accuracy (2605.17774).
- **Training stability.** Training on the student's own runs is fragile: an asynchronous setup fell
  from 41.8% to 26.8% on SWE-bench Verified and collapsed in 3 of 5 runs (2605.17862).
- **Safety behavior.** Fine-tuning on benign data raised jailbreak success from single digits to
  87.12% in audio models (2604.16659). This is an analogy for agents, not a measurement.
- **The remaining gap.** The 4B web student above reached 41.1% against its teacher's roughly 70.9%
  (2610.19834). Small open models completed 55-78% of long workflows against 96-97% for proprietary
  models (2605.19743). Keep the strong model for the tasks the student still fails.

## Anti-patterns

- **Fine-tuning before tuning the harness.** It costs GPUs and risks forgetting, for a gap the
  harness may close for the price of some rollouts.
- **Judging on training or validation scores.** Both overstate; only the held-out set counts.
- **Cloning the teacher.** Teacher-only trajectories teach the student states it will not be in.
- **Pass or fail as the only filter.** Low-quality passing runs made the model worse than no training.
- **Reusing a harness across models.** Tuned prompts and skills are specific to the model they were
  tuned for.

## Gaps in the evidence

No KB note compares harness tuning with distillation on one agent benchmark at matched cost, gives a
numeric threshold for switching, plots score against trajectory count, or prices a full distillation
run. Nothing measures a student inheriting teacher errors, or the loss on unseen repositories or tool
sets after fine-tuning. Most studies use open Qwen and Gemma students, so applying the harness results
to Claude tiers is a transfer. Source report:
`harness-tuning-vs-trajectory-distillation-for-cheap-workers` in the `agentic-capability-reports` KB.
