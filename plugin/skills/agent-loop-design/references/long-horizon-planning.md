# Long-horizon planning

Use when: starting or briefing a long multi-step task (up-front plan or reactive, granularity, plan
form, replan triggers, where plan and progress live past the context window), when an agent stalls after early
progress, or before acting on a saved plan, todo list or checkpoint after a gap.

Plan-vs-ReAct comparisons at equal budget are missing, so every rule is conditional. Who writes the plan
in a coding fleet: `agent-fleet-orchestration`. Durable handoffs across runs: `automation-design`,
`self-continuation-task`.

## Rules

1. **Plan up front only when the task is decomposable, mostly deterministic and each step is
   checkable.** Compiled, validated plans cut latency ~10x and lifted accuracy, but against a weak
   baseline and with a replan fallback: an upper bound. When each step depends on what the last revealed,
   act and plan only the next stage.
2. **Keep the plan short and coarse.** A few sentences cost 20-50 output tokens. Split a step further
   only at run time, when it fails or looks large; fine static decomposition raises retry cost
   (`agent-fleet-orchestration`).
3. **Commit to the next stage, not the whole plan.** Executing a prefix of a validated task DAG cut
   executed tasks ~40% and raised accomplishment.
4. **Spend planner tokens where the executor is weak**; don't add a planner stage on top of a strong
   executor by default (it added ~0.1 F1 there vs ~7 for a weak executor).
5. **Validate the plan before running it**: tools exist, dependencies hold, each stage has an observable
   check. A protocol check raised plan validity from 77% to 91%.
6. **Replan on events, not on a schedule and not by default.** Triggers that helped: a failed validator
   check, and environment uncertainty (its own gain is not isolated). Plan only when uncertain, then keep a verified plan until it
   completes or fails. Reroute a tool failure deterministically instead of asking the LLM to replan. Don't
   replan every step: a period of 3 beat 1.
7. **Escalating to a heavier planner is a cost, not a default.** Expanded orchestration lowered accuracy
   (55% to 51%), doubled tracebacks and raised cost ~15% on one benchmark.
8. **Put plan and progress in a file, then re-verify it.** After any gap, re-read the authoritative
   source before acting on a saved plan or checkpoint: an approved plan had already been merged, and
   checkpoints skipped newly opened work. Treat persisted summaries as untrusted input
   (`token-efficiency`). Re-critique a carried-forward findings list each round; don't walk it as a
   to-do agenda.
9. **Re-inject hard constraints on long contexts.** Compliance with "don't do X" rules fell from 73% to
   33% with context depth while "do X" rules stayed near 100%.
10. **Gate "done" on an external check.** An agent's self-set completion field had no predictive
    validity, and the best CTF agent made its progress in the first 20 steps before stalling. See lucky
    passes in [agent failure recovery](agent-failure-recovery.md).
11. **Diagnose the failure class before adding structure; don't assume compounding step errors.** No
    study fits a per-step compounding curve. In web, OS and embodied tasks planning and memory
    failures dominate; long coding runs fail mostly from edit quality (60-69% of
    capable-model failures), not lost plans. Early give-up ([agent failure
    recovery](agent-failure-recovery.md)), a stall after early progress (**Gate "done"**) and forgotten
    prohibitions (**Re-inject hard constraints**) each need a different fix.
12. **Gate each chunk on a check that says what to fix.** One round of test-log feedback took Claude Code
    from 39% to 83% resolved on hardware bug fixing; a perfect file-level oracle added 1.4%. Weak
    verifiers degrade results.
13. **Bound the working context and clear it periodically.** Clearing beat a sliding window; a trained
    summary of old history cost ~0.04 accuracy for ~78% lower cost. Keep the fields goal, progress,
    decisions, open loops, and write-gate before summarizing (`token-efficiency`).
14. **Delegate wide, independent work; keep serial work in one agent.** Independent parallel workers
    raised detection from 51% to 64%, but a single agent was cheapest per validated finding. Delegation
    is the hardest category for all models.
15. **Choose the plan's form by what will check it.** Structure pays only when a cheap mechanical check
    comes with it; no study swaps only the representation, so treat this as conditional.
    - *Text steps* by default, for one-off or exploratory work. Keep free-form reasoning beside any
      structured plan: removing it cost about 20 accuracy points in one system.
    - *A small JSON dependency graph* (id, tool, inputs, depends-on, check) when several tools have real
      dependencies. Validate it before running it, run independent nodes in parallel but check accuracy
      (it fell on coding tasks), and repair a failed node locally before regenerating the graph (84% vs
      62% recovery).
    - *Code* only for task shapes that repeat on a stable interface, learned from successful runs, with a
      reactive fallback: tokens fell 82-96% but success on live, varied tasks barely moved.
    - *A formal language plus a solver* only when the domain model already exists and the LLM just
      translates facts. Check the translation on known cases first: most generated models ran, but fewer
      than half were correct.
    - Do not use a static, fine-grained graph: it raised retry cost about 80%.

Evidence: kb://agentic-capability-reports/notes/2026-11-14-upfront-plan-vs-reactive-and-replan-triggers.md,
kb://agentic-capability-reports/notes/2026-11-14-horizon-length-decay-and-chunked-long-tasks.md,
kb://agentic-capability-reports/notes/2026-11-14-plan-representation-text-graph-code-or-pddl.md
