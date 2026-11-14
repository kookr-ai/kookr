# Retrieval index design

Use when: building or changing the index side of a retrieval tool: choosing a reranker, how many candidates
to rerank, chunk size and boundaries, whether to add hybrid (BM25 plus dense) search or a graph index.

Most numbers come from one or two small-model papers: defaults to test, not laws. When to search at all,
how many rounds, k, stopping and bad-evidence guards: [agentic retrieval](agentic-retrieval.md).

## Rules

1. **Pick the reranker by latency budget, and rerank about 50 candidates.** A cross-encoder added +11.8%
   latency and +1.2% tokens (2412.15529; [agentic retrieval](agentic-retrieval.md) rule 1 cites another
   paper finding its latency negligible). LLM or API rerankers took a median 3.13 s and 4.58 s against
   55.6 ms for dense search, at $0.00155 to $0.00283 per query (2611.08014); a loop that searches several
   times per task pays that on every search. Depth 50 to 100 lifted known-positive recall only from 0.8737
   to 0.8970, with all four paired-bootstrap intervals including zero (2611.08014).
2. **"Strong reranker" is not a fixed thing; measure yours.** An off-the-shelf BGE reranker had 56.31%
   Hit@1 until distilled to 75.68% (2607.18039).
3. **Avoid very small chunks, then stop tuning chunking.** 80-token chunks lost 4.6% of answers before
   retrieval began, against 0.6% at 140 (2606.28337). Semantic and topic-shift chunking did not beat fixed
   or rule-based windows (2607.04008; 2607.01852, 13 documents, weak), and the best chunker flipped after
   fine-tuning (2607.22067).
4. **Fix boundary loss at query time, not with smarter chunking.** Neighbour expansion kept 92.8% recall
   with 7.84 chunks against 96.7% with 10.16 and cut context tokens 27.1% (2606.16661).
5. **Test hybrid search on your corpus; do not assume it wins.** It lost to semantic-only on one corpus
   (91.2% vs 93.0%, 2607.18772) and won big on another (Recall@10 0.7024 vs 0.1667 for BM25, 2606.13837).
6. **Build a graph index only when the reranked baseline fails on a named question type, and price it
   first.** MS-GraphRAG used 17,638 build LLM calls against 131 to 2,214 for a schema-constrained graph that
   matched LightRAG (0.679 vs 0.673, p = .27) and beat naive RAG by 6.0 points (2607.22592). Extraction cost
   about $0.001 per document with a local 7B extractor against about $0.10 with an API (2607.11683). With a
   strong reranker, RAPTOR and graph expansion moved F1 by under 0.5 ([agentic retrieval](agentic-retrieval.md)
   rule 5).

## Gaps

- No reranker versus graph index comparison at equal cost; no graph freshness study under edits and deletions.
- No chunk-size sweep beyond 80 versus 140 tokens; no code-chunking head-to-head.
