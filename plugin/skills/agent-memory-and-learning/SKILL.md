---
name: agent-memory-and-learning
group: design-analysis
description: >
  Agent memory and learning: what to write to memory, consolidate or forget; post-task lessons and lesson-store
  curation; gating learned memory, skill or weight changes against regressions on earlier tasks; agentic
  retrieval (single-shot vs multi-step search, stopping, code search); skill-library design; and making a
  cheaper or local model do a strong model's work (harness tuning first, then fine-tuning). Use when designing
  or reviewing a memory store, notebook, RAG tool or skill library, or before downgrading a worker model.
---

# Agent Memory and Learning

Evidence-based rules, each with its paper citation and a list of what the evidence does not show, for what an
agent should remember, retrieve and learn. Read only the guide that matches the decision in front of you
(several if the task spans them).

| Decision you face | Read |
|---|---|
| Adding a memory store or notes file to a long-running agent; deciding what to write, when to consolidate, what to forget; memory is costly, stale or possibly poisoned | [references/agent-memory-policy.md](references/agent-memory-policy.md) |
| A task just ended and you must decide whether and what lesson to record; designing, gating or curating a lessons file, notebook or retrospective that is growing noisy | [references/post-task-lesson-capture.md](references/post-task-lesson-capture.md) |
| Accepting a learned memory, lesson, skill or prompt edit, or fine-tuning a worker on its own runs, and you need to know it did not break earlier tasks; choosing memory vs weights | [references/agent-continual-learning.md](references/agent-continual-learning.md) |
| Building or tuning a RAG or search tool; an agent over-searches or loops on search or grep; choosing rounds, k, reranking, stopping, or how to search code | [references/agentic-retrieval.md](references/agentic-retrieval.md) |
| Adding or editing a SKILL.md, rule block or tool description set; an agent ignores or is misled by its skills; a library keeps growing; prose skill vs coded tool | [references/skill-library-design.md](references/skill-library-design.md) |
| A cheap, small or local model underperforms a strong one; moving work to a cheaper tier; about to fine-tune or distill an agent model | [references/cheap-worker-adaptation.md](references/cheap-worker-adaptation.md) |

Related skills: `notebook-role-reuse` (the `nb` notebook commands), `placement-picker` (where a rule, skill or
memory should live), `self-reflect` and `task-feedback-reflect` (turning a correction into one structural fix),
`agent-fleet-orchestration` (which model tier a task needs).
