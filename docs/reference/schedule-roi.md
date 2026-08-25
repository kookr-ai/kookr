# Per-schedule ROI guidance

The Schedules dialog reports a materialized rollup over the retained execution
ledger. Its measured spend is a sum of **final task closeout costs** from rows
that carry `tokenUsage`; it is not a budget-burn high-water mark.
The rollup is windowed to the retained ledger rows, so `windowStart` and
`windowEnd` identify the period represented; it is not lifetime spend.

See the [cost-attribution semantics record](../reports/cost-attribution-semantics-reaped-tasks.md)
for the pending operator decision and the `757de464` regression shape. Keeping
the two measurements named separately is required: adding a diagnostic peak to
a final closeout would double-count or inflate spend without a durable
attribution basis.

## What the rollup means

- `costUsd` is the sum of joined `executionLedger[].tokenUsage.costUsd` values.
- `measuredFires` is the denominator for that sum. Fires without usage are
  omitted, not treated as `$0`.
- A reaped task contributes only the task-owned closeout usage that was
  persisted when the fire was closed. A later diagnostic observation cannot
  reconstruct a deleted task.
- Child-task usage is excluded from a schedule fire. Parent/descendant
  aggregates belong to the task dashboard and are not schedule ROI.
- Budget-burn peaks remain diagnostics-only until an operator approves a
  separately named and persisted ROI field.

These boundaries keep the scorecard honest while the operator decision is
pending. They also mean that a schedule rollup is not a billing ledger and
should not be interpreted as one when task data is incomplete.
