# Skill library design

Use when: adding or editing a SKILL.md, CLAUDE.md rule block or tool description set; when an agent ignores
or is misled by its skills, a library keeps growing, or you are choosing between a prose skill and a tool.

A skill is a change to the agent's context and can hurt: the test is "does the agent do better with it than
without it, on the tasks it will be loaded for", not "is this good advice". Where a skill or rule should
live: the `placement-picker` skill; regression gate: [continual learning](agent-continual-learning.md).

## Rules

1. **Run without the skill first**, on your own tasks, including for a published skill pack or a vendor's
   headline gain (check its baseline, model and sample size). If the no-skill pass rate is already high and
   tool errors are informative, a skill adds cost, not success: a comprehensive skill set moved a CTF agent
   from 77.8% to 86.7% (curated: 84.4%; not significant, p = 0.71) at about 60 times the tokens (36,001 vs
   591), which the authors put down to strict tool feedback (2605.20023, one domain, 15 tasks).
2. **Write a skill only for a task type that fails without it**, not after one bad run, and add skills one
   at a time, testing each. Name the failure it fixes in the skill's own text, and say when it does not
   apply.
3. **Load names and descriptions; load the body on selection** (schema-token costs are in [tool surface
   design](../../agent-loop-design/references/agent-tool-surface-design.md)). Navigating a compiled skill
   hierarchy beat a multi-turn agentic retrieval baseline on one corpus (token F1 0.456 vs 0.378, WixQA,
   2604.14572), but cost 1.9x more per query than that baseline and 13-22x more than single-shot retrieval,
   which hallucinated about 0%: use it for curated, single-domain corpora, not by default.
4. **Select per task, not per library.** Per-task masking was the largest single gain in a curation study
   (+7.5 points on GPT-5.1, AppWorld test_normal, 2606.15390). Routing accuracy falls about 3 points each
   time the library doubles (2605.16508). Routing reads only the description, so make it say when to use the
   skill; over-general skills with vague descriptions capture routing from specific ones.
5. **Keep skills short and pruned.** Pruning and rewriting skill bundles gave up to +21 points with up to
   31.7% lower cost (2604.09297). Prefer "do not ..." constraints: in one coding-agent study they helped and
   positive directives tended to distort (2604.11088, single model).
6. **Gate agent-written skills.** Validate on held-out tasks before a skill enters, keep failed trajectories
   in the feedback ([lesson capture](post-task-lesson-capture.md) rule 2), cap the active set and retire
   what stops helping. Without retirement and a cap, a growing library stagnates or falls below the no-skill
   baseline; with them, MBPP+ pass@1 rose from 0.258 to 0.584, and retirement was load-bearing while
   explicit dedup was not (2605.19576; one model, 100 rounds).
7. **Audit the judge before trusting its pass decisions**, and do not retire with the same judge that
   approved. A judge whose false-pass rate exceeds (1 - tau) / 2 switches off retirement entirely, whatever
   the data volume (2607.07436). Inject known defects and measure how many it passes.
8. **Match the skills to the model.** The same skills gave a strong model +8.43 points and a weaker model
   -0.60 from skill inflation (2604.17308). Re-test after every model change.
9. **Prefer a tested, executable tool when the task allows**; it is also easier to review than prose. Skill
   programs with validation on a 7B model reached 51.0% web-search accuracy against 31.2% for ReAct
   (2605.17734).
10. **Treat every skill as untrusted input.** Injection through skill helper scripts succeeded 80.7% of the
    time on average, against 0% for naive injection (2602.14211). Review helper scripts and third-party
    skills like dependencies ([untrusted-content defense](../../agent-safety/references/untrusted-content-defense.md)).
11. **Shape tools, not only skills.** Joint tuning of the prompt and tool schemas raised success from 51.27%
    to 64.46% (2604.19821). More: [tool surface design](../../agent-loop-design/references/agent-tool-surface-design.md),
    and [long-horizon planning](../../agent-loop-design/references/long-horizon-planning.md) rule 7 for orchestration.

## Gaps

- No operator-observed measurements of skill trigger rate, misses or description wording; only a schema note
  says the description decides the trigger.
- No same-benchmark comparison of agent-created tools against a fixed tool set; no tool reuse rates.
- No agent-written versus human-written head-to-head; no measured effect of skill length or example count.
- No measured model-size threshold below which skills stop helping.
- Lazy schema loading is measured for tokens only; end-to-end success is projected.
