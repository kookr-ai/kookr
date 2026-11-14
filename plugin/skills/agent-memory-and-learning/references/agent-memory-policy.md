---
name: agent-memory-policy
group: design-analysis
description: >
  Decide what a long-running agent should write to memory, when to consolidate it, what to forget, and
  whether a managed memory store beats plain retrieval over the raw log. Covers the plain-RAG baseline and
  its measured cost, keeping raw text under any distilled layer, late consolidation, superseding stale
  facts at write time, outcome-scored forgetting, and treating memory writes as untrusted input. Use before
  adding a memory store, lessons file or notebook to an agent, when memory cost or staleness is a problem,
  or when reviewing a proposed memory design.
keywords: memory, consolidation, forgetting, rag, lessons, notebook, staleness, poisoning, token cost, coding agent
related: agent-fleet-orchestration, token-efficiency
---

# Agent memory policy

No paper in the local KBs compares write, consolidate and forget policies head to head on a coding agent.
These rules come from separate results, so each carries its own evidence and caveat. Source report:
`agentic-capability-reports` note `2026-11-14-agent-memory-write-consolidate-forget-policy`.

## Rules

1. **Baseline first: append-only raw log plus plain retrieval.** In one controlled comparison RAG scored
   78.31% at $0.65, mem0 81.08% at $5.43, full context 77.16% at $10.22, graph memory 55-56% (2601.07978).
   Across memory methods, hold-out accuracy often matched or fell below a memory-free run while token use
   rose 4.3x to 36x (2605.15384). Run the same questions with the managed layer off; keep it only if
   hold-out accuracy beats the baseline by more than its token and latency cost.
2. **Exact state goes in a file the agent rewrites, not in retrieval.** Retrieval-only memory scored 0% on
   state-tracking, tree and count tasks; agent-written markdown scored 100% on state-tracking (2602.11243).
   A file-based coding agent beat the best RAG baseline, 72.5% vs 48.5%, at about 108 s vs 26 s per query
   (2605.12493); the gain may come from the capable agent, not the format.
3. **Never discard the raw layer.** Extracted facts keep 80.8% of the information, raw dialogue 95.3%
   (2605.19952). Removing a raw buffer cut accuracy from 81.10 to 51.88 (2605.16045).
4. **Consolidate late and at a fixed trigger.** Calling an LLM only when similar items recur cut
   construction tokens 87.3% and beat Mem0, 81.10 vs 62.92 (2605.16045). Summarizing expired history cost
   0.04 F1 (0.48 vs 0.52) or 0.04 resolve rate for about 78% lower cost (2611.06445). Keep a pointer from
   each distilled item to its source.
5. **Overwrite, do not append.** 64% of recommendation errors came from outdated memory never forgotten
   (2604.20006). Systems skew toward inserts (up to 87.6% of writes) and averaged 27.9% on interference
   tasks (2605.18565). On implicit conflicts, existing frameworks gave limited gains; a write-time
   stale-marking prototype reached 68.0% vs 55.2% (2605.06527, one benchmark). Mark the old fact
   superseded with a reason and date.
6. **Score memories by outcome before deleting.** Per-memory success/failure counters tracked true utility
   at rho 0.89 vs 0.00 for static scores, on synthetic data, and -0.33 without task conditioning
   (2604.12007). Pruning has a cost: removing 56.6% of vectors lost 2.4 points (2611.09355), and
   importance pruning lost about 30% of high-value content (2604.20300).
7. **Treat memory writes as untrusted.** Sleeper-memory injection reached 99.8% (2605.15338); provenance
   checks still allowed 79.8% attack success when the attacker was a legitimate uploader (2604.16966);
   reranking plus hybrid retrieval plus passage isolation left 25.6% at 6x latency (2605.28074). Require
   reproducible evidence before a tool result or web page becomes memory.

## Anti-patterns

- Adopting a memory framework because its own benchmark says so; self-reported numbers diverged from
  hold-out results (2605.15384).
- Trusting a stored record over the live state it describes. Real runs: a stale pause file kept a health
  endpoint wrong for hours; an unbounded ledger outgrew a 512 MB string cap and stopped its own pruner.
- Deleting the source memory before the distilled rule is live in the running agent.
- Stacking self-improving memory loops: variance rose in 71% of cases (2608.18066), and general
  experience memories underperformed no memory on FinEvolveBench (2606.06960).
- Citing a "99.55% adversarial robustness" figure as a poisoning defense; it measures refusal to answer
  about undisclosed facts (2604.11563).

## Gaps

No one-backbone comparison of raw, summarized, extracted and gated writes with storage cost; no
consolidation-frequency sweep; no evidence that forgetting improves stability; no measurement of how often
agents read their own notes; no ungated-vs-gated write ablation.
