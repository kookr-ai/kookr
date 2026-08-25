import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { TokenUsage } from '../core/usage-types.js';
import { TaskStore } from '../core/tasks.js';
import { ProgressBudgetBurnDiagnostics } from '../core/progress-budget-burn-diagnostics.js';
import type { LaunchServiceDeps } from './launch-service.js';
import { createScheduleRuntime } from './bootstrap/create-schedule-runtime.js';

const FINAL_TASK_COST_USD = 8.05;
const BUDGET_BURN_PEAK_USD = 13.68;
const CHILD_TASK_COST_USD = 2.41;

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
  test('keeps final closeout, peak observation, and child usage separate', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'kookr-cost-attribution-'));
    try {
      // Synthetic fixture for the reported 757de464 shape. The historical task
      // was deleted, so this test preserves the accounting boundary rather than
      // pretending to recover the original causal path.
      const taskStore = new TaskStore();
      const runtime = await createScheduleRuntime({
        kookrDir: tempDir,
        taskStore,
        launchServiceDeps: {} as LaunchServiceDeps,
        getMaxActiveTasks: () => 5,
        broadcastToAll: () => {},
      });
      const schedule = runtime.scheduleStore.create({
        name: 'Cost attribution fixture',
        cron: '* * * * *',
        playbook: { path: 'fixture.md', parameters: {} },
        cwd: '/tmp',
      });
      const parent = taskStore.createTask({
        prompt: 'reaped parent fixture',
        cwd: '/tmp',
        launchSource: 'schedule',
        scheduleId: schedule.id,
      });
      const child = taskStore.createTask({
        prompt: 'child fixture',
        cwd: '/tmp',
        launchSource: 'schedule',
        parentTaskId: parent.id,
      });
      taskStore.startTask(parent.id);

      const parentFinalUsage = usage(FINAL_TASK_COST_USD);
      const childUsage = usage(CHILD_TASK_COST_USD);
      taskStore.updateTokenUsage(parent.id, parentFinalUsage);
      taskStore.updateTokenUsage(child.id, childUsage);

      const aggregate = taskStore.getAggregateTokenUsage(parent.id);
      expect(aggregate?.costUsd).toBeCloseTo(FINAL_TASK_COST_USD + CHILD_TASK_COST_USD);

      const diagnostics = new ProgressBudgetBurnDiagnostics({ minCostDeltaUsd: 0.01 });
      expect(diagnostics.sample({
        task: taskStore.getTask(parent.id)!,
        agentId: 'fixture-agent',
        usage: parentFinalUsage,
        events: [],
        now: new Date('2026-07-26T06:23:00.000Z'),
      })).toBeNull();
      const peakObservation = diagnostics.sample({
        task: taskStore.getTask(parent.id)!,
        agentId: 'fixture-agent',
        usage: usage(BUDGET_BURN_PEAK_USD),
        events: [],
        now: new Date('2026-07-26T06:30:25.971Z'),
      });
      expect(peakObservation?.totals.costUsd).toBe(BUDGET_BURN_PEAK_USD);

      const receipt = await runtime.scheduleService.reserveExecution(
        schedule,
        'cron',
        '2026-07-26T06:00:41.886Z',
      );
      await runtime.scheduleService.markExecutionAccepted(schedule.id, receipt.id, parent.id, false);
      await runtime.scheduleService.recordTaskTerminalOutcome(parent.id, 'completed');

      const stored = runtime.scheduleStore.get(schedule.id)!;
      expect(stored.executionLedger[0]?.tokenUsage?.costUsd).toBe(FINAL_TASK_COST_USD);
      expect(runtime.scheduleService.getRollup(schedule.id)?.costUsd).toBe(FINAL_TASK_COST_USD);

      // Reaping/deleting the terminal task cannot change the already-joined
      // schedule value or make the diagnostic peak part of the rollup.
      taskStore.deleteTask(parent.id);
      expect(runtime.scheduleService.getRollup(schedule.id)?.costUsd).toBe(FINAL_TASK_COST_USD);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
