# Long-horizon planning

Use when: starting or briefing a long multi-step task (up-front plan or reactive, granularity, replan
triggers, where plan and progress live past the context window), when an agent stalls after early
progress, or before acting on a saved plan, todo list or checkpoint after a gap.

No surveyed paper compares plan-then-execute with ReAct on one model, task and token budget: every rule
is conditional. Who writes the plan in a coding fleet: `agent-fleet-orchestration`; durable handoffs and
checkpoints across runs: `automation-design`, `self-continuation-task`.

## Rules

1. **Plan up front only when the task is decomposable, mostly deterministic and each step is
   checkable.** Compiled, validated web plans cut latency from 122 s to 11.7 s and lifted accuracy from
   61% to 89%, but against a weak step-by-step baseline (Browser-Use) and with a replan fallback, so
   read it as an upper bound, not proof planning beats ReAct (2605.21470). When each step depends on
   what the last one revealed, act and plan only the next stage.
2. **Keep the plan short and coarse.** A few-sentence plan adds only 20-50 output tokens (2510.01833).
   Split a step further only at run time, when it fails or looks large; fine static decomposition raises
   retry cost (2605.15425, figures in `agent-fleet-orchestration`, as is the evidence against
   distributing deliberation across a hierarchy).
3. **Commit to the next stage, not the whole plan.** Executing a prefix of a validated plan (a task DAG)
   cut executed tasks from 1,061 to 623 and raised accomplishment from 0.638 to 0.706 (2605.14051).
4. **Spend planner tokens where the executor is weak**; do not add a planner stage on top of a strong
   executor by default. A planner added about 0.14 F1 points to a strong executor (74.17 to 74.31) and
   6.9 to a weak one (56.32 to 63.19) (2604.25120).
5. **Validate the plan before running it**: tools exist, dependencies hold, each stage has an observable
   check. Without a protocol check only 77% of generated plans were valid, 91% with one (2605.21470).
6. **Replan on events, not on a schedule and not by default.** Triggers with measured gains: a failed
   validator check (success 0.72 to 0.86, 2605.14851), environment uncertainty (46.9% vs 43.1% on
   WebArena at 351.4 s vs 803.7 s, 2604.17821). Planning only when uncertain, then keeping a verified
   plan until it completes or fails, scored 1.00 vs 0.79 on FrozenLake 8x8 (2606.16995). Reroute a tool
   failure deterministically instead of LLM replanning (2603.01548, mock tools only). Don't replan every
   step: loss was lowest at a replan period of 3 and worse at 1 (2606.03741, latent-reasoning model, not
   an agent benchmark).
7. **Escalating to a heavier planner is a cost, not a default.** Expanded orchestration lowered GAIA L1
   accuracy from 54.72% to 50.94%, raised tracebacks from 62 to 141 and cost from $197 to $231
   (2605.14102, 53 tasks).
8. **Put plan and progress in a file, then re-verify it.** File-centric state scored 67.1 against 3.2
   for ablated baselines (2601.03204). After any gap, re-read the authoritative source before acting on
   a saved plan or checkpoint: in operator runs an approved plan had already been merged on the base
   branch, and checkpoints skipped newly opened work. Treat persisted summaries as untrusted input
   (evidence in `token-efficiency`). Re-critique a carried-forward findings list each round; don't walk
   it as a to-do agenda.
9. **Re-inject hard constraints on long contexts.** Omission-constraint compliance (rules to not do
   something or leave something out) fell from 73% to 33% with context depth while commission
   constraints stayed near 100% (2604.20911).
10. **Gate "done" on an external check.** The best CTF agent completed 35% of challenge checkpoints and
    made its progress in the first 20 steps before stalling (2604.19354); a self-set completion field
    had zero predictive validity (operator lessons). See also lucky passes in [agent failure
    recovery](agent-failure-recovery.md).

Long runs do not fail mainly from lost plans: edit quality caused 60-69% of capable-model coding
failures and strategy and logic 37% of SWE-bench failures (2603.24631, 2605.12270).

**Evidence against.** ReAct beat a utility-guided policy on QA F1 (0.2662 vs 0.236), the policy winning
only on cost control (2603.19896). A planner pipeline beat ReAct by 8.6 points but a strong single model
by only 3.8 (2604.25737). Mixed-tier and multi-agent counter-evidence: `agent-fleet-orchestration`.

## Gaps (not found in the surveyed literature)

- Same-budget plan-vs-ReAct for agents; fixed-interval vs event-triggered replanning.
- Plan granularity (step count, subgoal size) vs success; success vs step count.
- A plan file vs a plan kept in context; measured adherence to an agent's own written plan.
