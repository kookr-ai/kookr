# RFC: Cost Comparison Panel Visual and Data Quality Audit

## Status

**Approved for implementation (v4 -- implemented in branch `rfc/cost-comparison-visual-audit`)**

**Date:** 2026-05-11
**Author:** Jean Ibarz (with Codex)
**Predecessors:** [`rfc-cost-comparison-panel.md`](./rfc-cost-comparison-panel.md), [`rfc-cost-comparison-coverage-and-perf.md`](./rfc-cost-comparison-coverage-and-perf.md)

---

## Problem

The live Cost Comparison panel now has enough data to be useful, but the first visual audit on `localhost:4800` found two classes of problems:

1. The panel is dense enough that important state becomes ambiguous: a tiny `Quality` dot means "complete", `--` means several different things, the thumbs-up glyph appears even when there is no feedback, and the `Unbound Codex` card reads visually like a third peer to Claude/Codex even though it is a coverage caveat.
2. The data contract marks three Claude rows as `complete` with zero tokens and `$0.00`. That is not a parser crash, but it is a data-quality anomaly: the current UI says "Complete data -- cost computed from tokens and a verified pricing row" for rows that have no token evidence.

The panel should be a decision-support surface. If the user has to remember tooltip semantics or mentally correct zero-cost "complete" rows, the panel is not trustworthy enough to drive `docs/reports/cost-comparison-decisions.md`.

## Empirical Grounding

Observed on 2026-05-11 against the production instance at `localhost:4800`:

| Evidence | Observation |
|---|---|
| Playwright screenshot, 780x493 viewport | The modal opens, but only the header, notes, and top of the per-playbook table fit. The rest of the decision surface is below the fold. |
| Playwright screenshot, 1440x1100 viewport | The full panel top is readable, but the `Quality` column uses a tiny dot for complete rows, and `Unbound Codex` appears in the same card row as Claude and Codex. |
| Zoomed per-playbook clip | The table is scannable, but `Claude (n)` / `Codex (n)` cells concatenate average cost and sample count as `$11.31x31`; this is compact but easy to misread as multiplication. |
| Zoomed aggregate clip | `Unbound Codex` uses a dashed border, but it still competes with the two true agent aggregate cards. Its `total ($, priced rows)` label wraps in narrow cards. |
| API snapshot | 147 tasks in 7d: 139 `complete`, 3 `codex-rollout-not-found`, 4 `codex-rollout-abandoned`, 1 `codex-no-tokens`. |
| API snapshot | 46 unbound Codex threads, about $726 priced rows, 28.8M input tokens, 2.5M output tokens, 1014M cached input tokens. |
| API snapshot | 31 abandoned Codex rollouts excluded. |
| API anomaly | 3 Claude rows have `dataQuality: "complete"`, `estimatedCostUsd: 0`, and all token fields equal 0. |
| API drift check | Consecutive reads a few seconds apart changed Codex and unbound totals because live/running Codex work was still accruing tokens. |

Local-only artifacts from the audit were captured under the repo root:

- `cost-comparison-panel-viewport.png`
- `cost-panel-artifacts/desktop-panel-top.png`
- `cost-panel-artifacts/per-playbook-zoom2.png`
- `cost-panel-artifacts/aggregate-zoom2.png`
- `cost-panel-artifacts/api-summary.json`

## Requirements

- **R1.** The panel SHALL distinguish "complete with cost", "complete but zero billed tokens", "running/incomplete", and "missing usage" as separate states. A row with no token evidence MUST NOT render as ordinary `complete`.
- **R2.** Missing or unavailable values SHALL show a reason inline when the table is scanned, not only in a tooltip.
- **R3.** The top of the panel SHALL summarize data coverage: priced task count, excluded task count, unbound Codex count, abandoned rollout count, and whether the snapshot includes live-running rows.
- **R4.** The per-playbook table SHALL separate cost and sample count visually. Example: `$11.31 avg` and `n=31`, not `$11.31x31`.
- **R5.** `Unbound Codex` SHALL be visually separated from the Claude/Codex aggregate cards. It is coverage evidence, not a third comparable agent.
- **R6.** The panel SHALL stay usable at 780x493 and 1440x1100 without important controls or the first decision table becoming hidden behind the browser edge.
- **R7.** The per-task table SHALL make `dataQuality` legible without depending on a tiny dot, glyph, or hover tooltip.
- **R8.** The API SHALL make live-data drift explicit when running tasks are included in the response.

## Design

### Change 1 -- Add Coverage Summary Band

Add a compact summary band between `data as of` and notes:

```
147 tasks | 139 priced | 8 excluded | 46 unbound Codex | 31 abandoned | live rows included
```

This band is not a warning stack. It is the "how representative is this panel?" answer the user needs before reading ratios.

Server contract:

```typescript
interface CostComparisonCoverage {
  taskCount: number;
  pricedTaskCount: number;
  excludedTaskCount: number;
  unboundCodexThreadCount: number;
  abandonedCodexRolloutCount: number;
  runningTaskCount: number;
  liveData: boolean;
}
```

The field can be added compatibly as `coverage?: CostComparisonCoverage`; old clients ignore it.

### Change 2 -- Introduce `missing-usage` Data Quality

Extend `CostDataQuality` with:

```typescript
| 'missing-usage'
```

Use it for Claude rows where `claudeUsage.get(task.id)` and `task.tokenUsage` are both absent. Today `computeClaudeRow` renders those as:

```typescript
estimatedCostUsd: 0,
dataQuality: 'complete',
```

That makes the row look like a verified zero-cost task. The new row should render:

```typescript
estimatedCostUsd: null,
dataQuality: 'missing-usage',
```

and should not contribute tokens or cost to aggregate totals. It may still contribute to task count and feedback count, because "we had a task" is true even when usage evidence is absent.

Tooltip / label:

> Usage not available for this task; no transcript or persisted token snapshot was found.

### Change 3 -- Split Cost and Count Presentation

Replace `formatAgentCell` with a small two-part cell:

```
$11.31 avg
n=31
```

On narrow widths, stack the two lines. On desktop, keep them in the same cell with a subdued `n=31` chip. This removes the misleading multiplication-shaped `$11.31x31` string.

The average denominator is `AggregateMetrics.pricedTaskCount`, not all task rows. Rows marked `missing-usage`, `unknown-pricing`, `codex-no-tokens`, `codex-rollout-not-found`, or `codex-rollout-abandoned` remain visible in task counts and quality coverage, but they must not dilute average cost as implicit zero-cost rows.

### Change 4 -- Move Unbound Codex Into Coverage Section

Keep the existing `unboundCodex` API field, but render it below the coverage summary as a caveat panel, not in `.cost-aggregate-grid`.

Layout:

```
Coverage caveats
Unbound Codex: 46 threads, $726.28 priced, 28.8M input, 2.5M output, 1014.1M cached input
```

The aggregate row then contains only true peer cards:

- Claude
- Codex

This preserves the useful unbound spend signal from `rfc-cost-comparison-coverage-and-perf.md` while reducing the chance that users compare "Claude vs Codex vs Unbound Codex" as if those were three agents.

### Change 5 -- Replace Glyph-Only Quality With Badges

Replace:

- `complete` -> `.` / `●`
- `codex-rollout-not-found` -> `no-roll`
- `codex-rollout-abandoned` -> `aband`
- `codex-no-tokens` -> `no-tok`

with short badges:

- `priced`
- `missing rollout`
- `abandoned`
- `no tokens`
- `missing usage`
- `parse error`
- `unknown price`

Badges should use text plus color, not color alone. The table can keep the full tooltip, but the visible label must carry the state.

### Change 6 -- Constrain Modal Height and Scroll Internally

Change modal sizing:

```css
.cost-comparison-panel {
  max-height: calc(100vh - 64px);
  overflow: auto;
}
```

Keep the header sticky inside the panel and let the coverage summary stay visible where it fits:

```css
.cost-comparison-header {
  position: sticky;
  top: -18px;
  z-index: 1;
  background: var(--bg, #0c0c10);
}
```

Tables should be wrapped in horizontal scroll containers so narrow widths do not force text wrapping into unreadable rows.

### Change 7 -- Mark Live Rows

Add `status` or `isTerminal` to `PerTaskRow`, or derive it server-side into a visible state:

```typescript
interface PerTaskRow {
  ...
  status: TaskStatus;
  isTerminal: boolean;
}
```

When `isTerminal === false`, render duration as `running` instead of `--`, and include running rows in `coverage.runningTaskCount`. The API should set `coverage.liveData = runningTaskCount > 0`.

This explains why totals can drift between refreshes and why a row can have current spend but no terminal duration.

## Files To Change

- `src/shared/contracts/cost-comparison.ts`
- `src/core/cost-comparison-aggregator.ts`
- `src/core/cost-comparison-aggregator.test.ts`
- `src/frontend/components/CostComparisonPanel.tsx`
- `src/frontend/components/CostComparisonPanel.test.ts`
- `src/frontend/styles.css`

## Edge Cases

- A Claude task with no usage and no transcript should be `missing-usage`, not `complete`.
- A task with actual zero billed usage can still exist, but it needs token evidence. If all token fields are zero and no usage source path exists, treat it as missing usage.
- Running tasks can have spend and no terminal duration. They should remain visible, but aggregate ratios should indicate that live rows are included.
- `unboundCodex` can be present on All/Codex filters and absent on Claude-only filters. The coverage summary should not show stale zeros as if the metric was computed but empty.
- Narrow modal screenshots must be tested with a height-constrained viewport, not only a wide desktop viewport.

## Alternatives Considered

### Keep Tooltips As The Explanation Layer

Rejected. Tooltips are good for detail, but the audit failure is first-glance ambiguity. The visible table must carry the meaning.

### Hide Unbound Codex By Default

Rejected. Hiding unbound spend would reintroduce the coverage problem solved by the previous RFC. The fix is visual hierarchy, not removal.

### Drop Live Rows From The Panel

Rejected. Live rows are useful, especially for current spend. The UI just needs to disclose that the snapshot is mutable.

### Leave Claude No-Usage Rows As `$0.00`

Rejected. It makes aggregate cost look artificially lower and violates the panel's own data-quality language.

## Critic Feedback Incorporated

- **Round 1 -- boundary/data contract pass:** Split the design into a wire-contract change (`coverage`, `missing-usage`, `status`) and a presentation change (badges, modal layout). This keeps visual fixes from smuggling in ambiguous data semantics.
- **Round 1 -- visual pass:** Rejected a purely cosmetic card polish. The real rendering issue is not color or spacing; it is that too much semantics are encoded as glyphs, tooltip-only text, and ambiguous dashes.
- **Empirical checkpoint:** Queried `/api/cost-comparison?window=7d&agent=all` and found 3 zero-token Claude rows marked `complete`. This falsified the "no data issue" assumption.
- **Round 2 -- minimalist pass:** Removed a proposed diagnostics endpoint. The current response already contains enough data; the RFC only needs a coverage summary derived from existing fields plus status.
- **Round 2 -- failure-mode pass:** Added live-data disclosure because consecutive API reads changed Codex totals during the audit.
- **Round 3 -- implementation pass:** Kept `unboundCodex` in the API but moved its rendering out of the peer aggregate grid, avoiding a needless server migration.

## Acceptance Criteria

- Playwright screenshot at 780x493 shows the header, coverage summary, notes, and at least the first per-playbook rows inside a bounded modal with internal scrolling.
- Playwright screenshot at 1440x1100 shows Claude/Codex aggregate cards as peers and `Unbound Codex` as a coverage caveat.
- Per-task table has visible text badges for every `dataQuality` state.
- A fixture with a Claude task that has no `claudeUsage` and no `task.tokenUsage` renders `missing-usage`, `estimatedCostUsd: null`, and does not add cost/tokens to aggregates.
- A fixture with a running task shows `running` duration and sets `coverage.liveData = true`.
- Existing cost-comparison aggregator tests continue to pass after updating expected data-quality counts.
