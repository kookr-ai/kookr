# Agent self-evolution

Use when: building or running a loop in which an agent edits its own harness (prompts, tool definitions,
skills, control-flow code) and keeps the edits that score higher, or before trusting a reported gain from one.

Apply the keep gate in [autonomous experiment loops](autonomous-experiment-loops.md) first. The rules below
add what to mutate, how to search, what to compare against, transfer and cost. *Lineage* means each
candidate starts from its parent's changes.

## Rules

1. **Mutate tools and structure before wording.** Locking the tool layer was the largest ablation; joint
   prompt and tool-schema optimization beat prompt-only (64% vs 59%); rubric rewording was flat while a
   structural constraint lifted exact match 46% to 52%. Change one component per generation so a regression
   has a cause; gains do not stack (redundant checks, more turns). This is a weakly supported rule.
2. **Inherit from the parent, keep a few alternatives.** Parent inheritance beat resetting to the seed by
   +0.24 held-out accuracy; strict admission discarded useful branches. Whether a full archive beats one
   lineage is unmeasured, so keep archive size small as a heuristic. Also weakly supported.
3. **Beat the simple baselines first.** Report evolved vs frozen vs hand-tuned vs matched-cost sampling, or
   do not claim a gain. Oracle-selected parallel sampling nearly tied one evolved skill and trailed it by 31
   points on another; only 5 of 39 meta-agent configurations beat human-engineered baselines; online evolution beat
   offline (1.70x vs 1.28x speedup), and offline evolution lost even to the frozen harness (1.44x).
4. **Expect partial transfer.** Evolved harnesses kept roughly 60% of the gain on other models, and most
   champions lost coverage on a general-task target. Re-run the gate on the new model or benchmark. Carry
   abstracted lessons, not raw trajectories (raw trajectories hurt).
5. **Budget for it.** 20 generations cost about $700-$2,400 per run, and most reliability-improving
   champions cost more per task than the seed. Spend on the evaluator: a noise-sized slice returned the seed
   far less often than GEPA at 250 calls (see **At 100-400 calls use one single-stage loop** in [prompt
   optimization](prompt-optimization-under-budget.md)).
6. **Evolve from failed trajectories and count what got worse.** Every validation-selected skill came from
   feedback that included failures, and only ~14% of candidates set a validation best. Regressions offset
   ~59% of gross skill gains, so list the tasks each edit made worse.
7. **Maintain what accumulates.** Cap the active skill or note set and retire on execution-graded outcomes,
   not an LLM judge alone ([skill library
   design](../../agent-memory-and-learning/references/skill-library-design.md) rules 6-7). Cap rounds and
   re-run the gate after a model change (see **Keep the best checkpoint** in [experiment
   loops](autonomous-experiment-loops.md)).

Evidence: kb://agentic-capability-reports/notes/2026-11-14-self-evolving-harness-archive-search-vs-hill-climb.md, kb://agentic-capability-reports/notes/2026-11-14-multi-round-self-evolution-drift-and-maintenance-rules.md
