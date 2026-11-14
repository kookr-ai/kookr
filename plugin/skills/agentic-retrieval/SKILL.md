---
name: agentic-retrieval
group: design-analysis
description: >
  Decide how an agent should retrieve evidence from a document corpus, knowledge base or codebase: how
  much to build into single-shot retrieval (hybrid search, a reranker, a small top-k) before adding a
  multi-step loop, how many rounds to allow, when to skip retrieval, how to stop cheaply, and how to
  search code. Use when designing or tuning a RAG or search tool for an agent, when an agent over-searches
  or loops on `kb search` or grep, when choosing between decomposing a question up front and searching
  adaptively, or when deciding whether a retrieval change is worth its latency.
---

# Agentic retrieval

Evidence comes from a literature survey of local paper notes (`agentic-rag`, `llm-agents`,
`ai-software-engineering`, `llm-memory`) and operator lessons. Most numbers come from one or two
benchmark papers with small models, so treat them as defaults to test, not laws.

## Rules

1. **Upgrade the single shot first.** Use hybrid retrieval (BM25 plus dense) and a cross-encoder
   reranker, with k = 3-5. On HotpotQA with a 7B model a reranker added +1.7 EM at negligible latency,
   while up-front query decomposition added +1.4 EM and doubled latency, 2,546 to 5,642 ms (2606.21553).
   In one agent setup hybrid gave +6.36 points and hybrid plus reranking +9.29 (2603.08877).
2. **Add a loop only for multi-hop questions, and cap it at 2-3 rounds.** The full agentic pipeline beat
   single-pass dense retrieval by +10.1 EM and +7.6 F1, but two rounds kept 95% of a five-round gain
   (2606.21553). Accuracy plateaus near three searches: o4-mini on HotpotQA scored 70.17% with one
   search, 86.05% with two, 92.92% with an unlimited number (2603.08877).
3. **Stop on a cheap signal.** An entropy-only stopper saved 38% of tokens with no measured quality
   change; a full quality-gated stop cost +129% tokens (2606.27009). A stop-and-answer check ("is the
   evidence enough?") matters: without it DynaKRAG's retrieval steps rose to about 4 and F1 fell
   (2607.06507). A trained policy cut search calls from 3.24 to 1.63 (2607.09092).
4. **Do not retrieve by default, and do not retrieve a lot.** Always retrieving cost up to 8.8% accuracy
   against skipping it on some items (2607.24010). Ten passages cost about 8.5% accuracy against five,
   and a gate skipped about 65% of TriviaQA retrievals at near-matched accuracy (2606.29959). Top-k from
   2 to 5 raised Hit@k from 0.726 to 0.834 but lowered EM from 0.455 to 0.367 (2606.28337).
5. **A reranker cannot recover what the first stage missed.** If the right document is not in the
   candidates, re-retrieve or rewrite the query (2611.08014). Query expansion (HyDE) still helped after
   a strong reranker (-6.7 F1 when removed), while fusion, routing and corrective re-retrieval did not
   (2606.28367).
6. **For code, add structure and keep the toolset small.** Grep plus graph anchors reached Acc@5 87.0
   against 74.1-75.2 for Codex and Claude Code, with fewer tokens (2605.16352). One symbol-jump tool beat
   multi-tool navigation: adding three tools cut function-level IoU from 24.28 to 13.71 (2512.20957). For
   single-function code tasks BM25 often beat dense retrieval (2605.14503).
7. **Read the whole note or file, not the snippet.** In an operator spike, printing hits as whole notes
   lifted a score from 0.57 to 0.67, about 60% of a graph pipeline's gain (agent-task-lessons).
8. **Keep the index honest.** Stale retrieved context raised stale-reference rates by 88.2 points in one
   small study (n = 17, 2605.14478), and outdated memory caused 64% of recommendation errors in another
   (2604.20006). After editing notes, expect old wording to rank until the index refreshes. A scoped
   `kb search --refresh` can rebuild the index with only that scope, so check with a cross-KB search.
9. **Judge the loop end to end.** Static relevance scores did not predict what a multi-step agent needed
   (Spearman rho = -0.026, 23,322 observations, 2607.15253). Log calls, tokens and answer accuracy per
   question; do not tune on recall@k alone.

## Anti-patterns

- Starting with a deep decompose-and-iterate loop before measuring one hybrid-plus-rerank pass.
- Running a model judge after every round to decide whether to stop.
- Raising k to improve recall without checking answer accuracy.
- Giving a code agent many overlapping navigation tools.
- Trusting the top snippet without opening the source, or an index that was not refreshed.

## Counter-evidence and limits

- Gains vary by model and dataset: o4-mini gained under 1.10 points from planning and reflection on
  HotpotQA but +25 points on 2WikiMultihopQA (2603.08877).
- Several cheap searches can beat one big one: GPT-4.1-mini on 2Wiki scored 55.84% at 500 tokens with
  several searches against 30.62% with one search at 16K tokens (2603.08877).
- Gating added about 27% latency on a small model (2606.29959). Stopping studies are small (about 60
  items for 2606.27009).

## Gaps

No paper compares a better first stage against an agentic loop at equal tokens or latency. No head-to-head
of up-front decomposition against adaptive next-query on one backbone. No same-model grep-only against
embedding RAG comparison on SWE-bench. Query phrasing and an ideal number of searches per task are
unmeasured. Report: `agentic-capability-reports` note `2026-11-14-agentic-multi-step-vs-single-shot-retrieval`.
