# Cost attribution semantics for reaped tasks

Decision status: pending operator sign-off (2026-08-25)

Operator sign-off: not recorded. This is an implementation contract for the
safe interim behavior, not an approval to change billing or production
aggregation.

This record separates two measurements that can describe the same scheduled task:
the cost captured when the schedule ledger is closed and the highest cost
observed while the task is being scanned. It records the current behavior and
the safe interim rule for schedule ROI. It does not approve a billing-policy
change.

## Pending decision

The unresolved policy questions are explicit:

- **Does reaping truncate accrual?** Unresolved. The schedule ledger freezes
  the closeout snapshot when the fire is closed, but Kookr does not infer that
  this snapshot truncates provider billing or later task telemetry.
- **Are child-task costs included?** Unresolved as policy. The current schedule
  ROI implementation excludes descendant usage; parent/descendant aggregation
  remains a separate dashboard measure.

Until an operator signs off, these observed implementation boundaries remain
pinned by the regression fixture below and production aggregation is unchanged.

## Current semantics

### Recorded closeout snapshot

The schedule ledger records `task.tokenUsage.costUsd` at the point where the
schedule service closes the fire. `deriveLedgerEnrichment()` copies that
task-owned usage onto the execution-ledger row. The schedule rollup sums those
joined `tokenUsage` values across measured fires.

This is a closeout snapshot, not a guaranteed final task cost or a high-water
mark. It can be absent when no usage was persisted. The current completion path
records the ledger outcome before asynchronous completion metadata and some
stop-token scans finish, so later task-usage updates do not backfill the closed
ledger row.

### Budget-burn peak

The budget-burn peak is the greatest cumulative `costUsd` observed by the
token-tracking or diagnostics path during the task's lifetime. It is an
observation of spend as it was seen at a point in time; it is not currently a
field in the schedule execution ledger or the per-schedule ROI rollup.

### Reaping and late usage

Reaping ends the task's live observation window, but it does not itself rewrite
the task's persisted `tokenUsage`. A post-closeout update may still land before
the task record is pruned, while the already-closed ledger row remains
unchanged. A later high-water observation and the closeout snapshot can
therefore differ. The current system does not claim that reaping itself is a
billing adjustment or that it truncates provider billing.

### Child-task costs

Per-schedule ROI currently excludes child-task costs. The schedule closeout
join receives one fire task and copies that task's own `tokenUsage`; it does not
call the parent/descendant aggregate. `TaskStore.getAggregateTokenUsage()` is a
separate dashboard aggregation and must not be substituted into the schedule
ledger without an approved attribution rule.

## `757de464` regression shape

The historical scheduled fire for task `757de464-4bdb-4d06-b916-837503e7b562`
was recorded as completed, but the task was subsequently deleted. Its durable
schedule row has no retained cost fields, so the original accounting cannot be
reconstructed safely from that row alone. The focused fixture in
`src/server/cost-attribution-semantics.test.ts` preserves the reported shape:

- recorded closeout snapshot: `$8.05`;
- observed budget-burn peak: `$13.68`;
- child usage remains a separate attribution question rather than being
  silently folded into the final schedule cost.

The fixture deliberately asserts that the schedule rollup remains `$8.05`
while the peak remains `$13.68`, even after a later task-usage update; it does
not assert why the historical peak was higher or claim that the difference was
caused by a child task.

## Interim rule pending sign-off

Until an operator records an approved decision, consumers must:

1. label schedule ROI as **measured recorded closeout snapshot cost**;
2. keep budget-burn peaks in diagnostics and never add them to the rollup;
3. exclude child-task costs from a schedule fire; and
4. leave an unmeasured fire out of `costUsd`, rather than rendering it as zero.

The operator decision still needed is whether a future schedule ROI contract
should report the recorded closeout snapshot, a guaranteed final task cost, a
separately named high-water cost, or more than one of these, and whether
child-task costs should be included in either measure. No operator sign-off for
that choice is recorded in issue #2837 as of this date. Issue #2786 is the
closed predecessor; its implementation did not provide operator sign-off.

## References

- [Per-schedule ROI guidance](../reference/schedule-roi.md)
- [Schedule rollup implementation](../../src/core/schedule-rollup.ts)
- [Schedule closeout enrichment](../../src/server/schedule-service.ts)
- [Issue #2837](https://github.com/kookr-ai/kookr/issues/2837)
- [Closed predecessor #2786](https://github.com/kookr-ai/kookr/issues/2786)
