# Cheap worker adaptation

Use when: a cheaper or smaller model underperforms a strong one on agent work, when moving a workload to
a cheaper tier or a local model, or before starting any fine-tune or distillation of an agent model.

Tune the **harness** (prompts, tool descriptions, hooks, verification steps) around the unchanged model
first. Fine-tune (distill from a stronger teacher) only when a specific signal says the harness cannot
fix the problem, and only if you control the weights: hosted models get Steps 1-2 only, local open
models Steps 1-5. Which model tier a task needs at all: the `agent-fleet-orchestration` skill. Most
findings come from open Qwen and Gemma models, so applying them to a hosted tier such as Haiku is a
transfer, not a measurement.

## Step 1: fix a held-out set before changing anything

Pick held-out tasks and a metric that tuning and training never see; judge every later change on them.
Tuning overstates its own gains (about 2.6x the held-out gain in one study), and training on a larger
teacher's pairs fit the training data better yet scored worse held-out. Running an optimizer on a small
budget: [prompt optimization under budget](../../agent-evaluation/references/prompt-optimization-under-budget.md).

## Step 2: tune the harness around the unchanged model

Drive the edits from failed runs: read where the cheap model went wrong, then change the tool description,
add a verification step, a recovery hook, or a corrector (a second call that reviews the output without
seeing the conversation; see the `agent-fleet-orchestration` skill).

- Automated harness editing let the best small model recover about 90% of the large model's accuracy at 4% of
  its inference cost. It closed the gap fully on only 7 of 21 task-model pairs; gains were larger on
  repetitive tasks and with more capable small models. It needs no GPU.
- **Cost: longer prompts.** One optimized prompt raised input tokens per query by about a third.
- **Re-tune when the worker model changes.** Skills learned for one model lowered another model's score.

## Step 3: fine-tune only on one of three signals

1. **A hard constraint stays unreliable after prompt optimization.** Weight training took hard format
   constraints from under 2% to over 90%, where prompt optimization reached at most 28%.
2. **Prompt tokens dominate cost.** A fine-tuned 4B model needed no tool descriptions in its prompt, cutting
   input length 83%. This shows fine-tuning can replace a long prompt, not beat a tuned one.
3. **Several harness edits in a row give no held-out gain** (rule of thumb; no threshold is measured).

Keep the tuned harness when you train: starting from the optimized prompt reached the same reward in about
1.7x fewer steps, and a harness matched to the trained model beat mismatched pairs.

## Step 4: build the training set from the student's own corrected runs

- **Do not train on teacher runs alone**: the student drifts into situations the teacher never met. Imitating
  teacher runs plateaued near 25% on a web benchmark; letting the student act and the teacher rewrite its
  failed steps reached 41% with a 4B student for about 400 teacher calls. Treat a stronger teacher as a
  hypothesis to test.
- **Keep only items the student fails and a teacher solves.**
- **Score passing runs on process quality and train on the top ones; passing alone is a weak filter.** Scored
  from the event log alone (actions matched stated intent, focus narrowed), the top subset of 1,024 coding
  runs beat a random one by about 3 points and the bottom subset fell below the untrained model. The log
  score cost cents against thousands of dollars for an LLM judge at similar quality.
- **Consider masking bad steps out of the loss rather than dropping the failed run.** The gain was small
  (about 1 point) and the step labeller was right only about 60% of the time.
- **Start small.** Gains came from about 100 to 1,700 examples; no study shows where more stops helping. No
  real runs to learn from: [training task synthesis](training-task-synthesis.md).

## Step 5: re-test what fine-tuning breaks

Run the held-out set and a general benchmark before and after training; fix the acceptable drop in advance.
Replay and backward transfer: [continual learning](agent-continual-learning.md).

- **General ability.** Fine-tuned 4B models kept only about 61-80% of the untuned model's general accuracy.
- **Training stability.** Training on the student's own runs is fragile: an asynchronous setup collapsed in
  3 of 5 runs.
- **Safety behavior.** Fine-tuning on harmless data chosen for similarity to harmful content raised
  jailbreak success from single digits to 87% (audio models; an analogy for agents).
- **Step-level errors.** Accuracy rose while step errors rose from 31% to 50%: track step-level error, not
  only final accuracy.
- **The remaining gap.** A 4B student reached 41% against its teacher's 71%: keep the strong model for the
  tasks the student still fails.

## Distilling an inference-time structure (debate, search, long prompt)

- **First measure the structure against a well-briefed single agent, and try editable amortisers.**
  Hierarchical deliberation was up to 3.4x worse at about 2x tokens, so distilling it copies the defect;
  context tuning beat in-context learning. Harness first: Step 2.
- **A long prompt moved into weights** overfits its query template and cannot be edited: keep the original
  context as fallback (see [continual learning](agent-continual-learning.md), knowledge in context by
  default).
- **Debate distillation** gave a few points on reasoning only; more data degraded some methods, so prefer
  quality over volume. **Search distillation** works for single-shot reasoning, but how much survives
  running search on top is unmeasured.

Evidence: kb://agentic-capability-reports/notes/2026-11-13-harness-tuning-vs-trajectory-distillation-for-cheap-workers.md,
kb://agentic-capability-reports/notes/2026-11-14-distilling-inference-time-structure-into-small-agent-weights.md
