import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, symlink } from 'node:fs/promises';
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

const INVALID_PLAYBOOK_PATH_ERROR = 'Playbook path must stay inside the selected playbooks directory';

describe('ScheduleRunner', () => {
  let dir: string;
  let store: ScheduleStore;
  let service: ScheduleService;
  let validator: ScheduleValidator;
  let launched: Array<{
    prompt: string;
    cwd: string;
    agentType?: string;
    effort?: string;
    model?: string;
  }>;
  let taskIdCounter: number;
  let activeTaskIds: Set<string>;
  /** Task ids the mock launcher pended instead of launching (issue #1526 Phase A: at-capacity fires queue). */
  let pendingTaskIds: Set<string>;
  let activeCount: number;
  let maxActive: number;
  let runners: Set<ScheduleRunner>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'runner-test-'));
    store = new ScheduleStore(dir);
    validator = new ScheduleValidator();
    service = new ScheduleService({ store, validator });
    launched = [];
    taskIdCounter = 0;
    activeTaskIds = new Set();
    pendingTaskIds = new Set();
    activeCount = 0;
    maxActive = 10;
    runners = new Set();

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
    await Promise.all([...runners].map((runner) => runner.stop()));
    delete process.env.KOOKR_NO_CATCHUP;
    delete process.env.KOOKR_AUTO_CATCHUP;
    await rm(dir, { recursive: true, force: true });
  });

  function createRunner(overrides: Partial<ScheduleRunnerDeps> = {}) {
    const runner = new ScheduleRunner({
      store,
      service,
      validator,
      // Mirrors real launchTask semantics (src/server/launch-service.ts): at
      // or over capacity, the task is created and pended rather than
      // launched (issue #1526 Phase A) — `queued: true`, no active-count
      // increment. Below capacity, unchanged: launches immediately.
      launcher: async (opts) => {
        const taskId = `task-${++taskIdCounter}`;
        launched.push({
          prompt: opts.prompt,
          cwd: opts.cwd,
          agentType: opts.agentType,
          effort: opts.effort,
          model: opts.model,
        });
        const queued = activeCount >= maxActive;
        if (queued) {
          pendingTaskIds.add(taskId);
        } else {
          activeTaskIds.add(taskId);
          activeCount += 1;
        }
        return { task: { id: taskId } as any, queued };
      },
      getActiveCount: () => activeCount,
      getMaxActiveTasks: () => maxActive,
      isTaskBlockingSchedule: (taskId) => activeTaskIds.has(taskId) || pendingTaskIds.has(taskId),
      getBlockingTaskStatus: (taskId) => {
        if (activeTaskIds.has(taskId)) return 'inProgress';
        if (pendingTaskIds.has(taskId)) return 'pending';
        return undefined;
      },
      ...overrides,
    });
    runners.add(runner);
    return runner;
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
    expect(store.get(schedule.id)!.executionLedger).toEqual([
      expect.objectContaining({
        taskId: 'task-1',
        outcome: 'running',
        decision: 'cron_due',
        scheduledFor: expect.any(String),
      }),
    ]);
  });

  it('forwards schedule effort and model pins into the launcher (#1518)', async () => {
    const schedule = store.create({
      name: 'Fable max',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
      agentType: 'claude-code',
      effort: 'max',
      model: 'claude-fable-5',
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });

    const runner = createRunner();
    await runner.tick();

    expect(launched).toHaveLength(1);
    expect(launched[0]).toMatchObject({
      effort: 'max',
      model: 'claude-fable-5',
      agentType: 'claude-code',
    });
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
    expect(store.get(schedule.id)!.executionLedger.at(-1)).toEqual(expect.objectContaining({
      outcome: 'skipped_active',
      reasonCode: 'previous_run_active',
      blockingTaskId: 'task-1',
    }));
    // The blocking pointer must survive the skipped_active write, or a
    // second consecutive skip would lose track of the still-active task.
    expect(store.get(schedule.id)!.latestExecution?.taskId).toBe('task-1');
  });

  it('preserves the blocking pointer across two consecutive skipped_active writes', async () => {
    const schedule = store.create({
      name: 'ActiveTwice',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 3 * 60_000).toISOString(),
    });

    const runner = createRunner();
    await runner.tick();
    expect(launched).toHaveLength(1);

    // Two consecutive skips while the task is still active — before the fix,
    // the first skip already wiped latestExecution.taskId.
    for (let i = 0; i < 2; i++) {
      replaceSchedule(schedule.id, { lastScheduledFor: new Date(Date.now() - 2 * 60_000).toISOString() });
      await runner.tick();
      expect(store.get(schedule.id)!.latestExecution?.outcome).toBe('skipped_active');
      expect(store.get(schedule.id)!.latestExecution?.taskId).toBe('task-1');
    }
    expect(launched).toHaveLength(1);
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

  it('queues instead of skipping when at max active tasks (issue #1526 Phase A)', async () => {
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

    // The fire goes through the normal launcher — a task IS created, just
    // pended instead of launched. Nothing is silently dropped.
    expect(launched).toHaveLength(1);
    expect(store.get(schedule.id)!.latestExecution?.outcome).toBe('queued_capacity');
    expect(store.get(schedule.id)!.latestExecution?.reasonCode).toBe('capacity');
    expect(store.get(schedule.id)!.latestExecution?.taskId).toBe('task-1');
    expect(store.get(schedule.id)!.executionLedger.at(-1)).toEqual(expect.objectContaining({
      outcome: 'queued_capacity',
      reasonCode: 'capacity',
      taskId: 'task-1',
    }));
    // A capacity-queued fire still consumes its cron trigger quota — it DID fire.
    expect(store.get(schedule.id)!.remainingTriggers).toBe(1);
    expect(store.get(schedule.id)!.enabled).toBe(true);
  });

  it('coalesces a second fire while the previous fire is still pending (issue #1526 Phase A)', async () => {
    activeCount = 10; // at capacity — every fire queues instead of launching

    const schedule = store.create({
      name: 'Coalesce',
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
    expect(store.get(schedule.id)!.latestExecution?.outcome).toBe('queued_capacity');

    replaceSchedule(schedule.id, {
      lastScheduledFor: new Date(Date.now() - 2 * 60_000).toISOString(),
    });
    await runner.tick();

    // No second task created — the first fire's task is still pending.
    expect(launched).toHaveLength(1);
    expect(store.get(schedule.id)!.latestExecution?.outcome).toBe('skipped_coalesced');
    expect(store.get(schedule.id)!.latestExecution?.reasonCode).toBe('previous_run_pending');
    expect(store.get(schedule.id)!.executionLedger.at(-1)).toEqual(expect.objectContaining({
      outcome: 'skipped_coalesced',
      reasonCode: 'previous_run_pending',
      blockingTaskId: 'task-1',
    }));
  });

  it('preserves the blocking pointer across THREE fires with distinct prompts — no burst-launch (issue #1526 Phase A regression)', async () => {
    // Regression for the coalesce-pointer-wipe bug: markExecutionOutcome used
    // to write latestExecution.taskId from receipt.taskId alone, which is
    // always undefined for a skip — so a second consecutive skip wiped the
    // pointer fire() relies on, and a third fire would launch a duplicate.
    // A schedule with a genuinely dynamic/templated prompt (not a static one
    // launchTask's prompt-hash dedup could incidentally save) is exactly the
    // case that bites: each fire below resolves a DIFFERENT literal prompt,
    // so nothing but the blocking-pointer chain itself can prevent a burst.
    activeCount = 10; // at capacity — every fire queues instead of launching

    const schedule = store.create({
      name: 'ThreeFireCoalesce',
      cron: '* * * * *',
      playbook: { path: 'dynamic.md', parameters: {} },
      cwd: dir,
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });

    async function writeDynamicPlaybook(marker: string): Promise<void> {
      await writeFile(join(dir, '.kookr', 'playbooks', 'dynamic.md'), `---
name: Dynamic Playbook
description: A playbook whose body changes per fire
parameters: []
checklist:
  - Step 1
---

Do the test thing (${marker}).
`);
    }

    const runner = createRunner();

    // Fire 1: queues task-1 with prompt A.
    await writeDynamicPlaybook('fire-1');
    await runner.tick();
    expect(launched).toHaveLength(1);
    expect(store.get(schedule.id)!.latestExecution?.outcome).toBe('queued_capacity');
    expect(store.get(schedule.id)!.latestExecution?.taskId).toBe('task-1');

    // Fire 2: prompt B — must coalesce against task-1, not launch.
    await writeDynamicPlaybook('fire-2');
    replaceSchedule(schedule.id, { lastScheduledFor: new Date(Date.now() - 2 * 60_000).toISOString() });
    await runner.tick();
    expect(launched).toHaveLength(1);
    expect(store.get(schedule.id)!.latestExecution?.outcome).toBe('skipped_coalesced');
    // The pointer must survive this write for fire 3 to see it.
    expect(store.get(schedule.id)!.latestExecution?.taskId).toBe('task-1');

    // Fire 3: prompt C — the bug let this one through and launched task-2.
    await writeDynamicPlaybook('fire-3');
    replaceSchedule(schedule.id, { lastScheduledFor: new Date(Date.now() - 2 * 60_000).toISOString() });
    await runner.tick();

    expect(launched).toHaveLength(1); // still exactly one launcher call
    expect(launched[0].prompt).toContain('fire-1'); // the one call was fire 1's
    expect(store.get(schedule.id)!.latestExecution?.outcome).toBe('skipped_coalesced');
    expect(store.get(schedule.id)!.latestExecution?.taskId).toBe('task-1');
    expect(store.get(schedule.id)!.executionLedger.at(-1)).toEqual(expect.objectContaining({
      outcome: 'skipped_coalesced',
      reasonCode: 'previous_run_pending',
      blockingTaskId: 'task-1',
    }));

    // recordTaskTerminalOutcome must still be able to find this schedule by
    // its (preserved) latestExecution.taskId after two consecutive skips.
    await service.recordTaskTerminalOutcome('task-1', 'completed');
    expect(store.get(schedule.id)!.latestExecution?.outcome).toBe('completed');
  });

  it('fires normally below capacity — queued_capacity/coalescing do not activate', async () => {
    const schedule = store.create({
      name: 'BelowCapacity',
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
    expect(store.get(schedule.id)!.latestExecution?.outcome).toBe('running');
  });

  it('suppresses firing while the server is draining (issue #659)', async () => {
    const schedule = store.create({
      name: 'Draining',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
      maxTriggers: 2,
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });

    const runner = createRunner({ isAccepting: () => false });
    await runner.tick();

    expect(launched).toHaveLength(0);
    expect(store.get(schedule.id)!.latestExecution?.outcome).toBe('skipped_draining');
    expect(store.get(schedule.id)!.latestExecution?.reasonCode).toBe('draining');
    expect(store.get(schedule.id)!.latestExecution?.message).toContain('draining');
    // The cron budget must not be consumed by a drain skip.
    expect(store.get(schedule.id)!.remainingTriggers).toBe(2);
    expect(store.get(schedule.id)!.enabled).toBe(true);
  });

  it('fires normally once the server stops draining', async () => {
    const schedule = store.create({
      name: 'Resumed',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });

    const runner = createRunner({ isAccepting: () => true });
    await runner.tick();

    expect(launched).toHaveLength(1);
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

  it('rejects a stored traversal playbook path before launching', async () => {
    await writeFile(join(dir, 'escape.md'), `---
name: Escaped Playbook
parameters: []
---

Do not launch this.
`);
    const schedule = store.create({
      name: 'Traversal Playbook',
      cron: '* * * * *',
      playbook: { path: '../../escape.md', parameters: {} },
      cwd: dir,
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });

    const runner = createRunner();
    await runner.tick();

    expect(launched).toHaveLength(0);
    expect(store.get(schedule.id)!.latestExecution?.outcome).toBe('dispatch_failed');
    expect(store.get(schedule.id)!.latestExecution?.message).toBe(INVALID_PLAYBOOK_PATH_ERROR);
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
    expect(store.get(schedule.id)!.executionLedger).toEqual([
      expect.objectContaining({
        trigger: 'manual',
        decision: 'manual_run',
        outcome: 'running',
        taskId: 'task-1',
      }),
    ]);
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

  it('records a missed startup run for manual recovery by default', async () => {
    const schedule = store.create({
      name: 'ManualCatchup',
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
      expect(store.get(schedule.id)!.latestExecution?.outcome).toBe('skipped_manual');
    });
    await runner.stop();

    expect(launched).toHaveLength(0);
    expect(service.getStatusSnapshot().catchUpEnabled).toBe(false);
    expect(store.get(schedule.id)!.executionLedger[0]).toEqual(expect.objectContaining({
      decision: 'manual_catch_up',
      outcome: 'skipped_manual',
      reasonCode: 'manual_catch_up_required',
      scheduledFor: expect.any(String),
    }));

    await runner.tick();

    expect(launched).toHaveLength(0);
    expect(new Date(store.getWithComputed(schedule.id)!.nextRunAt!).getTime()).toBeGreaterThan(Date.now());
  });

  it('catches up a missed schedule within 24h on start when explicitly enabled', async () => {
    const schedule = store.create({
      name: 'Catchup',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });

    process.env.KOOKR_AUTO_CATCHUP = '1';
    const runner = createRunner();
    runner.start();
    await vi.waitFor(() => {
      expect(launched).toHaveLength(1);
    });
    await runner.stop();

    expect(service.getStatusSnapshot().catchUpEnabled).toBe(true);
    expect(store.get(schedule.id)!.executionLedger[0]).toEqual(expect.objectContaining({
      decision: 'catch_up',
      outcome: 'running',
    }));
  });

  it('records stale catch-up skips in the execution ledger', async () => {
    const schedule = store.create({
      name: 'StaleCatchup',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 26 * 60 * 60_000).toISOString(),
    });

    const runner = createRunner();
    runner.start();
    await vi.waitFor(() => {
      expect(store.get(schedule.id)!.latestExecution?.outcome).toBe('skipped_stale');
    });
    await runner.stop();

    expect(launched).toHaveLength(0);
    expect(store.get(schedule.id)!.latestExecution?.reasonCode).toBe('stale_catch_up');
    await runner.tick();
    expect(launched).toHaveLength(0);
    expect(store.get(schedule.id)!.executionLedger).toEqual([
      expect.objectContaining({
        decision: 'stale_catch_up',
        outcome: 'skipped_stale',
        reasonCode: 'stale_catch_up',
        scheduledFor: expect.any(String),
      }),
    ]);
  });

  it('waits for in-flight catch-up work on stop', async () => {
    const schedule = store.create({
      name: 'PendingCatchup',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });

    let releaseLaunch!: () => void;
    let launchStarted = false;
    const launchBlocked = new Promise<{ task: { id: string }; queued: boolean }>((resolve) => {
      releaseLaunch = () => resolve({ task: { id: 'task-1' }, queued: false });
    });
    const runner = createRunner({
      launcher: async () => {
        launchStarted = true;
        return launchBlocked;
      },
    });

    process.env.KOOKR_AUTO_CATCHUP = '1';
    runner.start();
    await vi.waitFor(() => {
      expect(launchStarted).toBe(true);
    });

    let stopped = false;
    const stopPromise = runner.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stopped).toBe(false);

    releaseLaunch();
    await stopPromise;

    expect(stopped).toBe(true);
    expect(store.get(schedule.id)!.latestExecution?.taskId).toBe('task-1');
  });

  it('skips all startup catch-up handling when KOOKR_NO_CATCHUP is set', async () => {
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
    process.env.KOOKR_AUTO_CATCHUP = '1';
    const runner = createRunner();
    runner.start();
    await vi.waitFor(() => {
      expect(store.get(schedule.id)!.lastScheduledFor).toEqual(expect.any(String));
    });
    await runner.stop();

    expect(launched).toHaveLength(0);
    expect(service.getStatusSnapshot().catchUpEnabled).toBe(false);
    expect(service.getStatusSnapshot().catchUpMode).toBe('off');
    expect(store.get(schedule.id)!.latestExecution).toBeUndefined();

    await runner.tick();

    expect(launched).toHaveLength(0);
    expect(new Date(store.getWithComputed(schedule.id)!.nextRunAt!).getTime()).toBeGreaterThan(Date.now());
  });

  it('skips stale startup catch-up ledger handling when KOOKR_NO_CATCHUP is set', async () => {
    const schedule = store.create({
      name: 'NoStaleCatchup',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 26 * 60 * 60_000).toISOString(),
    });

    process.env.KOOKR_NO_CATCHUP = '1';
    const runner = createRunner();
    runner.start();
    await vi.waitFor(() => {
      expect(store.get(schedule.id)!.lastScheduledFor).toEqual(expect.any(String));
    });
    await runner.stop();

    expect(launched).toHaveLength(0);
    expect(store.get(schedule.id)!.latestExecution).toBeUndefined();
    expect(store.get(schedule.id)!.executionLedger).toEqual([]);
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

  describe('tier-aware firing and resolution health (R9)', () => {
    let pluginRoot: string;

    beforeEach(async () => {
      pluginRoot = join(dir, 'plugin');
      await mkdir(join(pluginRoot, 'playbooks'), { recursive: true });
      await mkdir(join(pluginRoot, '.claude-plugin'), { recursive: true });
      await writeFile(join(pluginRoot, '.claude-plugin', 'plugin.json'), '{"name":"kookr-toolkit"}');
      await writeFile(join(pluginRoot, 'playbooks', 'plug.md'), `---
name: Plugin Playbook
description: A plugin playbook
parameters: []
checklist:
  - Step 1
---

Do the plugin thing.
`);
      process.env.KOOKR_PLUGIN_DIR = pluginRoot;
    });

    afterEach(() => {
      delete process.env.KOOKR_PLUGIN_DIR;
    });

    function makeDue(id: string) {
      replaceSchedule(id, { createdAt: new Date(Date.now() - 2 * 60_000).toISOString() });
    }

    it('fires a plugin-scoped schedule whose cwd lacks the file', async () => {
      // `dir` has no plug.md in its project tier — only the plugin tier does.
      const schedule = store.create({
        name: 'Plugin Job',
        cron: '* * * * *',
        playbook: { path: 'plug.md', parameters: {}, scope: 'plugin' },
        cwd: dir,
      });
      makeDue(schedule.id);

      await createRunner().tick();

      expect(launched).toHaveLength(1);
      expect(launched[0].prompt).toContain('Do the plugin thing');
    });

    it('pinned-tier-deleted fails loudly with NO cross-tier substitution', async () => {
      // test.md exists in the PROJECT tier but the schedule is pinned to plugin,
      // which has no test.md. Must fail missing_playbook, never substitute.
      const schedule = store.create({
        name: 'Mispinned',
        cron: '* * * * *',
        playbook: { path: 'test.md', parameters: {}, scope: 'plugin' },
        cwd: dir,
      });
      makeDue(schedule.id);

      await createRunner().tick();

      expect(launched).toHaveLength(0);
      expect(store.get(schedule.id)!.latestExecution?.outcome).toBe('dispatch_failed');
      expect(store.get(schedule.id)!.latestExecution?.reasonCode).toBe('missing_playbook');
    });

    it('cache miss renders unknown before the first refresh', () => {
      const schedule = store.create({
        name: 'Fresh',
        cron: '0 9 * * *',
        playbook: { path: 'test.md', parameters: {} },
        cwd: dir,
      });
      expect(store.getWithComputed(schedule.id)!.playbookResolution).toBe('unknown');
    });

    it('marks a resolvable schedule resolvable and an unresolvable one unresolvable', () => {
      const ok = store.create({
        name: 'OK',
        cron: '0 9 * * *',
        playbook: { path: 'test.md', parameters: {} },
        cwd: dir,
      });
      const broken = store.create({
        name: 'Broken',
        cron: '0 9 * * *',
        playbook: { path: 'gone.md', parameters: {} },
        cwd: dir,
      });

      createRunner().refreshPlaybookResolution();

      expect(store.getWithComputed(ok.id)!.playbookResolution).toBe('resolvable');
      expect(store.getWithComputed(broken.id)!.playbookResolution).toBe('unresolvable');
    });

    it('marks a symlink that escapes the playbooks directory as unresolvable', async () => {
      const escaped = join(dir, 'outside.md');
      await writeFile(escaped, '---\nname: Outside\nparameters: []\n---\nbody\n');
      await symlink(escaped, join(dir, '.kookr', 'playbooks', 'linked.md'));
      const schedule = store.create({
        name: 'Escaping Link',
        cron: '0 9 * * *',
        playbook: { path: 'linked.md', parameters: {} },
        cwd: dir,
      });

      createRunner().refreshPlaybookResolution();

      expect(store.getWithComputed(schedule.id)!.playbookResolution).toBe('unresolvable');
    });

    it('reports a DISABLED broken schedule as unresolvable', () => {
      const broken = store.create({
        name: 'Disabled Broken',
        cron: '0 9 * * *',
        playbook: { path: 'gone.md', parameters: {} },
        cwd: dir,
        enabled: false,
      });

      createRunner().refreshPlaybookResolution();

      expect(store.getWithComputed(broken.id)!.playbookResolution).toBe('unresolvable');
    });

    it('renders unknown after a cwd/path edit invalidates the cached signature', () => {
      const schedule = store.create({
        name: 'Edited',
        cron: '0 9 * * *',
        playbook: { path: 'test.md', parameters: {} },
        cwd: dir,
      });
      createRunner().refreshPlaybookResolution();
      expect(store.getWithComputed(schedule.id)!.playbookResolution).toBe('resolvable');

      // Edit the path — the cached entry's signature no longer matches.
      replaceSchedule(schedule.id, { playbook: { path: 'other.md', parameters: {} } });
      expect(store.getWithComputed(schedule.id)!.playbookResolution).toBe('unknown');
    });

    it('emits a warn on a resolvable→unresolvable transition', async () => {
      const schedule = store.create({
        name: 'Flips',
        cron: '0 9 * * *',
        playbook: { path: 'flip.md', parameters: {} },
        cwd: dir,
      });
      const file = join(dir, '.kookr', 'playbooks', 'flip.md');
      await writeFile(file, '---\nname: Flip\nparameters: []\n---\nbody\n');

      const runner = createRunner();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      runner.refreshPlaybookResolution(); // seed: resolvable
      await rm(file, { force: true });
      runner.refreshPlaybookResolution(); // transition: unresolvable
      const warned = warnSpy.mock.calls.some(([msg]) => typeof msg === 'string' && msg.includes('became unresolvable'));
      warnSpy.mockRestore();

      expect(store.getWithComputed(schedule.id)!.playbookResolution).toBe('unresolvable');
      expect(warned).toBe(true);
    });

    it('emits NO spurious warn for an already-broken schedule across restarts', () => {
      store.create({
        name: 'Born Broken',
        cron: '0 9 * * *',
        playbook: { path: 'gone.md', parameters: {} },
        cwd: dir,
      });

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      // Two fresh runners simulate a restart — each seeds its own baseline.
      createRunner().refreshPlaybookResolution();
      createRunner().refreshPlaybookResolution();
      const warned = warnSpy.mock.calls.some(([msg]) => typeof msg === 'string' && msg.includes('became unresolvable'));
      warnSpy.mockRestore();

      expect(warned).toBe(false);
    });

    it('emits NO warn when the SAME runner re-observes an unchanged-broken schedule (false→false)', () => {
      store.create({
        name: 'Stays Broken',
        cron: '0 9 * * *',
        playbook: { path: 'gone.md', parameters: {} },
        cwd: dir,
      });

      const runner = createRunner();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      // Same runner, two ticks: seed (unresolvable) then re-observe still
      // unresolvable. The `prev.resolvable` guard must suppress a re-warn —
      // only a true→false transition warns, not steady-state brokenness.
      runner.refreshPlaybookResolution();
      runner.refreshPlaybookResolution();
      const warned = warnSpy.mock.calls.some(([msg]) => typeof msg === 'string' && msg.includes('became unresolvable'));
      warnSpy.mockRestore();

      expect(warned).toBe(false);
    });
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
