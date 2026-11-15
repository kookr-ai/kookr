# Load it, retrieve it, or delegate the reading

Use when: an agent must work from much more material than it needs (a codebase, a document set, long logs, a
long history) and you must decide what goes into its window: load everything, retrieve pieces on demand, or
split the reading across sub-agents. Also when an answer from a long context is wrong and you are deciding
whether to add retrieval.

Defaults to test, not laws. Tuning the retrieval tool: [agentic retrieval](agentic-retrieval.md). Managing
context inside one long run (caching, pruning, summaries): the `token-efficiency` skill.

1. **Do not fill the window by default.** A small, selected context matched or beat the full one at a
   fraction of the tokens: RAG under 8K tokens beat 120K of long context on one extraction task, and full
   context cost about 16x more for equal accuracy on a memory benchmark. Learned context curation beat full
   context on a web-agent benchmark.
2. **Choose by the question's shape:**
   - **Point lookup or extraction** (the answer sits in a few places): retrieve or navigate.
   - **Breadth or aggregation** (count, compare, collect everything): fan the reading out to cheap readers
     that return evidence, and keep the reasoning in one agent. Small readers writing evidence cards for one
     aggregator recalled 0.99 of the supporting chunks against 0.33-0.57 for dense RAG, at about a fifth of
     full-context compute (no full-context accuracy reported).
   - **Load everything** only when the material is small, retrieval demonstrably misses evidence, and the
     prefix is reused across turns so it caches. No study gives the size at which loading stops paying.
3. **Split the reading, not the thinking.** Readers return claim, quote and location, never conclusions.
   Spreading deliberation across a hierarchy gave up to 3x worse return (one model) at 2-3x tokens. A persistent search
   sub-agent did pay off, halving navigation output. Readers pay off when they are cheap-tier and return
   compact, quoted evidence. Size the fan-out with `agent-fleet-orchestration`.
4. **Measure retrieval recall before you trust it.** Retrieval missed 32% of gold items at 20 chunks, and
   top-5 table retrieval cut QA F1 from 0.76 (oracle) to 0.33. Check a few questions with known answers
   against an oracle context. If recall is low, rewrite the query or load the source. Raising k can hurt
   (see [agentic retrieval](agentic-retrieval.md), do not retrieve a lot).
5. **When a long-context answer is wrong, check whether the evidence was already in the window.** It usually
   was: gold-evidence-only context lifted hard probes from 0-34% to 80-85%, and models reason well on short
   proxy contexts of the essential evidence but poorly on the full one. Shrink the context to that evidence
   and ask again; more retrieval will not help.
6. **Expect length to erode attention and obedience, and put what matters first.** A frontier monitor's
   recall fell from 99% to 88% with 800K benign tokens prepended. Gold passage first beat last by 16-26
   points, and reordering did not close the gap. Aggregation over long histories scored about half of
   single-target recall, which is question type, not length alone.

Do not:
- Paste a whole corpus "so nothing is missed", then trust the answer without checking where its evidence
  came from.
- Raise k or add a retrieval round when the evidence was already in the window (rule 5).
- Let sub-agents return summaries or verdicts instead of quotes; the lead cannot check them.
- Split a task whose steps depend on each other across agents to save context.
- Compare context strategies on one answer type: compact memory beat raw-turn RAG on value answers and lost
  on phrasing answers.

Evidence: kb://agentic-capability-reports/notes/2026-11-14-long-context-vs-retrieval-vs-subagent-reading.md
