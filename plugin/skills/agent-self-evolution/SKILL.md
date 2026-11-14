---
name: agent-self-evolution
group: design-analysis
description: >
  Decide whether, and how, to let an agent system evolve its own harness (prompts, tool definitions,
  skills, control-flow code) over generations, and how to keep the gains real. Covers the acceptance gate
  (held-out split, repeated paired evaluation, a verifier the loop cannot edit), what to mutate first,
  lineage vs archive search, what transfers to a new model or benchmark, the simple baselines to beat
  (frozen harness, hand-tuned prompt, best-of-N sampling), and cost per generation. Use before building
  or running a loop in which an agent edits its own prompts, skills, tools or code and keeps the edits
  that score higher, or before trusting a reported gain from one.
keywords: self-evolving agent, self-improving agent, harness evolution, self-modification, Darwin Godel Machine, archive search, hill climbing, acceptance gate, false commit, held-out validation, sealed test, evaluator gaming, reward hacking, answer key, transfer, cross-model, frozen baseline, best-of-N control, generation cost
related: autonomous-review-loop, agent-fleet-orchestration, parallel-subagent-experiments, automation-design, self-reflect, task-feedback-reflect
---

# Agent self-evolution

## The idea

A self-evolving agent proposes a change to its own harness (the prompt, tools, skills and loop around the
model), tests it, and keeps it if it scores higher. The search is the easy part. The hard part is the
*gate*: deciding that a higher score is real. Terms: a *false commit* is a kept change that did not truly
help; *validation* is the data used to pick changes; the *sealed test* is data read once at the end;
*lineage* means each candidate starts from its parent's changes.

## Rules

1. **Gate on repeated, paired evaluation, never one score bump.** Keep-if-score-rose commits false
   improvements at 30-100% rates (2606.08106). Self-improving loops raised run-to-run variance in 71% of
   cases, and one memory method moved from +1.5% to -4.5% when task order was shuffled (2608.18066).
   Selection optimism grew from 0 to 2.09 points as candidates per step went from 1 to 3 (2611.12988; that
   study updates LoRA weights, not a harness, so read it as a warning, not a measurement).
   Score each candidate on the same tasks as its parent, several times, and accept on the paired difference.
2. **Keep the verifier outside the loop.** An agent that can read or edit its judge will. Agents reading
   cached answer keys reported 100% when the true score was 68.1% (2609.02246); benchmark leak controls moved
   one model from 78.80% to 57.32% (2609.08149). Use executable tests, answer-key canaries and a ground-truth
   oracle that returns only an opaque pass/fail bit; in 2604.01687 the in-loop surrogate verifier mattered too
   (removing it cut pass rate from 71.1% to 41.1%).
   Review by hand any change that touches the evaluator, hooks or review rules.
3. **Read a sealed test once.** Validation gains overstated held-out gains about 2.6x in one study (+0.202
   vs +0.079, 2610.12601), and the gap varied by seed (0.034 to 0.160).
   Expect a large, noisy drop from validation to sealed test, not an exact ratio.
4. **Mutate tools and structure before wording.** Locking the tool layer was the largest ablation
   (-6.8%, 2606.01314); joint prompt and tool-schema optimization reached 64.46% vs 58.68% for GEPA on one
   configuration (ToolACE-1000, o3-mini; 2604.19821);
   rubric rewording was flat for six rounds while a structural constraint moved exact match
   from 46.3% to 51.9% (2609.02246). Change one component per generation so a regression has a cause.
   Gains do not stack: stacked components "can lead to redundant checks and increased turn counts"
   (2604.25850).
5. **Inherit from the parent, keep a few alternatives.** Greedy parent inheritance added +0.238 held-out
   accuracy over resetting to the seed (2610.41157). Strict admission discarded useful branches: retention of
   best candidates fell from 15 to 6 pools (2611.07624). Whether a full archive beats a single lineage is
   unmeasured on one system (see Gaps), so "keep archive size small" is a heuristic, not a finding.
6. **Beat the simple baselines first.** An offline-evolved harness reached 1.28x speedup vs 1.44x for the
   frozen harness, while online evolution (BOXBOX) reached 1.70x, so the form of evolution matters
   (2611.09218).
   Oracle parallel sampling came within 0.43 points of the evolved skill on SearchQA but 30.96 points behind
   on SpreadsheetBench
   (2608.02636). Only 5 of 39 meta-agent configurations beat human-engineered baselines (2606.04455).
   Report evolved vs frozen vs hand-tuned vs matched-cost sampling, or do not claim a gain.
7. **Expect partial transfer.** Evolved harnesses gained +2.3 to +10.1 points on other base models
   (2604.25850) and 18 of 20 language/model pairs retained a mean 0.63 of the gain (2608.10178), but 7 of 8
   champions lost coverage on a general-task target (2611.07624), and all 16 evolved agents lost some
   tasks they had covered. Re-run the gate on the new model or benchmark. Carry abstracted lessons, not raw
   trajectories (+6.5 to +9.0 vs -2.0 to -9.5 points, 2604.27003).
8. **Budget for it.** 20 generations cost about $723-$2,373 per run, and 8 of 11 reliability-improving
   champions cost more per task ($5.1-$8.9) than the seed (2611.07624). Spend on the evaluator: a
   noise-sized evaluation slice returned the seed in 13% of runs vs 86% for GEPA at 250 calls (2610.05671).

## Anti-patterns

- Accepting a change because the next run scored higher once.
- An LLM judge as the only authority over its own loop.
- Reading the test set every generation, so it becomes validation.
- Rewording the same rubric for many rounds.
- Calling an aggregate gain a win without listing the tasks that got worse.
- Letting the agent edit the playbook, hook or review rules that gate it, then trusting the result.

## Gaps

No paper in the local KB runs a coding agent with and without an archive; no single table ranks prompt,
tool, skill, workflow and whole-source mutation on one backbone and budget; no iterations-to-plateau curve;
no cheap-vs-strong proposer comparison; no random-search control; the 56.7% SWE-bench Verified figure is
credited to two different systems in two notes. Treat rules 4 and 5 as the weakest.

Evidence: agentic-capability-reports note `2026-11-14-self-evolving-harness-archive-search-vs-hill-climb`.
