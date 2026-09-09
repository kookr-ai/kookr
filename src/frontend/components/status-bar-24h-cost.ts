/**
 * Status-bar copy for the rolling-24h agent-spend chip (issue #3096).
 *
 * The dollar figure is sourced from the outcome ledger's 24h window
 * (`getOutcomeLedger('24h').summary.totalKnownCostUsd`); this file only formats
 * the label/tooltip and decides whether the chip is visible. Sibling of the
 * completed-task (#2618) and launched-task (#2632) 24h count chips.
 */

import type { OutcomeLedgerReadiness } from '../../shared/contracts/outcome-ledger.js';

/** Hours in the rolling window the outcome ledger's `24h` scope aggregates. */
const COST_WINDOW_HOURS = 24;

/**
 * Smallest spend the chip will show. The label rounds to cents, so anything
 * below half a cent would render as a misleading `$0.00`; hiding it keeps the
 * "non-trivial cost" contract and the guard consistent with the formatter.
 */
const MIN_DISPLAY_COST_USD = 0.005;

/**
 * Minimum fraction of window tasks that must report a cost before the summed
 * total is trustworthy as an at-a-glance spend figure. Matches the ledger's
 * own low-coverage bar (`src/core/outcome-ledger.ts`), but is applied here
 * regardless of task count: the ledger only marks a window `blocked` for low
 * coverage at ≥3 tasks, so a 1–2 task window where a task never reported cost
 * would otherwise render a confident, understated total.
 */
const MIN_COST_COVERAGE = 0.8;

/**
 * Show the chip only when a non-trivial 24h spend is genuinely known.
 *
 * Hidden when:
 * - cost is zero/negative/non-finite, or sub-cent (would round to `$0.00`),
 *   mirroring the count chips' hide-at-zero guard;
 * - the ledger reports `blocked` readiness (`taskCount === 0` or a critical
 *   data-quality finding); or
 * - cost coverage is unknown or below {@link MIN_COST_COVERAGE} — too many
 *   tasks in the window never reported a cost for the summed total to be a
 *   fair figure, the low-sample/low-coverage case the chip must not misrepresent
 *   even when the window has fewer than the ledger's 3-task `blocked` threshold.
 *
 * A `caution` window is still shown: caution driven by an outlier cost or a
 * verification-coverage gap does not make the *total spend* misleading once
 * cost coverage itself is known to be high.
 */
export function shouldShow24hCostChip(
  costUsd: number,
  readiness: OutcomeLedgerReadiness,
  costCoverage: number | null,
): boolean {
  return (
    Number.isFinite(costUsd)
    && costUsd >= MIN_DISPLAY_COST_USD
    && readiness !== 'blocked'
    && costCoverage !== null
    && costCoverage >= MIN_COST_COVERAGE
  );
}

/** Chip label: "$12.34 (24h)". Callers hide the chip when the guard is false. */
export function format24hCostChipLabel(costUsd: number): string {
  return `$${costUsd.toFixed(2)} (${COST_WINDOW_HOURS}h)`;
}

/**
 * Tooltip: names this as rolling-24h agent spend and the known-cost caveat.
 * The figure sums only tasks with a known cost, so it is a lower bound when
 * some tasks in the window never reported a cost.
 */
export function format24hCostChipTitle(costUsd: number): string {
  return `Agents cost $${costUsd.toFixed(2)} in the last ${COST_WINDOW_HOURS} hours (rolling). Sums tasks with a known cost — a lower bound when some tasks did not report cost.`;
}
