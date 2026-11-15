# Agentic retrieval

Use when: designing or tuning an agent's RAG or search tool (single shot versus a multi-step loop, rounds,
when to skip or stop, code search, what to do when retrieved evidence is bad), or when an agent
over-searches or loops on search or grep.

Numbers come from one or two small-model studies: defaults to test, not laws. Index side (reranker,
chunking, hybrid and graph indexes): [retrieval index design](retrieval-index-design.md).

1. **Upgrade the single shot first (for prose corpora):** a cross-encoder reranker with k = 3-5, and hybrid
   retrieval (BM25 plus dense) if it wins on your corpus. For code, test the reranker before keeping it.
   A reranker added +1.7 EM at negligible latency; up-front query decomposition added +1.4 EM and doubled
   latency. LLM rerankers take seconds (see [index design](retrieval-index-design.md)).
2. **Add a loop only for multi-hop questions, and cap it at 2-3 rounds.** The agentic pipeline beat
   single-pass dense retrieval by +10 EM, but two rounds kept 95% of a five-round gain; accuracy rose until
   about three searches. Several cheap searches can beat one big one. Gains vary by model and dataset.
3. **Stop on a cheap signal, but keep a stop-and-answer check.** An entropy-only stopper saved 38% of tokens
   with no measured quality change; a full quality-gated stop cost +129% tokens. Without an "is the evidence
   enough?" check, retrieval steps rose and F1 fell.
4. **Do not retrieve by default, and do not retrieve a lot.** With small models retrieval turned right
   answers wrong on up to 9% of items; ten passages cost about 8.5% accuracy against five. A gate skipped
   about 65% of retrievals on one dataset but under 3% on another. Irrelevant passages hurt more than their
   share: nine noise passages roughly halved EM, and random retrieval scored below zero-shot on code.
5. **A reranker cannot recover what the first stage missed.** If the right document is not in the candidates,
   re-retrieve or rewrite the query, but only then. Do not stack a relevance grader or corrective loop on a
   strong reranker: corrective re-retrieval moved F1 under 0.5, a grader loop gave no significant accuracy
   gain, and a grader is only as good as its model (10% decision
   correctness at 8B vs 52% at 32B). HyDE (hypothetical-answer query expansion) and per-source calibration
   still helped on a mixed-format benchmark; on homogeneous ones nothing did. Read the reranker's reported
   jump as an upper bound.
6. **For code, add structure and keep the toolset small.** Grep plus graph anchors beat Codex and Claude Code
   on Acc@5 (87 vs about 75) at about two-thirds of the tokens. For single-function tasks BM25 often beat
   dense retrieval and re-ranking hurt correctness. One symbol-jump tool beat multi-tool navigation: adding
   three tools nearly halved localization IoU. These gains are measured against grep-based agents, not
   embeddings.
7. **Read the whole note or file, not the snippet.** Whole-note hits lifted a score from 0.57 to 0.67, about
   60% of a graph pipeline's gain (operator spike, 12 questions).
8. **Keep the index honest.** Stale retrieved context raised stale-reference rates sharply. After editing
   notes, old wording ranks until the index refreshes, and a refresh scoped to one collection can rebuild
   the index with only that collection, so re-check retrieval across all of them. Make freshness and
   duplication checks deterministic: superseding old facts by key took evolving-task accuracy from 0.2-0.5
   to about 1.0 with no LLM call, at a small cost in static recall. Three copies of a false claim raised
   acceptance from 0.06 to 0.71; provenance notes did not help, collapsing copies to one report per chain
   did. Verify quotes an agent returns with a substring check against the cited file, requiring every
   segment of an elided quote to match.
9. **Judge the loop end to end.** Static relevance scores did not predict what a multi-step agent needed.
   Log calls, tokens and answer accuracy per question; do not tune on recall@k alone.
10. **Put the best passage first, and prune with care.** Gold-first beat gold-last by 16-26 points for 7-8B
   readers, and reordering did not close the gap. Pruning to half the context cost 0.015 F1 in-domain but 7.7
   points cross-domain.
11. **Add a sufficiency check with a refusal path only where a wrong answer costs more than a refusal, and
   measure the correctness it loses.** An answerability gate raised abstention-at-detection from 41% to
   99.8% and lowered well-defined correctness from 92% to 87%. Prompted abstention was unreliable for code
   models; letting a coding agent ask the user lifted resolved tasks from 55% to 69%.
12. **Expect the reader to override evidence that contradicts its priors** (about half the time for a small
   model); a conflict-decomposition prompt raised misconception accuracy from 15% to 62% but cost 18
   clean-accuracy points.
13. **For untrusted corpora, test guards against an adaptive attacker.** A three-ring defense cut
   non-adaptive attack success from 79% to 1%, but an adaptive attacker left the pipeline at 62% against 56%
   undefended ([untrusted-content defense](../../agent-safety/references/untrusted-content-defense.md)).

Evidence: kb://agentic-capability-reports/notes/2026-11-14-agentic-multi-step-vs-single-shot-retrieval.md,
kb://agentic-capability-reports/notes/2026-11-14-retrieval-gating-and-bad-evidence-handling.md
