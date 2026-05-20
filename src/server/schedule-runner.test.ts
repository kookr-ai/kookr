import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ScheduleStore } from '../core/schedule.js';
import {
  ScheduleRunner,
  type ScheduleRunnerDeps,
  isTaskBlockingSchedule,
  SCHEDULE_GATE_MAX_TASK_AGE_MS,
} from './schedule-runner.js';
import { ScheduleService } from './schedule-service.js';
import { ScheduleValidator } from './schedule-validator.js';

describe('ScheduleRunner', () => {
  let dir: string;
  let store: ScheduleStore;
  let service: ScheduleService;
  let validator: ScheduleValidator;
  let launched: Array<{ prompt: string; cwd: string }>;
  let taskIdCounter: number;
  let activeTaskIds: Set<string>;
  let activeCount: number;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'runner-test-'));
    store = new ScheduleStore(dir);
    validator = new ScheduleValidator();
    service = new ScheduleService({ store, validator });
    launched = [];
    taskIdCounter = 0;
    activeTaskIds = new Set();
    activeCount = 0;

    await mkdir(join(dir, '.kookr', 'playbooks'), { recursive: true });
    await writeFile(join(dir, '.kookr', 'playbooks', 'test.md'), `---
name: Test Playbook
description: A test playbook
parameters: []
checklist:
  - Step 1
---

Do the test thing.
`);
  });

  afterEach(async () => {
    delete process.env.KOOKR_NO_CATCHUP;
    await rm(dir, { recursive: true, force: true });
  });

  function createRunner(overrides: Partial<ScheduleRunnerDeps> = {}) {
    return new ScheduleRunner({
      store,
      service,
      validator,
      launcher: async (opts) => {
        const taskId = `task-${++taskIdCounter}`;
        launched.push({ prompt: opts.prompt, cwd: opts.cwd });
        activeTaskIds.add(taskId);
        activeCount += 1;
        return { task: { id: taskId } as any, queued: false };
      },
      getActiveCount: () => activeCount,
      getMaxActiveTasks: () => 10,
      isTaskBlockingSchedule: (taskId) => activeTaskIds.has(taskId),
      ...overrides,
    });
  }

  function replaceSchedule(id: string, patch: Partial<ReturnType<ScheduleStore['get']> extends infer T ? NonNullable<T> : never>) {
    const schedule = store.get(id)!;
    store.replace({ ...schedule, ...patch });
    return store.get(id)!;
  }

  it('fires a due schedule on tick', async () => {
    const schedule = store.create({
      name: 'Test',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });

    const runner = createRunner();
    await runner.tick();

    expect(launched).toHaveLength(1);
    expect(store.get(schedule.id)!.latestExecution?.taskId).toBe('task-1');
    expect(store.get(schedule.id)!.latestExecution?.outcome).toBe('running');
  });

  it('skips disabled schedules', async () => {
    const schedule = store.create({
      name: 'Disabled',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
      enabled: false,
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });

    const runner = createRunner();
    await runner.tick();

    expect(launched).toHaveLength(0);
    expect(store.get(schedule.id)!.latestExecution).toBeUndefined();
  });

  it('skips when previous run is still active', async () => {
    const schedule = store.create({
      name: 'Active',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });

    const runner = createRunner();
    await runner.tick();
    expect(launched).toHaveLength(1);

    replaceSchedule(schedule.id, {
      lastScheduledFor: new Date(Date.now() - 2 * 60_000).toISOString(),
    });

    await runner.tick();

    expect(launched).toHaveLength(1);
    expect(store.get(schedule.id)!.latestExecution?.outcome).toBe('skipped_active');
    expect(store.get(schedule.id)!.latestExecution?.reasonCode).toBe('previous_run_active');
    expect(store.get(schedule.id)!.executionLedger?.at(-1)).toEqual(expect.objectContaining({
      outcome: 'skipped_active',
      reasonCode: 'previous_run_active',
      blockingTaskId: 'task-1',
    }));
  });

  it('fires when previous run is stale (older than threshold)', async () => {
    // Reproduces the codex-rebase incident: prior task hung in inProgress for
    // many hours; the staleness gate should let the next cron tick through
    // instead of silently skipping forever.
    const schedule = store.create({
      name: 'Stale',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
      latestExecution: {
        receiptId: 'prior-receipt',
        executionToken: 'prior-token',
        evaluatedAt: new Date(Date.now() - 13 * 3_600_000).toISOString(),
        triggeredAt: new Date(Date.now() - 13 * 3_600_000).toISOString(),
        trigger: 'cron',
        taskId: 'stale-task',
        outcome: 'running',
        reasonCode: 'none',
      },
    });

    // The deps closure decides freshness — return false to mimic prod's stale
    // bypass path (task exists and is `inProgress`, but updatedAt is >12h ago).
    const runner = createRunner({ isTaskBlockingSchedule: () => false });
    await runner.tick();

    expect(launched).toHaveLength(1);
    expect(store.get(schedule.id)!.latestExecution?.outcome).toBe('running');
    expect(store.get(schedule.id)!.latestExecution?.taskId).toBe('task-1');
  });

  it('skips when at max active tasks', async () => {
    activeCount = 10;

    const schedule = store.create({
      name: 'Capped',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
      maxTriggers: 2,
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });

    const runner = createRunner();
    await runner.tick();

    expect(launched).toHaveLength(0);
    expect(store.get(schedule.id)!.latestExecution?.outcome).toBe('skipped_capacity');
    expect(store.get(schedule.id)!.latestExecution?.reasonCode).toBe('capacity');
    expect(store.get(schedule.id)!.executionLedger?.at(-1)).toEqual(expect.objectContaining({
      outcome: 'skipped_capacity',
      reasonCode: 'capacity',
      scheduledFor: expect.any(String),
    }));
    expect(store.get(schedule.id)!.remainingTriggers).toBe(2);
    expect(store.get(schedule.id)!.enabled).toBe(true);
  });

  it('fails when playbook file is missing', async () => {
    const schedule = store.create({
      name: 'Missing Playbook',
      cron: '* * * * *',
      playbook: { path: 'nonexistent.md', parameters: {} },
      cwd: dir,
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });

    const runner = createRunner();
    await runner.tick();

    expect(launched).toHaveLength(0);
    expect(store.get(schedule.id)!.latestExecution?.outcome).toBe('dispatch_failed');
    expect(store.get(schedule.id)!.latestExecution?.reasonCode).toBe('missing_playbook');
  });

  it('fails when cwd does not exist', async () => {
    const missingCwd = join(dir, 'missing-cwd');
    const schedule = store.create({
      name: 'Bad CWD',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: missingCwd,
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });

    const runner = createRunner();
    await runner.tick();

    expect(launched).toHaveLength(0);
    expect(store.get(schedule.id)!.latestExecution?.outcome).toBe('dispatch_failed');
    expect(store.get(schedule.id)!.latestExecution?.reasonCode).toBe('missing_cwd');
  });

  it('runNow fires immediately regardless of cron', async () => {
    const schedule = store.create({
      name: 'Manual',
      cron: '0 0 1 1 *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
    });

    const runner = createRunner();
    const result = await runner.runNow(schedule.id);

    expect(result.taskId).toBe('task-1');
    expect(launched).toHaveLength(1);
    expect(store.get(schedule.id)!.latestExecution?.trigger).toBe('manual');
  });

  it('consumes finite cron trigger quota and auto-stops once exhausted', async () => {
    const schedule = store.create({
      name: 'Finite',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
      maxTriggers: 2,
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 3 * 60_000).toISOString(),
    });

    const runner = createRunner();
    await runner.tick();

    expect(store.get(schedule.id)!.remainingTriggers).toBe(1);
    expect(store.get(schedule.id)!.enabled).toBe(true);

    activeTaskIds.clear();
    activeCount = 0;
    replaceSchedule(schedule.id, {
      lastScheduledFor: new Date(Date.now() - 2 * 60_000).toISOString(),
    });

    await runner.tick();

    expect(launched).toHaveLength(2);
    expect(store.get(schedule.id)!.remainingTriggers).toBe(0);
    expect(store.get(schedule.id)!.enabled).toBe(false);
    expect(store.get(schedule.id)!.stopReason).toBe('trigger_limit_reached');
    expect(store.get(schedule.id)!.exhaustedAt).toEqual(expect.any(String));
  });

  it('runNow remains available for exhausted schedules and does not consume cron quota', async () => {
    const schedule = store.create({
      name: 'Exhausted',
      cron: '0 0 1 1 *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
      maxTriggers: 1,
    });
    replaceSchedule(schedule.id, {
      enabled: false,
      remainingTriggers: 0,
      stopReason: 'trigger_limit_reached',
      exhaustedAt: new Date().toISOString(),
    });

    const runner = createRunner();
    const result = await runner.runNow(schedule.id);

    expect(result.taskId).toBe('task-1');
    expect(launched).toHaveLength(1);
    expect(store.get(schedule.id)!.latestExecution?.trigger).toBe('manual');
    expect(store.get(schedule.id)!.remainingTriggers).toBe(0);
    expect(store.get(schedule.id)!.stopReason).toBe('trigger_limit_reached');
  });

  it('runNow returns error for unknown schedule', async () => {
    const runner = createRunner();
    const result = await runner.runNow('nonexistent');
    expect(result.error).toBe('Schedule not found');
  });

  it('catches up a missed schedule within 24h on start', async () => {
    const schedule = store.create({
      name: 'Catchup',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });

    const runner = createRunner();
    runner.start();
    await vi.waitFor(() => {
      expect(launched).toHaveLength(1);
    });
    runner.stop();

    expect(service.getStatusSnapshot().catchUpEnabled).toBe(true);
    expect(store.get(schedule.id)!.executionLedger?.at(-1)).toEqual(expect.objectContaining({
      outcome: 'running',
      catchUp: true,
      scheduledFor: expect.any(String),
    }));
  });

  it('records stale catch-up skips durably and advances the missed due watermark', async () => {
    const schedule = store.create({
      name: 'StaleCatchup',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 25 * 60 * 60_000).toISOString(),
    });

    const runner = createRunner();
    runner.start();
    await vi.waitFor(() => {
      expect(store.get(schedule.id)!.latestExecution?.outcome).toBe('skipped_stale_catchup');
    });
    runner.stop();

    const updated = store.get(schedule.id)!;
    expect(launched).toHaveLength(0);
    expect(updated.latestExecution).toEqual(expect.objectContaining({
      outcome: 'skipped_stale_catchup',
      reasonCode: 'stale_catchup',
      catchUp: true,
    }));
    expect(updated.lastScheduledFor).toBe(updated.latestExecution?.scheduledFor);
    expect(updated.executionLedger).toEqual([
      expect.objectContaining({
        outcome: 'skipped_stale_catchup',
        reasonCode: 'stale_catchup',
        catchUp: true,
      }),
    ]);
  });

  it('records stale due skips during steady-state ticks', async () => {
    const schedule = store.create({
      name: 'StaleTick',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 25 * 60 * 60_000).toISOString(),
    });

    const runner = createRunner();
    await runner.tick();

    const updated = store.get(schedule.id)!;
    expect(launched).toHaveLength(0);
    expect(updated.latestExecution).toEqual(expect.objectContaining({
      outcome: 'skipped_stale_catchup',
      reasonCode: 'stale_catchup',
      catchUp: true,
    }));
    expect(updated.executionLedger).toEqual([
      expect.objectContaining({
        outcome: 'skipped_stale_catchup',
        scheduledFor: updated.lastScheduledFor,
      }),
    ]);
  });

  it('skips catch-up when KOOKR_NO_CATCHUP is set', async () => {
    const schedule = store.create({
      name: 'NoCatchup',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });

    process.env.KOOKR_NO_CATCHUP = '1';
    const runner = createRunner();
    runner.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    runner.stop();

    expect(launched).toHaveLength(0);
    expect(service.getStatusSnapshot().catchUpEnabled).toBe(false);
  });

  it('prevents overlapping ticks', async () => {
    const schedule = store.create({
      name: 'Overlap',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });

    let resolveFirst!: () => void;
    const firstLaunch = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    let launchCount = 0;

    const runner = createRunner({
      launcher: async () => {
        launchCount += 1;
        if (launchCount === 1) {
          await firstLaunch;
        }
        return { task: { id: `task-${launchCount}` } as any, queued: false };
      },
    });

    const tick1 = runner.tick();
    const tick2 = runner.tick();

    resolveFirst();
    await tick1;
    await tick2;

    expect(launchCount).toBe(1);
  });
});

describe('isTaskBlockingSchedule', () => {
  const now = new Date('2026-05-08T12:00:00Z');

  it('returns false when task is undefined', () => {
    expect(isTaskBlockingSchedule(undefined, now)).toBe(false);
  });

  it('returns false when task is in a terminal status', () => {
    const task = { status: 'completed' as const, updatedAt: now };
    expect(isTaskBlockingSchedule(task, now)).toBe(false);
  });

  it('returns true when task is fresh and active', () => {
    const task = {
      status: 'inProgress' as const,
      updatedAt: new Date(now.getTime() - 60_000),
    };
    expect(isTaskBlockingSchedule(task, now)).toBe(true);
  });

  it('returns false when active task exceeds the staleness threshold', () => {
    const task = {
      status: 'inProgress' as const,
      updatedAt: new Date(now.getTime() - SCHEDULE_GATE_MAX_TASK_AGE_MS - 1),
    };
    expect(isTaskBlockingSchedule(task, now)).toBe(false);
  });

  it('treats the boundary (age === threshold) as stale', () => {
    const task = {
      status: 'inProgress' as const,
      updatedAt: new Date(now.getTime() - SCHEDULE_GATE_MAX_TASK_AGE_MS),
    };
    expect(isTaskBlockingSchedule(task, now)).toBe(false);
  });

  it('treats just-under-the-boundary as fresh', () => {
    const task = {
      status: 'inProgress' as const,
      updatedAt: new Date(now.getTime() - SCHEDULE_GATE_MAX_TASK_AGE_MS + 1),
    };
    expect(isTaskBlockingSchedule(task, now)).toBe(true);
  });

  it('clamps future updatedAt to age 0 (clock-skew defense)', () => {
    // Without the Math.max(0, …) clamp, a future updatedAt would yield a
    // negative ageMs and silently bypass the freshness check forever.
    const task = {
      status: 'inProgress' as const,
      updatedAt: new Date(now.getTime() + 60 * 60_000),
    };
    expect(isTaskBlockingSchedule(task, now)).toBe(true);
  });
});
