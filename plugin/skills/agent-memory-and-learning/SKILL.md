---
name: agent-memory-and-learning
group: design-analysis
keywords: agent memory, lessons, notebook, continual learning, regression gate, RAG, retrieval, long context, context window, skill library, fine-tuning, distillation, cheap model
related: notebook-role-reuse, placement-picker, self-reflect, task-feedback-reflect, agent-fleet-orchestration, agent-evaluation
description: >
  Agent memory and learning: what to write to memory, consolidate or forget, and shared fleet memory; one
  person's evolving preferences; post-task lessons and lesson-store curation; gating learned memory, skill or
  weight changes against regressions on earlier tasks; agentic retrieval (single-shot vs multi-step search,
  stopping, code search, bad evidence), whether to load material into the window, retrieve it or delegate
  the reading to sub-agents, and index design (reranker, chunking, hybrid, graph); skill-library
  design; and making a cheaper or local model do a strong model's work (harness tuning first, then
  fine-tuning, synthetic training tasks). Use when designing or reviewing a memory store, notebook, RAG tool
  or skill library, or before downgrading a worker model.
---

# Agent Memory and Learning

Evidence-based rules, each with its paper citation and a list of what the evidence does not show, for what an
agent should remember, retrieve and learn. Read only the guide that matches the decision in front of you
(several if the task spans them).

| Decision you face | Read |
|---|---|
| Adding a memory store or notes file to a long-running agent; deciding what to write, when to consolidate, what to forget, who triggers reads and writes, or what a fleet shares; memory is costly, stale or possibly poisoned | [references/agent-memory-policy.md](references/agent-memory-policy.md) |
| An agent serves one person over weeks or months and must learn their preferences, track changes, resolve contradictions, or decide when to ask | [references/preference-memory.md](references/preference-memory.md) |
| A task just ended and you must decide whether and what lesson to record; designing, gating or curating a lessons file, notebook or retrospective that is growing noisy | [references/post-task-lesson-capture.md](references/post-task-lesson-capture.md) |
| Accepting a learned memory, lesson, skill or prompt edit, or fine-tuning a worker on its own runs, and you need to know it did not break earlier tasks; choosing memory vs weights | [references/agent-continual-learning.md](references/agent-continual-learning.md) |
| Building or tuning a RAG or search tool; an agent over-searches or loops on search or grep; choosing rounds, k, reranking, stopping, or how to search code; retrieved evidence is noisy, stale, insufficient or adversarial | [references/agentic-retrieval.md](references/agentic-retrieval.md) |
| Material is much larger than what the agent needs (codebase, document set, long logs): load it all into the window, retrieve pieces, or split the reading across sub-agents; a long-context answer is wrong and you are deciding whether to add retrieval | [references/load-retrieve-or-delegate.md](references/load-retrieve-or-delegate.md) |
| Choosing a reranker and rerank depth, chunk size, or whether to add hybrid search or a graph index | [references/retrieval-index-design.md](references/retrieval-index-design.md) |
| Adding or editing a SKILL.md, rule block or tool description set; an agent ignores or is misled by its skills; a library keeps growing; prose skill vs coded tool | [references/skill-library-design.md](references/skill-library-design.md) |
| A cheap, small or local model underperforms a strong one; moving work to a cheaper tier; about to fine-tune or distill an agent model, or distill a debate, search or long prompt into weights | [references/cheap-worker-adaptation.md](references/cheap-worker-adaptation.md) |
| Training a small agent without enough real runs: mining, generating or gating training tasks and environments | [references/training-task-synthesis.md](references/training-task-synthesis.md) |

Related skills: `notebook-role-reuse` (the `nb` notebook commands), `placement-picker` (where a rule, skill or
memory should live), `self-reflect` and `task-feedback-reflect` (turning a correction into one structural fix),
`agent-fleet-orchestration` (which model tier a task needs).
