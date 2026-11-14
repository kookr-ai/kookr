# Agent memory policy

Use when: deciding what a long-running agent writes to memory, when to consolidate, what to forget, and
whether a managed store beats plain retrieval over the raw log, or when memory cost or staleness hurts.

No paper compares write, consolidate and forget policies head to head on a coding agent; each rule rests on
separate results. For what to record when a task ends see [lesson capture](post-task-lesson-capture.md).

## Rules

1. **Baseline first: append-only raw log plus plain retrieval.** Across memory methods, hold-out accuracy
   often matched or fell below a memory-free run while tokens rose 4.3x to 36x, and self-reported numbers
   diverged from hold-out results (2605.15384). RAG scored 78.31% at $0.65 against mem0 81.08% at $5.43
   (2601.07978). Keep a managed layer only if hold-out accuracy beats the layer-off run by more than its
   token and latency cost.
2. **Exact state goes in a file the agent rewrites, not in retrieval.** Retrieval-only memory scored 0% on
   state-tracking, tree and count tasks; agent-written markdown scored 100% on state-tracking (2602.11243).
3. **Never discard the raw layer.** Extracted facts keep 80.8% of the information, raw dialogue 95.3% (2605.19952).
4. **Consolidate late and at a fixed trigger.** Calling an LLM only when similar items recur cut
   construction tokens 87.3% and beat Mem0, 81.10 vs 62.92 (2605.16045). Summarizing expired history cost
   0.04 F1 for about 78% lower cost (2611.06445). Keep a pointer from each distilled item to its source, and
   keep the source until the distilled rule is live in the running agent.
5. **Overwrite, do not append.** 64% of recommendation errors came from outdated memory never forgotten
   (2604.20006). On implicit conflicts a write-time stale-marking prototype reached 68.0% vs 55.2% where
   existing frameworks gave limited gains (2605.06527, one benchmark). Mark the old fact superseded with a
   reason and date.
6. **Score memories by outcome before deleting, conditioned on task type.** Per-memory success/failure
   counters tracked true utility at rho 0.89 vs 0.00 for static scores, on synthetic data, and -0.33 without
   task conditioning (2604.12007). Importance pruning lost about 30% of high-value content (2604.20300).
7. **Treat memory writes as untrusted.** Provenance checks still allowed 79.8% attack success when the
   attacker was a legitimate uploader (2604.16966). Require reproducible evidence before a tool result or
   web page becomes memory ([untrusted-content defense](../../agent-safety/references/untrusted-content-defense.md)).
8. **Check live state before trusting a stored record of it.** In real runs a stale pause file kept a health
   endpoint wrong for hours; an unbounded ledger outgrew a 512 MB string cap and stopped its own pruner.

Caveats: stacked self-improving memory loops raised variance in 71% of cases (2608.18066); a "99.55%
adversarial robustness" figure measures refusal about undisclosed facts, not poisoning defense (2604.11563).

## Gaps

- No one-backbone comparison of raw, summarized, extracted and gated writes with storage cost.
- No consolidation-frequency sweep; no ungated-vs-gated write ablation.
- No evidence that forgetting improves stability, or of how often agents read their own notes.
