# Skill library design

Use when: adding or editing a SKILL.md, CLAUDE.md rule block or tool description set; when an agent ignores
or is misled by its skills, a library keeps growing, or you are choosing between a prose skill and a tool.

A skill is a change to the agent's context and can hurt: the test is "does the agent do better with it than
without it, on the tasks it will be loaded for", not "is this good advice". Where a skill or rule should
live: the `placement-picker` skill; regression gate: [continual learning](agent-continual-learning.md).

1. **Run without the skill first**, on your own tasks, including for a published skill pack or a vendor's
   headline gain (check its baseline, model and sample size). If the no-skill pass rate is already high and
   tool errors are informative, a skill adds cost, not success: a comprehensive skill set raised one agent
   by 9 points (not significant) at about 60x the tokens.
2. **Write a skill only for a task type that fails without it**, not after one bad run, and add skills one
   at a time, testing each. Name the failure it fixes in the skill's own text, and say when it does not
   apply.
3. **Load names and descriptions; load the body on selection** (schema-token costs:
   [tool surface design](../../agent-loop-design/references/agent-tool-surface-design.md)). Navigating a
   compiled skill hierarchy beat multi-turn retrieval but cost about 2x more, and 13-22x more than
   single-shot retrieval: use it for curated, single-domain corpora, not by default.
4. **Select per task, not per library.** Per-task masking was the largest single gain in a curation study
   (+7.5 points). Routing accuracy falls about 3 points each time the library doubles. Routing reads only
   the description, so make it say when to use the skill; over-general skills capture routing from specific
   ones.
5. **Keep skills short and pruned.** Pruning and rewriting skill bundles gave up to +21 points at up to 32%
   lower cost. Prefer "do not ..." constraints: in one coding-agent study they helped and positive
   directives tended to distort.
6. **Gate agent-written skills.** Validate on held-out tasks before a skill enters, keep failed trajectories
   in the feedback ([lesson capture](post-task-lesson-capture.md), source lessons from failures), cap the
   active set and retire what stops helping. Without retirement and a cap a growing library stagnates or
   falls below the no-skill baseline; retirement was load-bearing, explicit dedup was not.
7. **Audit the judge before trusting its pass decisions**, and do not retire with the same judge that
   approved. A judge whose false-pass rate exceeds (1 - tau) / 2, where tau is the retirement threshold,
   switches off retirement entirely, whatever the data volume. Inject known defects, measure how many it
   passes, and lower tau or replace the judge if the rate is past that bound.
8. **Match the skills to the model.** The same skills helped a strong model by about 8 points and
   slightly hurt a weaker one. Re-test after every model change.
9. **Prefer a tested, executable tool when the task allows**; it is also easier to review than prose.
10. **Treat every skill as untrusted input.** Injection through skill helper scripts succeeded about 81% of
    the time, against 0% for naive injection. Review helper scripts and third-party skills like dependencies
    ([untrusted-content defense](../../agent-safety/references/untrusted-content-defense.md)).
11. **Shape tools, not only skills.** Joint tuning of the prompt and tool schemas raised success from 51% to
    64%. See [tool surface design](../../agent-loop-design/references/agent-tool-surface-design.md) and
    [long-horizon planning](../../agent-loop-design/references/long-horizon-planning.md) (**Escalating to a
    heavier planner**) for orchestration.

Evidence: kb://agentic-capability-reports/notes/2026-11-14-when-do-skill-libraries-help-tool-agents.md,
kb://agentic-capability-reports/notes/2026-11-14-multi-round-self-evolution-drift-and-maintenance-rules.md
