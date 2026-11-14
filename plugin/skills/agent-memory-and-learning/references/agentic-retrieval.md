# Agentic retrieval

Use when: designing or tuning an agent's RAG or search tool (single shot versus a multi-step loop, rounds,
when to skip or stop, code search), or when an agent over-searches or loops on search or grep.

Most numbers come from one or two benchmark papers with small models: defaults to test, not laws.

## Rules

1. **Upgrade the single shot first (for prose corpora):** hybrid retrieval (BM25 plus dense) and a
   cross-encoder reranker, with k = 3-5. For code, test the reranker before keeping it (rule 6). On HotpotQA
   with a 7B model a reranker added +1.7 EM at negligible latency, while up-front query decomposition added
   +1.4 EM and doubled latency, 2,546 to 5,642 ms (2606.21553).
2. **Add a loop only for multi-hop questions, and cap it at 2-3 rounds.** The agentic pipeline beat
   single-pass dense retrieval by +10.1 EM, but two rounds kept 95% of a five-round gain (2606.21553). Gains
   rise until about three searches: o4-mini on HotpotQA scored 70.17% with one, 86.05% with two, 92.92%
   unlimited (2603.08877).
3. **Stop on a cheap signal, but keep a stop-and-answer check.** An entropy-only stopper saved 38% of tokens
   with no measured quality change; a full quality-gated stop cost +129% tokens (2606.27009). Without an "is
   the evidence enough?" check, DynaKRAG's retrieval steps rose to about 4 and F1 fell (2607.06507).
4. **Do not retrieve by default, and do not retrieve a lot.** Ten passages cost about 8.5% accuracy against
   five, and a gate skipped about 65% of TriviaQA retrievals at near-matched accuracy (2606.29959).
5. **A reranker cannot recover what the first stage missed.** If the right document is not in the
   candidates, re-retrieve or rewrite the query (2611.08014), but only then, not as a default step. HyDE
   still helped after a strong reranker (-6.7 F1 when removed) on a mixed-format benchmark, while fusion,
   routing and corrective re-retrieval did not; on homogeneous benchmarks nothing helped (2606.28367).
6. **For code, add structure and keep the toolset small.** Grep plus graph anchors reached Acc@5 87.0
   against 74.1-75.2 for Codex and Claude Code, at 353K against 521.8K tokens for Codex (2605.16352). For
   single-function tasks BM25 often beat dense retrieval, and re-ranking was generally detrimental to
   functional correctness (2605.14503). One symbol-jump tool beat multi-tool navigation in an RL-trained
   agent: adding three tools cut function-level IoU from 24.28 to 13.71 (2512.20957).
7. **Read the whole note or file, not the snippet.** Whole-note hits lifted a score from 0.57 to 0.67, about
   60% of a graph pipeline's gain (operator spike, 12 questions).
8. **Keep the index honest.** Stale retrieved context raised stale-reference rates by 88.2 points (n = 17,
   2605.14478). After editing notes, old wording ranks until the index refreshes, and a refresh scoped to one
   collection can rebuild the index with only that collection, so re-check retrieval across all of them.
9. **Judge the loop end to end.** Static relevance scores did not predict what a multi-step agent needed
   (Spearman rho = -0.026, 23,322 observations, 2607.15253). Log calls, tokens and answer accuracy per
   question; do not tune on recall@k alone.

## Counter-evidence and limits

- Gains vary by model and dataset: o4-mini gained under 1.10 points from planning and reflection on HotpotQA
  but +25 on 2WikiMultihopQA (2603.08877).
- Several cheap searches can beat one big one: GPT-4.1-mini on 2Wiki scored 55.84% at 500 tokens against
  30.62% with one search at 16K tokens (2603.08877).
- Gating added about 27% latency on a small model (2606.29959); stopping studies are small (about 60 items).

## Gaps

- No better-first-stage versus agentic-loop comparison at equal tokens or latency.
- No up-front decomposition versus adaptive next-query head-to-head on one backbone.
- No same-model grep-only versus embedding RAG comparison on SWE-bench.
- Query phrasing and the ideal number of searches per task are unmeasured.
