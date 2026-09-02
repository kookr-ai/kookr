# Per-schedule ROI guidance

The Schedules dialog reports a materialized rollup over the retained execution
ledger. Its measured spend is a sum of **recorded closeout snapshot costs** from
rows that carry `tokenUsage`; it is not a task's guaranteed final cost or a
budget-burn high-water mark.
The rollup is windowed to the retained ledger rows, so `windowStart` and
`windowEnd` identify the period represented; it is not lifetime spend.

See the [cost-attribution semantics record](../reports/cost-attribution-semantics-reaped-tasks.md)
for the pending operator decision and the `757de464` regression shape. The
record is not an operator-approved billing policy: it pins current behavior
while reaping-truncation and child-cost inclusion remain unresolved. Keeping
the two measurements named separately is required: adding a diagnostic peak to
a closeout snapshot would double-count or inflate spend without a durable
attribution basis.

## What the rollup means

- `costUsd` is the sum of joined `executionLedger[].tokenUsage.costUsd` values.
- `measuredFires` is the denominator for that sum. Fires without usage are
  omitted, not treated as `$0`.
- A reaped task contributes only the task-owned usage captured when the fire's
  ledger row was closed. Later task-usage updates, including asynchronous
  completion metadata or stop-token scans, cannot revise that row; a later
  diagnostic observation cannot reconstruct a deleted task.
- Child-task usage is excluded from a schedule fire. Parent/descendant
  aggregates belong to the task dashboard and are not schedule ROI.
- Budget-burn peaks remain diagnostics-only until an operator approves a
  separately named and persisted ROI field.
- An archived schedule (issue #2981) has no rollup at all. Archiving drops it,
  and every later write to the retired row — including the close-out of a run
  that was still in flight when it was archived — keeps it dropped, so a
  retired loop contributes nothing to fleet attribution. Un-archiving rebuilds
  the rollup from the retained ledger, so those post-archive fires reappear in
  the counts. This is why a schedule's ROI can vanish and later return with
  more fires than it had when it disappeared.

These boundaries keep the scorecard honest while the operator decision is
pending. They also mean that a schedule rollup is not a billing ledger and
should not be interpreted as one when task data is incomplete.
