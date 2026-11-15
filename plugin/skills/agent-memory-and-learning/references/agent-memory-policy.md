# Agent memory policy

Use when: deciding what a long-running agent writes to memory, when to consolidate, what to forget, who
triggers memory reads and writes, how a fleet shares memory, or when memory cost or staleness hurts.

For what to record when a task ends see [lesson capture](post-task-lesson-capture.md); for one person's
preferences see [preference memory](preference-memory.md).

## Write, consolidate, forget

1. **Baseline first: append-only raw log plus plain retrieval.** Managed memory often matched or fell below a
   memory-free run while tokens rose 4x to 36x, and self-reported numbers diverged from hold-out results.
   Keep a managed layer only if hold-out accuracy beats the layer-off run by more than its token and latency
   cost.
2. **Keep exact state in a file the agent rewrites, not in retrieval.** Retrieval-only memory scored 0% on
   state-tracking and counting tasks; agent-written markdown scored 100% on
   state-tracking.
3. **Never discard the raw layer.** Extracted facts keep about 81% of the information, raw dialogue about 95%.
4. **Consolidate late, at a fixed trigger** (for example when similar items recur). This cut construction
   tokens about 87% and beat per-turn extraction. Keep a pointer from each distilled item to its source, and
   keep the source until the distilled rule is live in the running agent.
5. **Overwrite, do not append.** Outdated memory never forgotten caused most recommendation errors in one
   study. Mark the old fact superseded, with a reason and date.
6. **Score memories by outcome before deleting, conditioned on task type.** Per-memory success/failure
   counters tracked true utility; static importance scores did not and pruned about 30% of high-value content.
7. **Treat memory writes as untrusted.** Provenance checks still let through about 80% of attacks from a
   legitimate uploader. Require reproducible evidence before a tool result or web page becomes memory
   ([untrusted-content defense](../../agent-safety/references/untrusted-content-defense.md)).
8. **Check live state before trusting a stored record of it.** In real runs a stale pause file kept a health
   endpoint wrong for hours; an unbounded ledger outgrew a string cap and stopped its own pruner.

## Who controls reads and writes

9. **The harness owns the write trigger.** Fire writes from a completion gate or a fixed context threshold;
   let the model nominate a candidate and a mechanical check decide (quote present in source, schema valid,
   not from untrusted content). A lesson store stayed empty while authoring was policy text only, until a
   completion gate fixed it.
10. **Gate reads with a cheap signal (token confidence, entropy), not an LLM judge, and recalibrate on
   held-out data.** Always-retrieve harmed about 4% of questions; nominal thresholds often missed the budget.
   Skip rates, k and stopping: see [agentic retrieval](agentic-retrieval.md) on skipping and stopping.
11. **Put an LLM only on the mutation path** (update and delete), behind a narrow JSON contract. This lifted
   an adversarial suite from about 65% to about 93%; an LLM at insert time deleted the wrong items.
12. **Use agent-driven search of the raw store for rare, high-value recall, not every turn.** It beat
   structured RAG (72.5% vs 57.0%) at about 4x the latency.
13. **Train a memory manager only on open weights, and beat the untrained hook (rule 11) first.** Gains were
   modest, and direct long-session training collapsed without a curriculum.

## Shared memory across a fleet

14. **Keep scratch private; share only distilled rules with the condition they apply under, never raw
   trajectories** (see [lesson capture](post-task-lesson-capture.md), store a short abstract rule). Naive
   cross-model transfer often degrades performance.
15. **Gate writes before summarizing or consolidating; a content classifier alone is not the gate.**
   Write-gating cut cross-agent spread by over 99%; post-hoc cleaning barely helped, and clean-looking
   summaries still carried harm.
16. **Tag every entry** with writer, model, task, date, the commit or state it was true at, and what it
   supersedes. Signatures catch tampering but not a wrong entry signed by a trusted agent.
17. **Re-verify state-bound entries at read time** (rule 8): agents rarely check an inherited entry's
   provenance.
18. **Cap, vote, prune.** Benign accumulation alone raised violation rates with no self-detection.
19. **Let the lead or a verifier commit worker proposals (single writer), and keep an independent verifier
   away from the writer's shared notes.** Parallel agents sharing one worktree or editable venv wiped or
   imported each other's edits: give each writer its own.

Evidence: kb://agentic-capability-reports/notes/2026-11-14-agent-memory-write-consolidate-forget-policy.md,
kb://agentic-capability-reports/notes/2026-11-14-agent-controlled-vs-fixed-memory-read-write-policy.md,
kb://agentic-capability-reports/notes/2026-11-14-shared-vs-private-memory-for-agent-fleets.md
