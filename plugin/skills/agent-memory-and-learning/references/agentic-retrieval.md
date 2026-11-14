# Agentic retrieval

Use when: designing or tuning an agent's RAG or search tool (single shot versus a multi-step loop, rounds,
when to skip or stop, code search, what to do when retrieved evidence is bad), or when an agent
over-searches or loops on search or grep.

Most numbers come from one or two benchmark papers with small models: defaults to test, not laws. Index
side (reranker choice, chunking, hybrid and graph indexes): [retrieval index design](retrieval-index-design.md).

## Rules

1. **Upgrade the single shot first (for prose corpora):** a cross-encoder reranker with k = 3-5, and hybrid
   retrieval (BM25 plus dense) if it wins on your corpus (it lost on one, [index
   design](retrieval-index-design.md) rule 5). For code, test the reranker before keeping it (rule 6). On
   HotpotQA with a 7B model a reranker added +1.7 EM at negligible latency, while up-front query
   decomposition added +1.4 EM and doubled latency, 2,546 to 5,642 ms (2606.21553); another paper measured
   +11.8% latency for a cross-encoder, and LLM rerankers take seconds ([index
   design](retrieval-index-design.md) rule 1).
2. **Add a loop only for multi-hop questions, and cap it at 2-3 rounds.** The agentic pipeline beat
   single-pass dense retrieval by +10.1 EM, but two rounds kept 95% of a five-round gain (2606.21553). Gains
   rise until about three searches: o4-mini on HotpotQA scored 70.17% with one, 86.05% with two, 92.92%
   unlimited (2603.08877).
3. **Stop on a cheap signal, but keep a stop-and-answer check.** An entropy-only stopper saved 38% of tokens
   with no measured quality change; a full quality-gated stop cost +129% tokens (2606.27009). Without an "is
   the evidence enough?" check, DynaKRAG's retrieval steps rose to about 4 and F1 fell (2607.06507).
4. **Do not retrieve by default, and do not retrieve a lot.** With small models, retrieval harm (right answer
   turned wrong) reached 8.8% of items even though average accuracy still rose (2607.24010). Ten passages cost about 8.5% accuracy against
   five, and a gate skipped about 65% of TriviaQA retrievals at near-matched accuracy but under 3% on NQ
   (2606.29959). Irrelevant passages hurt more than their share: 9 noise passages cut NQ EM from 43.2% to
   22.2-26.6%, and pure noise scored 8.0% against 23.6% with no retrieval (2605.00505, a perspective paper,
   one 500-sample 7B experiment); random retrieval scored below zero-shot on code problems, 17.28% vs 17.9%
   (2611.09791).
5. **A reranker cannot recover what the first stage missed.** If the right document is not in the
   candidates, re-retrieve or rewrite the query (2611.08014), but only then, not as a default step. HyDE
   still helped after a strong reranker (-6.7 F1 when removed) on a mixed-format benchmark, as did a
   per-source calibrator (-2.5), while RAPTOR, graph expansion, fusion, routing and corrective re-retrieval
   each moved F1 by under 0.5; on homogeneous benchmarks nothing helped (2606.28367). So do not stack a
   relevance grader or corrective loop on a strong reranker: CRAG plus citation pruning raised citation
   faithfulness (0.758) but gave no significant accuracy gain (2607.14400), and a grader is only as good
   as its model (9.9% decision correctness at 8B against 52.5% at 32B, 2606.18385, vision-language). Caveat:
   2606.28367 used one reranker, one generator and three benchmarks, and its no-reranker baseline (nDCG@10
   0.034) looks implausibly low, so read its reranker jump (F1 0.249 to 0.548) as an upper bound.
6. **For code, add structure and keep the toolset small.** Grep plus graph anchors reached Acc@5 87.0
   against 74.1-75.2 for Codex and Claude Code, at 353K against 521.8K tokens for Codex (2605.16352). For
   single-function tasks BM25 often beat dense retrieval, and re-ranking was generally detrimental to
   functional correctness (2605.14503). One symbol-jump tool beat multi-tool navigation in an RL-trained
   agent: adding three tools cut function-level IoU from 24.28 to 13.71 (2512.20957). An agentic file
   localizer reached Top-1 86.7% on SWE-bench Lite at over 18x lower cost than LocAgent (2605.17965);
   such gains are measured against grep-based agents, not against embeddings.
7. **Read the whole note or file, not the snippet.** Whole-note hits lifted a score from 0.57 to 0.67, about
   60% of a graph pipeline's gain (operator spike, 12 questions).
8. **Keep the index honest.** Stale retrieved context raised stale-reference rates by 88.2 points (n = 17,
   2605.14478). After editing notes, old wording ranks until the index refreshes, and a refresh scoped to one
   collection can rebuild the index with only that collection, so re-check retrieval across all of them.
   Make freshness and duplication checks deterministic: superseding old facts by key took evolving-task
   accuracy from 0.20-0.47 (RAG) to 0.95-1.00 with no LLM call, at a cost in static recall (0.82 vs 0.86)
   (2606.26511). Three copies of a false claim raised acceptance from 0.06 to 0.71; provenance notes did
   not help, collapsing copies to one report per chain did (2611.09203). Verify quotes an agent returns
   with a substring check against the cited file, requiring every segment of an elided quote to match (a
   practice from the author's runs).
9. **Judge the loop end to end.** Static relevance scores did not predict what a multi-step agent needed
   (Spearman rho = -0.026, 23,322 observations, 2607.15253). Log calls, tokens and answer accuracy per
   question; do not tune on recall@k alone.
10. **Put the best passage first, and prune with care.** Gold-first beat gold-last by 16 to 26 points for
   7-8B readers, and MMR or rank-based reordering did not close the gap (2606.16494). Pruning to 50% of
   context kept HotpotQA F1 at 0.830 against 0.845 but lost 7.7 points cross-domain (2607.16209);
   budget-aware packing gains vanished above a 7B reader (2607.00725).
11. **Add a sufficiency check with a refusal path only where a wrong answer costs more than a refusal, and
   measure the correctness it loses.** An answerability gate raised abstention-at-detection from 41.1% to
   99.8% and lowered well-defined correctness from 91.8% to 86.8% (2605.28070). A trained verifier cut risk
   at 30% coverage from 0.2588 to 0.1642 and beat a GPT-4o judge in-domain (0.9075 vs 0.7284 macro-F1) but
   scored 0.3343 unsafe-F1 on HaluBench against 0.7389 for GPT-4o (2605.03534). Prompted abstention was
   unreliable for code models (2610.11300). Letting the agent ask the user lifted a coding agent from 54.8%
   to 69.4% resolved at about $1.40-$3.50 per task (2603.26233).
12. **Expect the reader to override evidence that contradicts its priors** (47.1% for gpt-4o-mini,
   2606.23695); a conflict-decomposition prompt lifted misconception accuracy from 15.0% to 62.0% but
   cost 18 clean-accuracy points (2605.14473).
13. **For untrusted corpora, test guards against an adaptive attacker.** A three-ring defense cut
   non-adaptive attack success from 79% to 1%, but an adaptive attacker left the pipeline at 62% against
   56% undefended (2607.23838; [untrusted-content defense](../../agent-safety/references/untrusted-content-defense.md)).

## Counter-evidence and limits

- Gains vary by model and dataset: o4-mini gained under 1.10 points from planning and reflection on HotpotQA
  but +25 on 2WikiMultihopQA (2603.08877).
- Several cheap searches can beat one big one: GPT-4.1-mini on 2Wiki scored 55.84% at 500 tokens against
  30.62% with one search at 16K tokens (2603.08877).
- Gating added about 27% latency on a small model (2606.29959); stopping studies are small (about 60 items for 2606.27009).

## Gaps

- No better-first-stage versus agentic-loop comparison at equal tokens or latency.
- No up-front decomposition versus adaptive next-query head-to-head on one backbone.
- No same-model grep-only versus embedding RAG comparison on SWE-bench.
- Query phrasing and the ideal number of searches per task are unmeasured.
- No accuracy-per-k curve (k = 3, 5, 10, 20) on one reader; HyDE's gain rests on one paper.
- No per-passage grader versus none ablation on answer accuracy, no grader cost figure, and no bigger
  reranker versus grader-plus-re-retrieval comparison at matched compute.
- No accuracy and hallucination numbers for plain "I don't know" prompting in RAG QA.
