# Cheap worker adaptation

Use when: a cheaper or smaller model underperforms a strong one on agent work, when moving a workload to
a cheaper tier or a local model, or before starting any fine-tune or distillation of an agent model.

Tune the **harness** (prompts, tool descriptions, hooks, verification steps) around the unchanged model
first. Fine-tune (distill from a stronger teacher) only when a specific signal says the harness cannot
fix the problem, and only if you control the weights: hosted models get Steps 1-2 only, local open
models Steps 1-5. Which model tier a task needs at all: the `agent-fleet-orchestration` skill.

Most rules rest on a single study, and almost all studies use open Qwen and Gemma models as the cheap
model: applying them to hosted tiers such as Claude Haiku is a transfer, not a measurement.

## Step 1: fix a held-out set before changing anything

Pick held-out tasks and a metric that tuning and training never see; judge every later change on them.

- Tuning overstates its own gains: in one prompt-optimization study the gain on the tuning tasks was
  about 2.6x the held-out gain (2610.12601). Running an optimizer on a small budget:
  [prompt optimization under budget](../../agent-evaluation/references/prompt-optimization-under-budget.md).
- Training does the same: in one unpublished local run, fine-tuning on a larger teacher's preference pairs
  fit the training data about 12x better than on the student's own pairs, then scored worse held-out.

## Step 2: tune the harness around the unchanged model

Drive the edits from failed runs: read where the cheap model went wrong, then change the tool
description, add a verification step, a recovery hook, or a corrector (a second call that reviews the
output without seeing the conversation; evidence in the `agent-fleet-orchestration` skill, Step 4).

- After automated harness editing, the best small model recovered 89.7% of the large model's accuracy at
  4% of its inference cost. The edits improved 16 of 21 task-model pairs but closed the gap fully in
  only 7; gains were larger on repetitive tasks and with more capable small models (2607.08938).
- It needs no GPU: about 15,000 runs on a CPU-only machine cost $3,667 of model spend plus $256 for the
  model proposing edits (2608.10178); with no matching fine-tune figure, this shows scale, not a saving.
- **Cost: longer prompts.** One optimized prompt raised per-query input tokens by 32% (2610.12601).
- **Cost: no transfer between models.** Skills learned for one model lowered another model's score
  (2603.16112). Re-tune the harness when the worker model changes.

## Step 3: fine-tune only on one of three signals

1. **A hard constraint stays unreliable after prompt optimization.** Weight training raised the pass
   rate on hard format constraints from below 2% to over 90%, where prompt optimization alone reached at
   most 28% (2610.18309; a slate-generation task, not an agent benchmark).
2. **Prompt tokens dominate cost.** A fine-tuned 4B model needed no tool descriptions in its prompt,
   cutting input length by 82.6%, with tool-selection AT-F1 0.65 against 0.47 for a baseline given the
   full descriptions (2605.17774); that baseline may not have been tuned, so this shows fine-tuning can
   replace a long prompt, not beat a tuned one.
3. **Several harness edits in a row give no held-out gain** (a rule of thumb; no study gives a threshold).

Keep the tuned harness when you train: starting from the optimized prompt reached the same reward in
1.6-1.9x fewer training steps (2610.18309). A harness matched to the trained model beat mismatched pairs;
tuning both together raised a 4B model's ToolHop accuracy from 41.03% to 52.82% (2606.01779).

## Step 4: build the training set from the student's own corrected runs

- **Don't train on teacher runs alone**: the student drifts into situations the teacher never met. On a
  web benchmark, imitating teacher runs plateaued near 25% however long it trained; letting the student
  act and the teacher rewrite its failed steps reached 41.1% with a 4B student, for 403 teacher calls,
  4.0M tokens and 1.0 GPU-hour of training (2610.19834).
- **Score passing runs on process quality and train on the top ones; passing alone is a weak filter.**
  Scored from the event log alone (did actions match stated intent, did focus narrow), at a fixed 1,024
  passing coding-agent runs, the top subset solved 27.6% of SWE-Bench Verified, a random one 24.8%, the
  bottom 21.8%, below the untrained 24.4%. The log score cost about $0.1-0.2 of CPU and came within 0.8
  points of a GPT-4o judge costing about $2,750 (2610.13152).
- **Consider masking bad steps out of the loss rather than dropping the failed run:** 32.2% on SWE-bench
  Verified against 30.9% for dropping failed runs and 28.5% for training on them as is (2605.10674). The
  gain is small (1.3 points), and the step labeller was right only 60.4% of the time.
- **Start small.** Gains came from about 1,700 tool-use examples (2605.17774), 1,024 runs (2610.13152),
  and 106 supervised plus 50 RL conversations (2610.12757); no study shows where more stops helping.

## Step 5: re-test what fine-tuning breaks

Run the held-out set and a general benchmark before and after training; fix the acceptable drop in
advance. Replay and backward transfer: [continual learning](agent-continual-learning.md).

- **General ability.** Fine-tuned 4B models kept only 61.3%-79.8% of the untuned model's general
  multiple-choice accuracy (2605.17774).
- **Training stability.** Training on the student's own runs is fragile: an asynchronous setup fell from
  41.8% to 26.8% on SWE-bench Verified and collapsed in 3 of 5 training runs (2605.17862).
- **Safety behavior.** Fine-tuning audio models on harmless data chosen for similarity to harmful
  content raised jailbreak success from single digits to 87.12%; random harmless subsets did not reliably
  do so (2604.16659). An analogy for agents, not a measurement.
- **The remaining gap.** The 4B web student above reached 41.1% against its teacher's roughly 70.9%
  (2610.19834): keep the strong model for the tasks the student still fails.

## Gaps

- No harness-tuning versus distillation comparison on one agent benchmark at matched cost.
- No numeric threshold for switching, curve of score against training runs, or price for a distillation.
- Nothing measures a student inheriting teacher errors, or loss on unseen repositories or tool sets.
