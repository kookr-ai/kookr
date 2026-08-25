import { describe, expect, test } from 'vitest';
import type { TokenUsage } from '../core/usage-types.js';
import { computeScheduleRollup } from '../core/schedule-rollup.js';
import { deriveLedgerEnrichment } from './schedule-service.js';

const FINAL_TASK_COST_USD = 8.05;
const BUDGET_BURN_PEAK_USD = 13.68;
const CHILD_TASK_COST_USD = BUDGET_BURN_PEAK_USD - FINAL_TASK_COST_USD;

function usage(costUsd: number): TokenUsage {
  return {
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd,
  };
}

describe('reaped-task cost attribution contract (#2786)', () => {
  test('keeps final closeout, peak observation, and child usage separate', () => {
    // Synthetic fixture for the reported 757de464 shape. The historical task
    // was deleted, so this test preserves the accounting boundary rather than
    // pretending to recover the original causal path.
    const parentFinalUsage = usage(FINAL_TASK_COST_USD);
    const childUsage = usage(CHILD_TASK_COST_USD);
    const observedBudgetBurnCosts = [
      parentFinalUsage.costUsd,
      BUDGET_BURN_PEAK_USD,
    ];

    const enrichment = deriveLedgerEnrichment({ tokenUsage: parentFinalUsage });
    const rollup = computeScheduleRollup({
      id: 'schedule-2786-fixture',
      executionLedger: [{
        id: 'schedule-2786-fixture:cron:2026-07-26T06:00:00.000Z',
        scheduleId: 'schedule-2786-fixture',
        trigger: 'cron',
        decision: 'cron_due',
        evaluatedAt: '2026-07-26T06:00:41.886Z',
        completedAt: '2026-07-26T08:17:19.988Z',
        taskId: '757de464-4bdb-4d06-b916-837503e7b562',
        outcome: 'completed',
        ...(enrichment.tokenUsage ? { tokenUsage: enrichment.tokenUsage } : {}),
      }],
    }, '2026-08-25T00:00:00.000Z');

    expect(Math.max(...observedBudgetBurnCosts)).toBe(BUDGET_BURN_PEAK_USD);
    expect(rollup.costUsd).toBe(FINAL_TASK_COST_USD);
    expect(rollup.measuredFires).toBe(1);
    expect(rollup.costUsd).not.toBe(BUDGET_BURN_PEAK_USD);
    expect(childUsage.costUsd).toBe(CHILD_TASK_COST_USD);
  });
});
