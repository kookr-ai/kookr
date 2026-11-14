# Retrieval index design

Use when: building or changing the index side of a retrieval tool: choosing a reranker, how many candidates
to rerank, chunk size and boundaries, whether to add hybrid (BM25 plus dense) search or a graph index.

Defaults to test, not laws. When to search, rounds, k, stopping and bad-evidence guards:
[agentic retrieval](agentic-retrieval.md).

1. **Pick the reranker by latency budget, and rerank about 50 candidates.** A cross-encoder added about 12%
   latency (another study found it negligible). LLM or API rerankers took 3-5 s against 56 ms for dense
   search, and a loop that searches several times pays that on every search. Depth 50 to 100 lifted recall
   only from 0.87 to 0.90, within noise.
2. **"Strong reranker" is not a fixed thing; measure yours.** An off-the-shelf reranker had 56% Hit@1 until
   distilled to 76%.
3. **Avoid very small chunks, then stop tuning chunking.** 80-token chunks lost 4.6% of answers before
   retrieval began, against 0.6% at 140. Semantic and topic-shift chunking did not beat fixed or rule-based
   windows, and the best chunker flipped after fine-tuning.
4. **Fix boundary loss at query time, not with smarter chunking.** Neighbour expansion kept 93% recall with
   7.8 chunks against 97% with 10.2, and cut context tokens 27%.
5. **Test hybrid search on your corpus; do not assume it wins.** It lost to semantic-only on one corpus (91%
   vs 93%) and won big on another (Recall@10 0.70 vs 0.17 for BM25).
6. **Build a graph index only when the reranked baseline fails on a named question type, and price it
   first.** A heavy GraphRAG build used about 17,600 LLM calls against 131 to 2,200 for a schema-constrained
   graph that matched LightRAG and beat naive RAG by about 6 points. Extraction cost about $0.001 per
   document with a local 7B extractor against about
   $0.10 with an API. With a strong reranker, graph expansion moved F1 by under 0.5.

Evidence: kb://agentic-capability-reports/notes/2026-11-14-retrieval-tool-design-chunking-hybrid-graph-reranker.md
