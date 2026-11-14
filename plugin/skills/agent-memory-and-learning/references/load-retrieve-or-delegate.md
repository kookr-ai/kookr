# Load it, retrieve it, or delegate the reading

Use when an agent must work from much more material than it needs (a codebase, a document set, long logs,
a long history). Decide what goes into its context window: load everything, retrieve pieces on demand, or
split the reading across sub-agents with isolated contexts. Use it also when an answer from a long context
is wrong and you are deciding whether to add retrieval.

Most numbers come from single papers with one corpus or small models. Treat them as defaults to test, not
laws. How to tune the retrieval tool itself (k, rerankers, loops, code search):
[agentic retrieval](agentic-retrieval.md). How to manage context inside one long run (prefix caching,
pruning, summaries): the `token-efficiency` skill.

## Rules

1. **Do not fill the window by default.** In the head-to-heads we found, a small, selected context matched
   or beat the full one at a fraction of the tokens. RAG with under 8K tokens beat 120K of long context by
   0.17 to 9.83 F1 points on clinical imaging extraction (it only matched on timelines), and long-context gains stopped between 64K and
   120K (2508.14817). Full context cost $10.22 against $0.65 for RAG at 77.16% vs 78.31% accuracy on
   LoCoMo (2601.07978). RL-trained context curation beat full context on WebArena, 41.2% vs 36.4%
   (2604.11462; curation, not retrieval).
2. **Choose by the question's shape:**
   - **Point lookup or extraction** (the answer sits in a few places): retrieve or navigate.
   - **Breadth or aggregation** (count, compare, collect everything): fan the reading out to cheap
     readers that return evidence, and keep the reasoning in one agent. Small readers writing evidence
     cards for one aggregator recalled 0.994 of the supporting chunks against 0.33 to 0.57 for dense
     RAG. They scored 83.8% against 80.0% at about 5.2×10¹⁶ FLOPs, against 2.4×10¹⁷ for full context
     (2606.28349, no full-context accuracy reported).
   - **Load everything** only when the material is small, retrieval demonstrably misses evidence, and the
     prefix is reused across turns so it caches. Long context can be enough for small repositories
     (2510.04905, survey, no numbers). No paper gives the size at which loading stops paying.
3. **Split the reading, not the thinking.** Readers return claim, quote and location, never conclusions.
   Spreading deliberation across a hierarchy gave up to 3.37x worse mean return (one model) and used 1.8
   to 2.7x more tokens (2605.16205). Expanded orchestration cut GAIA Level-1 accuracy from 54.72% to 50.94%
   (2605.14102; 53 tasks, a 2-task gap). A
   persistent search sub-agent did pay off: navigation output fell from 13.92K to 6.02K tokens, and pass
   rate rose from 69.8% to 71.6% (2605.27787). Readers pay off when they are cheap-tier and return
   compact, quoted evidence. Size the fan-out with `agent-fleet-orchestration`.
4. **Measure retrieval recall before you trust it.** Retrieval missed 32% of gold medications at 20 chunks
   (2508.14817), and top-5 table retrieval cut QA F1 from 0.755 (oracle) to 0.330 (2607.17742). Check a
   few questions with known answers against an oracle context. If recall is low, rewrite the query or
   load the source. Raising k can hurt: ten passages cost about 8.5% accuracy against five with a small
   model (2606.29959; see [agentic retrieval](agentic-retrieval.md) rule 4).
5. **When a long-context answer is wrong, check whether the evidence was already in the window.** It
   usually was in MemTrace: relevant evidence was retrievable about 10 times more often than missing when systems
   failed, and gold-evidence-only context lifted hard probes from 0-33.8% to 80-85% (2606.17328). Models
   "reason well on short proxy contexts" of essential evidence but poorly on the full context
   (2605.20201). The fix is to shrink the context to that evidence and ask again. More retrieval will not
   help.
6. **Expect length to erode attention and obedience, and put what matters first.** A frontier monitor's
   recall fell from 98.6% to 88% with 800K benign tokens prepended (Opus 4.6, 2605.12366). With the gold
   passage first rather than last, accuracy was 16-26 points higher, and reranking or reordering did not
   close the gap (2606.16494, multimodal KB-VQA, 7-8B readers). Over long, updated histories, multi-target
   aggregation scored 26.5% against 47.5% for simple single-target recall (2605.18565). That gap is
   question type, not length alone.

## Anti-patterns

- Pasting a whole corpus "so nothing is missed", then trusting the answer without checking where its
  evidence came from.
- Raising k or adding a retrieval round when the evidence was already in the window (rule 5).
- Sub-agents that return summaries or verdicts instead of quotes, so the lead cannot check them.
- Splitting a task whose steps depend on each other across agents to save context (rule 3).
- Comparing context strategies on one answer type. Compact memory beat raw-turn RAG on value answers
  (temporal +25.5) and lost on phrasing answers (adversarial −14.6) (2611.09807).

## Evidence against

- The cleanest long-context-vs-RAG comparison is one hospital, 200 stays and a non-agentic RAG, and every
  method was flat on diagnosis generation (2508.14817).
- LongCoT reads its frontier collapse (9.83% for GPT 5.2) as a failure of long-horizon planning and
  error correction more than of context length (2604.14140).
- The evidence-card result beats dense RAG. The note reports no full-context accuracy, so it is not shown
  to beat a full read (2606.28349).

## Gaps

- No router that picks long context or RAG per query (Self-Route style) with numbers.
- No per-model accuracy curve at 8K, 32K, 128K and 1M tokens, and no classic "lost in the middle" curve
  for frontier text models.
- No same-model, same-benchmark comparison of chunked sub-agent reading (recursive LMs, chain-of-agents,
  MapReduce) against one full read, with both accuracy and cost.
- No measure of evidence lost when a fact spans two chunks.
- No dollar comparison on hosted frontier APIs with prompt caching.

Source report: `agentic-capability-reports` KB, note
`2026-11-14-long-context-vs-retrieval-vs-subagent-reading` (`kb search "load retrieve or delegate"`).
