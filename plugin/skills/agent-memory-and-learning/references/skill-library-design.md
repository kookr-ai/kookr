---
name: skill-library-design
group: design-analysis
description: >
  Decide whether a skill, rule file or tool wrapper will actually help a tool-using agent, and how to
  build and maintain a skill library so that it helps instead of hurting. Covers testing each skill
  against a no-skill baseline, loading only names and descriptions until a skill is picked, capping
  library size and choosing skills per task, gating and retiring agent-written skills, matching skills
  to the model, preferring tested executable tools to prose, and treating skills as an attack surface.
  Use before adding or editing a SKILL.md, CLAUDE.md rule block or tool description set, when an agent
  ignores or is misled by its skills, when a skill library keeps growing, or when deciding between a
  prose skill and a coded tool.
keywords: skill library, skills, SKILL.md, progressive disclosure, tool selection, tool description, MCP tools, tool schema tokens, skill retrieval, skill routing, library size, skill curation, skill retirement, skill drift, self-evolving skills, regression tax, no-skill baseline, rule files, CLAUDE.md, tool creation, executable tools, skill injection
related: agent-fleet-orchestration, placement-picker, token-efficiency, agent-efficiency-retrofit, hook-driven-workflow-enforcement, self-reflect
---

# Skill library design

## The idea

A skill is a change to the agent's context, and a change can hurt. Across 5,832 paired runs, regressions
cancelled 59% of the gross gains that skills produced (2607.22520). So the unit of decision is not "is
this skill good advice" but "does the agent do better with it than without it, on the tasks it will be
loaded for". Add skills one at a time, test each, and keep the library small enough that picking the
right one stays easy.

## Rules

1. **Run without the skill first.** If the no-skill pass rate is already high and tool errors are
   informative, a skill adds cost, not success. A comprehensive skill set moved a CTF agent from 77.8% to
   86.7% (curated: 84.4%; not significant, p = 0.71) while using about 60 times the tokens (36,001 vs 591); the authors'
   reading is that strict tool feedback already did the job (2605.20023, one domain, 15 tasks).
2. **Write a skill only for a task type that fails without it.** Name the failure it fixes in the
   skill's own text, and say when it does not apply.
3. **Load names and descriptions; load the body on selection.** Putting every tool schema in every
   turn costs 15K-55K tokens per turn; lazy loading cut a simulated 120-tool set from 47.3K to 2.4K
   tokens (2604.21816; its success and latency figures are projections). Navigating a compiled skill
   hierarchy beat a multi-turn agentic retrieval baseline on one corpus (token F1 0.456 vs 0.378,
   WixQA, 2604.14572), but cost 1.9x more per query than that baseline and 13-22x more than single-shot
   retrieval, which hallucinated about 0%: use it for curated, single-domain corpora, not by default.
4. **Select per task, not per library.** Per-task masking was the largest single gain in a curation
   study (+7.5 points on GPT-5.1, AppWorld test_normal, 2606.15390). Routing accuracy falls about 3 points
   each time the library doubles (2605.16508), and adding 300+ distractor tools dropped completion from
   about 80% to under 30% for several models (2605.10787).
   Make the description say when to use the skill, since routing reads only that.
5. **Keep skills short and pruned.** Pruning and rewriting skill bundles gave up to +21 points with up
   to 31.7% lower cost (2604.09297); a validation-gated shrinkage stage added +2.5 points in an ablation and longer skills correlated
   with lower accuracy (2608.07449). Prefer "do not ..." constraints: in one coding-agent study they
   helped and positive directives tended to distort (2604.11088, single model).
6. **Gate agent-written skills.** Validate on held-out tasks before a skill enters, keep failed
   trajectories in the feedback, cap the active set and retire what stops helping. Without retirement
   and a cap, a growing library stagnates or falls below the no-skill baseline; with them, MBPP+
   pass@1 rose from 0.258 to 0.584 (2605.19576). Unfiltered evolution scored 36.3% vs 60.3% filtered
   (2605.17734). Only 55 of 388 evolved candidates beat the current best, and success-only feedback was
   never chosen (2608.02636).
7. **Audit the judge before trusting its pass decisions.** A judge whose false-pass rate exceeds
   (1 - tau) / 2 switches off retirement entirely, whatever the data volume (2607.07436). Inject known
   defects and measure how many it passes.
8. **Match the skills to the model.** The same skills gave a strong model +8.43 points and a weaker
   model -0.60 from skill inflation (2604.17308); one agent gained on two backbones and not at all on a
   third (2609.03753). Re-test after every model change.
9. **Prefer a tested, executable tool when the task allows.** Skill programs with validation on a 7B
   model reached 51.0% web-search accuracy where plain ReAct reached 31.2% (2605.17734); code-derived skills with
   executable verification won 57 of 72 runs (2609.05571). A tool you wrote and tested is also easier to
   review than a paragraph the model may or may not follow.
10. **Treat every skill as untrusted input to the agent.** Injection through skill helper scripts
    succeeded 80.7% of the time on average, while naive injection succeeded 0% (2602.14211). Review
    helper scripts and third-party skills like dependencies.
11. **Shape tools, not only skills.** Joint tuning of the prompt and tool schemas raised success from
    51.27% to 64.46% (2604.19821); composite domain tools reached 90% against 57% for generic ones at the
    same model size (2606.18000). More orchestration can lower accuracy (54.72% to 50.94%, 2605.14102).

## Anti-patterns

- Adding a skill after one bad run, with no baseline and no held-out check.
- A catch-all skill with a vague description: over-general skills capture routing from specific ones.
- Letting an agent append skills forever, or retiring them with the same judge that approved them.
- Loading every skill body or every tool schema into every turn.
- Copying a published skill pack without running it on your own tasks.
- Reading a vendor skill's headline gain without checking baseline, model and sample size.

## Gaps

- No operator-observed measurements of skill trigger rate, misses, or description wording in this
  harness; the knowledge base holds only the schema note saying the description decides the trigger.
- No same-benchmark comparison of agent-created tools against a fixed tool set, and no tool reuse rates.
- No head-to-head of agent-written and human-written skills, no measured effect of skill length or
  example count, and no measured model-size threshold below which skills stop helping.
- Lazy schema loading is measured for tokens only; end-to-end success is projected.

Evidence: the cited papers are filed in the local KBs (`kb search "<arXiv id>"`); the full report with
quotes is the `agentic-capability-reports` note `2026-11-14-when-do-skill-libraries-help-tool-agents`.
