# Agent self-evolution

Use when: building or running a loop in which an agent edits its own harness (prompts, tool definitions,
skills, control-flow code) and keeps the edits that score higher, or before trusting a reported gain from one.

The keep gate (repeated paired evaluation, A/A noise floor, a sealed test read once, a verifier the loop
cannot edit, hand review of any change to the evaluator, hooks or review rules) is in
[autonomous experiment loops](autonomous-experiment-loops.md). Apply it first; the rules below add what to
mutate, how to search, what to compare against, transfer and cost. *Lineage* means each candidate starts
from its parent's changes.

## Rules

1. **Mutate tools and structure before wording.** Locking the tool layer was the largest ablation
   (-6.8%, 2606.01314); joint prompt and tool-schema optimization reached 64.46% vs 58.68% for GEPA on one
   configuration (ToolACE-1000, o3-mini; 2604.19821); rubric rewording was flat for six rounds while a
   structural constraint moved exact match from 46.3% to 51.9% (2609.02246). Change one component per
   generation so a regression has a cause. Gains do not stack: stacked components "can lead to redundant
   checks and increased turn counts" (2604.25850).
2. **Inherit from the parent, keep a few alternatives.** Greedy parent inheritance added +0.238 held-out
   accuracy over resetting to the seed (2610.41157). Strict admission discarded useful branches: retention of
   best candidates fell from 15 to 6 pools (2611.07624). Whether a full archive beats a single lineage is
   unmeasured on one system (see Gaps), so "keep archive size small" is a heuristic, not a finding.
3. **Beat the simple baselines first.** An offline-evolved harness reached 1.28x speedup vs 1.44x for the
   frozen harness, while online evolution (BOXBOX) reached 1.70x, so the form of evolution matters
   (2611.09218). Oracle parallel sampling came within 0.43 points of the evolved skill on SearchQA but 30.96
   points behind on SpreadsheetBench (2608.02636). Only 5 of 39 meta-agent configurations beat
   human-engineered baselines (2606.04455). Report evolved vs frozen vs hand-tuned vs matched-cost sampling,
   or do not claim a gain.
4. **Expect partial transfer.** Evolved harnesses gained +2.3 to +10.1 points on other base models
   (2604.25850) and 18 of 20 language/model pairs retained a mean 0.63 of the gain (2608.10178), but 7 of 8
   champions lost coverage on a general-task target (2611.07624), and all 16 evolved agents lost some
   tasks they had covered. Re-run the gate on the new model or benchmark. Carry abstracted lessons, not raw
   trajectories (+6.5 to +9.0 vs -2.0 to -9.5 points, 2604.27003).
5. **Budget for it.** 20 generations cost about $723-$2,373 per run, and 8 of 11 reliability-improving
   champions cost more per task ($5.1-$8.9) than the seed (2611.07624). Spend on the evaluator: a
   noise-sized evaluation slice returned the seed far less often than GEPA at 250 calls (figures under
   **At 100-400 calls use one single-stage loop** in
   [prompt optimization](prompt-optimization-under-budget.md)).
6. **Evolve from failed trajectories and count what got worse.** All 11 validation-selected skills came from
   feedback that included failures; success-only feedback was never selected, and only 55 of 388 candidates
   set a validation best (2608.02636). Regressions offset 59% of gross skill gains over 5,832 paired runs
   (2607.22520), so list the tasks each edit made worse.
7. **Maintain what accumulates.** When the evolved artifact is a skill or note library, cap the active set
   and retire on execution-graded outcomes, not an LLM judge alone ([skill library
   design](../../agent-memory-and-learning/references/skill-library-design.md) rules 6-7). Cap rounds and
   re-run the gate after a model change (stopping figures under **Keep the best checkpoint** in
   [experiment loops](autonomous-experiment-loops.md)).

## Gaps

No paper here runs a coding agent with and without an archive; no single table ranks prompt, tool, skill,
workflow and whole-source mutation on one backbone and budget; no iterations-to-plateau curve; no
cheap-vs-strong proposer comparison; no random-search or random-edit control; no rollback ablation; no
same-artifact comparison of full rewrites against delta edits; no library size at which drift begins; the
56.7% SWE-bench Verified figure is credited to two different systems in two sources. Treat **Mutate tools
and structure before wording** and **Inherit from the parent** as the weakest rules.
