import { afterEach, describe, expect, it } from 'vitest';
import {
  ScheduledWorktreeReclaimRunner,
  resolveReclaimScheduleConfig,
  type ScheduledWorktreeReclaimRunnerDeps,
} from './scheduled-worktree-reclaim-runner.js';
import type { ProjectConfigStore } from '../core/project-config-store.js';
import type { TaskStore } from '../core/tasks.js';
import type { WorkspaceCleanupDeps } from './use-cases/workspace-cleanup-service.js';

describe('resolveReclaimScheduleConfig', () => {
  it('is disabled when the cron env var is unset', () => {
    expect(resolveReclaimScheduleConfig({})).toEqual({ enabled: false, cron: '', dryRun: false });
  });

  it('is disabled when the cron expression is invalid', () => {
    const config = resolveReclaimScheduleConfig({ KOOKR_WORKTREE_RECLAIM_CRON: 'not a cron' });
    expect(config.enabled).toBe(false);
  });

  it('enables a live run for a valid cron', () => {
    const config = resolveReclaimScheduleConfig({ KOOKR_WORKTREE_RECLAIM_CRON: '0 4 * * *' });
    expect(config).toEqual({ enabled: true, cron: '0 4 * * *', dryRun: false });
  });

  it('honors the dry-run flag', () => {
    const config = resolveReclaimScheduleConfig({
      KOOKR_WORKTREE_RECLAIM_CRON: '0 4 * * *',
      KOOKR_WORKTREE_RECLAIM_DRY_RUN: 'true',
    });
    expect(config.dryRun).toBe(true);
  });
});

function makeRunnerDeps(
  overrides: Partial<ScheduledWorktreeReclaimRunnerDeps> & { config: ScheduledWorktreeReclaimRunnerDeps['config'] },
): ScheduledWorktreeReclaimRunnerDeps {
  const auditRows: Array<Record<string, unknown>> = [];
  return {
    cleanupDeps: {} as unknown as WorkspaceCleanupDeps,
    // No projects → the reclaim pass does no git work, so the runner's
    // scheduling behavior is testable without a real repo.
    projectConfigStore: { getAllConfigs: () => [] } as unknown as ProjectConfigStore,
    taskStore: { getAllTasks: () => [] } as unknown as TaskStore,
    resolveRepoPath: async () => { throw new Error('should not be called'); },
    fetchBeforeClassify: false,
    appendAudit: async (_path, row) => { auditRows.push(row); },
    ...overrides,
  };
}

describe('ScheduledWorktreeReclaimRunner', () => {
  const runners: ScheduledWorktreeReclaimRunner[] = [];
  afterEach(async () => {
    for (const runner of runners.splice(0)) await runner.stop();
  });

  it('start() is a no-op and tick() never fires when disabled', async () => {
    const runner = new ScheduledWorktreeReclaimRunner(
      makeRunnerDeps({ config: { enabled: false, cron: '', dryRun: false } }),
    );
    runners.push(runner);
    runner.start();
    expect(runner.getNextRunAt()).toBeNull();
    expect(await runner.tick()).toBeNull();
  });

  it('fires only once the cron time has passed, then reschedules', async () => {
    let currentTime = new Date('2026-07-28T00:00:00.000Z');
    const runner = new ScheduledWorktreeReclaimRunner(
      makeRunnerDeps({
        config: { enabled: true, cron: '*/5 * * * *', dryRun: true },
        now: () => currentTime,
        tickIntervalMs: 60_000,
      }),
    );
    runners.push(runner);

    runner.start();
    const firstDue = runner.getNextRunAt();
    expect(firstDue).not.toBeNull();

    // Before the due time: no fire.
    expect(await runner.tick()).toBeNull();

    // Advance past the due time: exactly one reclaim pass runs (0 projects).
    currentTime = new Date(firstDue!.getTime() + 1_000);
    const result = await runner.tick();
    expect(result).not.toBeNull();
    expect(result?.dryRun).toBe(true);
    expect(result?.consideredCount).toBe(0);

    // Next due time advances strictly beyond the fire time.
    const nextDue = runner.getNextRunAt();
    expect(nextDue).not.toBeNull();
    expect(nextDue!.getTime()).toBeGreaterThan(currentTime.getTime());
  });
});
