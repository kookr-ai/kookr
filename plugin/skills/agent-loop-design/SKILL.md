---
name: agent-loop-design
group: design-analysis
keywords: agent loop, tool design, MCP, best-of-N, reasoning effort, prompt cache, inference cost, planning, replan, failure recovery, latent reasoning, probes, steering
related: token-efficiency, agent-fleet-orchestration, automation-design, autonomous-watch-loop, error-handling-patterns, agent-safety
description: >
  Evidence-based rules for designing an agent's loop: tool surface (tool count, descriptions, output
  bounds, error wording), spending extra inference (best-of-N, voting, thinking effort, retries),
  making a loop cheaper or faster (prompt cache, serving levers), up-front plans vs reactive and replan
  triggers, recovering from mid-task failures (retry, rollback, escalate), latent vs text handoffs,
  and white-box probes or steering vs output checks. Use when building or tuning an agent loop or
  harness, or before adding tools, samples, retries, a planner or a monitor.
---

# Agent loop design

Each guide holds evidence-based rules for one design decision, with the papers behind them and a list
of gaps, so you can act without over-claiming.

Read only the guide that matches the decision in front of you (several if the task spans them).

| Decision you face | Read |
|---|---|
| Building or auditing tools / MCP servers; wrong tool picked; schemas or tool output eat tokens | [references/agent-tool-surface-design.md](references/agent-tool-surface-design.md) |
| Whether to spend more compute for a better answer: N samples, voting, higher effort, retries | [references/inference-budget-allocation.md](references/inference-budget-allocation.md) |
| Making a run cheaper or faster: cache hits, fewer tokens, self-hosted serving options (llama.cpp, vLLM, SGLang) | [references/agent-inference-efficiency.md](references/agent-inference-efficiency.md) |
| Plan up front or act reactively; when to replan; keeping plan and progress across a long run | [references/long-horizon-planning.md](references/long-horizon-planning.md) |
| The agent hit an error, regression, stuck loop or stall mid-task; choosing an attempt budget | [references/agent-failure-recovery.md](references/agent-failure-recovery.md) |
| Someone proposes latent reasoning, KV-cache or hidden-state handoffs, looped models | [references/latent-vs-text-agent-design.md](references/latent-vs-text-agent-design.md) |
| Someone proposes probes, steering vectors or SAE features; designing a stuck or drift detector | [references/agent-internal-signals.md](references/agent-internal-signals.md) |

Related skills: `token-efficiency` (context size and prompt-cache rules), `agent-fleet-orchestration`
(splitting work across subagents), `automation-design` and `autonomous-watch-loop` (supervisors and
watch loops), `error-handling-patterns` (code-level retry and idempotency).
