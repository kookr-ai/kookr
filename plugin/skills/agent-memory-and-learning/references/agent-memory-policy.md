# Agent memory policy

Use when: deciding what a long-running agent writes to memory, when to consolidate, what to forget, and
whether a managed store beats plain retrieval over the raw log; who (model or harness) triggers memory reads
and writes; sharing memory across a fleet; or when memory cost or staleness hurts.

No paper reviewed compares write, consolidate and forget policies head to head on a coding agent; each rule rests on
separate results. For what to record when a task ends see [lesson capture](post-task-lesson-capture.md); for
one person's preferences see [preference memory](preference-memory.md).

Contents: Rules (1-8) · Who controls reads and writes (9-13) · Shared memory across a fleet (14-19) · Gaps.

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

## Who controls reads and writes

No paper compares a frozen model that edits its own memory through tool calls with a fixed pipeline on one
benchmark at matched cost; the rules below come from separate results.

9. **The harness owns the write trigger.** Fire writes from a completion gate or a fixed context threshold;
   let the model nominate a candidate and a mechanical check decide (quote present in source, schema valid,
   not from untrusted content). In the author's runs a lesson store stayed empty while authoring was policy
   text only, until a completion gate fixed it ([lesson capture](post-task-lesson-capture.md) rules 8, 12).
10. **Gate reads with a cheap signal, not an LLM judge, and recalibrate it.** On HotpotQA no retrieval
   scored 15.4% and always-retrieve 43.4%, with 4.0% of questions harmed; token-confidence and entropy
   triggers matched a learned router (32.7% vs 32.7% at a 50% budget; random 27.9%, oracle 45.9%), but
   nominal 50% thresholds missed the budget in up to 65.7% of splits, so recalibrate on held-out data
   (2607.24010). Skip rates, k and stopping: [agentic retrieval](agentic-retrieval.md) rules 3-4.
11. **Put an LLM only on the mutation path.** A narrow JSON-contract hook on update and delete lifted an
   adversarial suite from about 63-68% to about 92-94%, at about $0.17 per run and 2.3 s per case; an LLM
   at inscribe time scored 0% deletion precision on prefix-collision cases (2606.15903).
12. **Use agent-driven search of the raw store for rare, high-value recall, not every turn.** It scored
   72.5% against 57.0% for structured RAG at about 108 s against 26 s per query; the gain mixes agent
   control with file storage (2605.12493).
13. **Train a memory manager only on open weights, and compare it with the untrained hook of rule 11
   first.** Memory-R2 reached F1 50.60 against 43.14, but direct 32-session training collapsed validation F1
   from 0.47 to 0.27 without a curriculum (2605.21768); UMA needed 32 H200 GPUs for about 2 days
   (2602.18493); a mixed curriculum's aggregate gain was +0.012 F1 (2605.23067).

## Shared memory across a fleet

No paper compares shared with private memory on one team at matched cost; every gain below is against no
memory or independent runs.

14. **Keep scratch private; share only distilled rules with the condition they apply under, never raw
   trajectories** (evidence: [lesson capture](post-task-lesson-capture.md) rule 3). Naive cross-model
   transfer "often degrades performance" (2603.23234, whose shared bank raised MATH500 from 52.2% to 67.0%).
15. **Gate writes before summarizing or consolidating; a content classifier alone is not the gate.**
   Write-gating cut cross-agent spread from 0.097 to 0.0004-0.0006, post-hoc cleaning left 0.086-0.103, and
   clean-looking summaries (mean toxicity 0.0852) still carried harm (2605.16746). A shared self-evolving
   skill store reached 91.0% attack presence at 10% attacker support (2608.05563).
16. **Tag every entry** with writer, model, task, date, the commit or state it was true at, and what it
   supersedes. Signatures caught tampering in 100% of 1,000 trials (2605.11032) but not a wrong entry
   signed by a trusted agent.
17. **Re-verify state-bound entries at read time** (rule 8): agents rarely check an inherited entry's
   provenance ([lesson capture](post-task-lesson-capture.md) rule 13).
18. **Cap, vote, prune.** Benign accumulation alone raised violation rates to 0.10-0.35 at 20k exposure
   with 0% self-detection (2605.17830); ungoverned accumulation: [lesson
   capture](post-task-lesson-capture.md) rule 5.
19. **Let the lead or a verifier commit worker proposals (single writer), and keep an independent verifier
   away from the writer's shared notes** (an inference, not measured). In the author's runs (single
   incidents) parallel agents sharing one worktree or one editable venv wiped or imported each other's
   edits: give each writer its own.

## Gaps

- No one-backbone comparison of raw, summarized, extracted and gated writes with storage cost.
- No consolidation-frequency sweep; no ungated-vs-gated write ablation.
- No evidence that forgetting improves stability, or of how often agents read their own notes.
- No prompted self-editing memory (MemGPT or Letta style) versus fixed pipeline head-to-head; no token count
  per memory tool-call loop; no measured rate of unprompted memory writes by a coding agent; no
  reward-hacking measurement for learned managers. Selective-retrieval results are mostly QA; the one
  coding-agent gate (2604.27283) is smoke scale.
- No private-versus-shared or scope-partition ablation; no concurrent-writer conflict or duplicate rates; no
  naive cross-model transfer baseline.
