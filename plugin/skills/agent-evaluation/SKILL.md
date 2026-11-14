---
name: agent-evaluation
group: design-analysis
keywords: agent evaluation, citation verification, claim support, benchmark, LLM judge, verifier, merge gate, patch acceptance, keep gate, noise floor, self-evolution, prompt optimization
related: independent-merge-review, autonomous-review-loop, pre-pr-review, agent-fleet-orchestration, agent-memory-and-learning
description: Agent evaluation and acceptance gates. Decides whether a benchmark score gap between agent setups is real, which verifier or LLM judge should gate an agent's output, whether a coding agent's passing patch is mergeable, and how to keep mutate-and-score loops honest (keep gate, noise floor, held-out split), including harness self-evolution and prompt or skill optimization on a small eval budget, in-house regression suites, agents with growing memory or skills, research ideas and write-ups, and checking that cited claims are supported by their sources. Use when comparing agent configs, designing a merge or acceptance gate, accepting agent patches, or running or trusting a self-improvement loop.
---
# Agent evaluation

Evidence-based rules, each with the paper figure behind it and a list of what the evidence does not show,
for deciding whether an agent's result is real and acceptable.

Read only the guide that matches the decision in front of you (several if the task spans them).

| Decision you face | Read |
|---|---|
| Two agent setups (model, harness, prompt, skill, tools) score differently and you must pick one or publish the gap | [references/agent-evaluation-method.md](references/agent-evaluation-method.md) |
| You are building an eval suite from your own repo history, or gating an agent update on your own tasks | [references/in-house-regression-suite.md](references/in-house-regression-suite.md) |
| An arm under test carries memory, a notebook or skills that grow from its own tasks | [references/stateful-agent-evaluation.md](references/stateful-agent-evaluation.md) |
| You are adding a test, LLM judge, reviewer or other gate that accepts or rejects an agent's output | [references/agent-output-verification.md](references/agent-output-verification.md) |
| A coding agent's patch passes its tests and you must decide whether to merge it, or you are briefing a coding worker | [references/coding-agent-patch-acceptance.md](references/coding-agent-patch-acceptance.md) |
| A loop proposes, measures and keeps or reverts changes, and you must set or trust its keep gate | [references/autonomous-experiment-loops.md](references/autonomous-experiment-loops.md) |
| An agent will evolve its own prompts, tools, skills or control code over generations | [references/agent-self-evolution.md](references/agent-self-evolution.md) |
| You want to auto-tune a prompt, skill, brief or CLAUDE.md with a few hundred evaluation calls | [references/prompt-optimization-under-budget.md](references/prompt-optimization-under-budget.md) |
| A research agent proposes ideas to fund, or hands you a write-up whose claims you must trust | [references/research-ideas-and-writeups.md](references/research-ideas-and-writeups.md) |
| An agent or worker cites retrieved sources, and you must check each claim is supported by its cited source | [references/cited-claim-verification.md](references/cited-claim-verification.md) |

The keep-gate rules shared by the loop, self-evolution and prompt-optimization guides live in the
experiment-loops guide; the other two point to it.

Related skills: `independent-merge-review` (exact-head merge verdict), `pre-pr-review` (self-review before a
PR), `autonomous-review-loop` (bounded implement-and-review cycles), `agent-fleet-orchestration` (blind
test writers, worker briefs).
