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
  FIRE_WALL_CLOCK_CAP_MS,
} from './schedule-runner.js';
import { ScheduleService } from './schedule-service.js';
import { ScheduleValidator } from './schedule-validator.js';
import { PendingQueueFullError } from './launch-service.js';

const INVALID_PLAYBOOK_PATH_ERROR = 'Playbook path must stay inside the selected playbooks directory';

/** Synthetic relaunch-arbiter key the catch-up path uses for `scheduleId` (#1900). */
const catchUpKey = (scheduleId: string) => ({ repo: `schedule:${scheduleId}`, number: 0 });

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
    launchSource?: string;
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
    delete process.env.KOOKR_MANUAL_CATCHUP;
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
          launchSource: opts.launchSource,
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
      // issue #1526 Phase C / C3: schedule provenance — exempts the fire from
      // the spawn burst budget and stamps metadata.launchSource.
      launchSource: 'schedule',
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

  it('suppresses firing while the automation kill-switch is engaged (issue #1710)', async () => {
    const schedule = store.create({
      name: 'SafeMode',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
      maxTriggers: 2,
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });

    const runner = createRunner({ isAutomationEnabled: () => false });
    await runner.tick();

    expect(launched).toHaveLength(0);
    expect(store.get(schedule.id)!.latestExecution?.outcome).toBe('skipped_safe_mode');
    expect(store.get(schedule.id)!.latestExecution?.reasonCode).toBe('safe_mode');
    expect(store.get(schedule.id)!.latestExecution?.message).toContain('SAFE MODE');
    expect(store.get(schedule.id)!.remainingTriggers).toBe(2);
    expect(store.get(schedule.id)!.enabled).toBe(true);
  });

  it('fires normally once the automation kill-switch is disengaged', async () => {
    const schedule = store.create({
      name: 'SafeModeResumed',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });

    const runner = createRunner({ isAutomationEnabled: () => true });
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

  it('records a missed startup run for manual recovery when KOOKR_MANUAL_CATCHUP is set', async () => {
    const schedule = store.create({
      name: 'ManualCatchup',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });

    process.env.KOOKR_MANUAL_CATCHUP = '1';
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

  it('catches up a missed schedule by default with no env override, exactly once per boot (#1900)', async () => {
    const schedule = store.create({
      name: 'DefaultCatchup',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });

    // No KOOKR_AUTO_CATCHUP / KOOKR_MANUAL_CATCHUP / KOOKR_NO_CATCHUP: the
    // #1900 default is `auto`.
    const runner = createRunner();
    runner.start();
    await vi.waitFor(() => {
      expect(launched).toHaveLength(1);
    });
    await runner.stop();

    expect(service.getStatusSnapshot().catchUpMode).toBe('auto');
    expect(service.getStatusSnapshot().catchUpEnabled).toBe(true);
    expect(store.get(schedule.id)!.executionLedger[0]).toEqual(expect.objectContaining({
      decision: 'catch_up',
      outcome: 'running',
    }));

    // Single-run-per-boot: the next cron tick must not re-fire the same missed
    // slot (the watermark advanced past it).
    await runner.tick();
    expect(launched).toHaveLength(1);
  });

  it('gates the catch-up fire behind the relaunch arbiter and holds the lease under the fired task (#1900)', async () => {
    const schedule = store.create({
      name: 'LeaseGatedCatchup',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });

    const acquired: Array<{ key: string; holderId: string }> = [];
    const arbiter = {
      evaluate: () => ({ admit: true as const }),
      tryAcquire: (key: { repo: string; number: number }, holderId: string) => {
        acquired.push({ key: `${key.repo}#${key.number}`, holderId });
        return { ok: true as const, lease: { key, holderId, acquiredAt: '' }, reentrant: false };
      },
    };

    const runner = createRunner({ relaunchArbiter: arbiter });
    runner.start();
    await vi.waitFor(() => {
      expect(launched).toHaveLength(1);
    });
    await runner.stop();

    // The fire went through, and the lease was acquired under the fired task id.
    expect(store.get(schedule.id)!.executionLedger[0]).toEqual(expect.objectContaining({
      decision: 'catch_up',
      outcome: 'running',
    }));
    expect(acquired).toEqual([
      { key: `schedule:${schedule.id}#0`, holderId: 'task-1' },
    ]);
  });

  it('skips the catch-up fire when the relaunch arbiter denies admission (#1900)', async () => {
    const schedule = store.create({
      name: 'LeaseHeldCatchup',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });

    let tryAcquireCalled = false;
    const arbiter = {
      evaluate: () => ({
        admit: false as const,
        reason: 'held' as const,
        lease: { key: catchUpKey(schedule.id), holderId: 'other-actuator', acquiredAt: '' },
      }),
      tryAcquire: () => {
        tryAcquireCalled = true;
        return { ok: true as const, lease: { key: catchUpKey(schedule.id), holderId: 'x', acquiredAt: '' }, reentrant: false };
      },
    };

    const runner = createRunner({ relaunchArbiter: arbiter });
    runner.start();
    await vi.waitFor(() => {
      expect(store.get(schedule.id)!.latestExecution?.outcome).toBe('skipped_relaunch_locked');
    });
    await runner.stop();

    // No task was launched (denied before fire), and no lease was acquired.
    expect(launched).toHaveLength(0);
    expect(tryAcquireCalled).toBe(false);
    expect(store.get(schedule.id)!.executionLedger[0]).toEqual(expect.objectContaining({
      decision: 'catch_up',
      outcome: 'skipped_relaunch_locked',
      reasonCode: 'relaunch_lease_held',
      scheduledFor: expect.any(String),
    }));
    // The held-branch message names the current holder so the ledger explains
    // which actuator won the lease.
    expect(store.get(schedule.id)!.latestExecution?.message).toContain('other-actuator');

    // Watermark advanced: the withheld slot is not re-evaluated next tick.
    await runner.tick();
    expect(launched).toHaveLength(0);
  });

  it('does not acquire the relaunch lease when the catch-up fire launches no task (#1900)', async () => {
    const schedule = store.create({
      name: 'FailedCatchupFire',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });

    let tryAcquireCalled = false;
    const arbiter = {
      evaluate: () => ({ admit: true as const }),
      tryAcquire: () => {
        tryAcquireCalled = true;
        return { ok: true as const, lease: { key: catchUpKey(schedule.id), holderId: 'x', acquiredAt: '' }, reentrant: false };
      },
    };

    // Launcher throws → fire() records dispatch_failed and returns { error }
    // with no taskId, so no lease should be acquired (nothing was launched).
    const runner = createRunner({
      relaunchArbiter: arbiter,
      launcher: async () => {
        throw new Error('boom');
      },
    });
    runner.start();
    await vi.waitFor(() => {
      expect(store.get(schedule.id)!.latestExecution?.outcome).toBe('dispatch_failed');
    });
    await runner.stop();

    expect(tryAcquireCalled).toBe(false);
  });

  it('denies catch-up with a backoff reason after the arbiter starts a cooldown window (#1900)', async () => {
    const schedule = store.create({
      name: 'BackoffCatchup',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });

    const arbiter = {
      evaluate: () => ({
        admit: false as const,
        reason: 'backoff' as const,
        retryAfterMs: 90_000,
        cooldownUntil: new Date(Date.now() + 90_000).toISOString(),
      }),
      tryAcquire: () => ({ ok: true as const, lease: { key: catchUpKey(schedule.id), holderId: 'x', acquiredAt: '' }, reentrant: false }),
    };

    const runner = createRunner({ relaunchArbiter: arbiter });
    runner.start();
    await vi.waitFor(() => {
      expect(store.get(schedule.id)!.latestExecution?.outcome).toBe('skipped_relaunch_locked');
    });
    await runner.stop();

    expect(launched).toHaveLength(0);
    expect(store.get(schedule.id)!.latestExecution?.reasonCode).toBe('relaunch_lease_held');
    expect(store.get(schedule.id)!.latestExecution?.message).toContain('backoff');
  });

  it('unwinds the launched catch-up task when a concurrent actuator wins the lease mid-fire (#1914)', async () => {
    const schedule = store.create({
      name: 'LeaseLostCatchup',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });

    // Admit before firing, then LOSE the acquire after the task launched — the
    // window another actuator can take the schedule's lease during `await fire()`.
    const arbiter = {
      evaluate: () => ({ admit: true as const }),
      tryAcquire: () => ({
        ok: false as const,
        reason: 'held' as const,
        lease: { key: catchUpKey(schedule.id), holderId: 'other-actuator', acquiredAt: '' },
      }),
    };
    const unwound: Array<{ taskId: string; detail: string }> = [];

    const runner = createRunner({
      relaunchArbiter: arbiter,
      terminateCatchUpDuplicate: (taskId, detail) => {
        unwound.push({ taskId, detail });
      },
    });
    runner.start();
    await vi.waitFor(() => {
      expect(launched).toHaveLength(1);
    });
    await runner.stop();

    // The just-launched duplicate is unwound under the fired task id, and the
    // detail names the actuator that won the lease.
    expect(unwound).toEqual([
      { taskId: 'task-1', detail: 'relaunch lease taken mid-fire by other-actuator' },
    ]);
  });

  it('unwinds the launched catch-up task when the lease enters backoff mid-fire (#1914)', async () => {
    const schedule = store.create({
      name: 'LeaseBackoffMidFireCatchup',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });

    const arbiter = {
      evaluate: () => ({ admit: true as const }),
      tryAcquire: () => ({
        ok: false as const,
        reason: 'backoff' as const,
        retryAfterMs: 90_000,
        cooldownUntil: new Date(Date.now() + 90_000).toISOString(),
      }),
    };
    const unwound: Array<{ taskId: string; detail: string }> = [];

    const runner = createRunner({
      relaunchArbiter: arbiter,
      terminateCatchUpDuplicate: (taskId, detail) => {
        unwound.push({ taskId, detail });
      },
    });
    runner.start();
    await vi.waitFor(() => {
      expect(launched).toHaveLength(1);
    });
    await runner.stop();

    expect(unwound).toHaveLength(1);
    expect(unwound[0].taskId).toBe('task-1');
    expect(unwound[0].detail).toContain('backoff mid-fire');
  });

  it('leaves the launched catch-up task running when the acquire wins (no unwind) (#1914)', async () => {
    const schedule = store.create({
      name: 'LeaseWonCatchup',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
    });
    replaceSchedule(schedule.id, {
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });

    const arbiter = {
      evaluate: () => ({ admit: true as const }),
      tryAcquire: (key: { repo: string; number: number }, holderId: string) => ({
        ok: true as const,
        lease: { key, holderId, acquiredAt: '' },
        reentrant: false,
      }),
    };
    const unwound: string[] = [];

    const runner = createRunner({
      relaunchArbiter: arbiter,
      terminateCatchUpDuplicate: (taskId) => {
        unwound.push(taskId);
      },
    });
    runner.start();
    await vi.waitFor(() => {
      expect(launched).toHaveLength(1);
    });
    await runner.stop();

    // Acquire succeeded → the fired task is the legitimate holder, never unwound.
    expect(unwound).toEqual([]);
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

describe('ScheduleRunner launch timeout + dead-man wiring (issue #1526 Phase C)', () => {
  let dir: string;
  let store: ScheduleStore;
  let service: ScheduleService;
  let validator: ScheduleValidator;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'runner-c1-test-'));
    store = new ScheduleStore(dir);
    validator = new ScheduleValidator();
    service = new ScheduleService({ store, validator });
    await mkdir(join(dir, '.kookr', 'playbooks'), { recursive: true });
    await writeFile(join(dir, '.kookr', 'playbooks', 'test.md'), `---
name: Test Playbook
parameters: []
---

Do the thing.
`);
  });

  afterEach(async () => {
    // force:true still races a hung fire writing into the dir mid-rm; retry once.
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      await new Promise((r) => setTimeout(r, 50));
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a launcher rejection shaped like LaunchTimeoutError records dispatch_failed / launch_error', async () => {
    const schedule = store.create({
      name: 'Times out',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
    });
    store.replace({
      ...store.get(schedule.id)!,
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });

    const timeoutError = Object.assign(
      new Error('Agent launch timed out after 180s (agent claude-code, task t1) — launch abandoned and task cleaned up'),
      { name: 'LaunchTimeoutError', code: 'launch_timeout' },
    );
    const runner = new ScheduleRunner({
      store,
      service,
      validator,
      launcher: async () => { throw timeoutError; },
      getActiveCount: () => 0,
      getMaxActiveTasks: () => 10,
      isTaskBlockingSchedule: () => false,
    });
    await runner.tick();

    const after = store.get(schedule.id)!;
    expect(after.latestExecution?.outcome).toBe('dispatch_failed');
    expect(after.latestExecution?.reasonCode).toBe('launch_error');
    expect(after.latestExecution?.message).toContain('timed out');
    // The receipt is terminal — nothing left 'reserved' to wedge the schedule.
    expect(after.currentExecution?.status).toBe('terminal');
  });

  it('a fire rejected by the pending-queue depth limit records dispatch_failed / pending_queue_full (issue #1526 C3)', async () => {
    const schedule = store.create({
      name: 'Queue full',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
    });
    store.replace({
      ...store.get(schedule.id)!,
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });

    const runner = new ScheduleRunner({
      store,
      service,
      validator,
      launcher: async () => {
        throw new PendingQueueFullError({
          maxActiveTasks: 10,
          active: 10,
          free: 0,
          byClass: { working: 1, finishedAwaitingAck: 8, hungSuspect: 1, launching: 0 },
          pendingQueueDepth: 24,
          oldestPendingAgeMs: 60_000,
          oldestFinishedAwaitingAckAgeMs: null,
        }, 24);
      },
      getActiveCount: () => 10,
      getMaxActiveTasks: () => 10,
      isTaskBlockingSchedule: () => false,
    });
    await runner.tick();

    const after = store.get(schedule.id)!;
    // Never silently dropped: the ledger shows the fire AND why it failed,
    // with a reason distinct from a broken launcher.
    expect(after.latestExecution?.outcome).toBe('dispatch_failed');
    expect(after.latestExecution?.reasonCode).toBe('pending_queue_full');
    expect(after.latestExecution?.message).toContain('Pending queue is full');
    expect(after.currentExecution?.status).toBe('terminal');
  });

  it('the dead-man switch is evaluated once per tick with the full schedule list', async () => {
    const check = vi.fn();
    const runner = new ScheduleRunner({
      store,
      service,
      validator,
      launcher: async () => ({ task: { id: 'unused' } as any, queued: false }),
      getActiveCount: () => 0,
      getMaxActiveTasks: () => 10,
      isTaskBlockingSchedule: () => false,
      deadMan: { check },
    });

    await runner.tick();
    await runner.tick();

    expect(check).toHaveBeenCalledTimes(2);
    expect(check).toHaveBeenCalledWith(store.list());
  });

  it('pushes the dead-man self-heal stats onto the status snapshot each tick (issue #1903)', async () => {
    const stats = vi.fn(() => ({
      attempts: 4,
      successes: 1,
      episodeAttempts: 2,
      escalated: true,
      firing: true,
    }));
    const runner = new ScheduleRunner({
      store,
      service,
      validator,
      launcher: async () => ({ task: { id: 'unused' } as any, queued: false }),
      getActiveCount: () => 0,
      getMaxActiveTasks: () => 10,
      isTaskBlockingSchedule: () => false,
      deadMan: { check: vi.fn(), stats },
    });

    await runner.tick();

    expect(stats).toHaveBeenCalled();
    // Only the observable subset is surfaced (episodeAttempts/firing are internal).
    expect(service.getStatusSnapshot().deadManSelfHeal).toEqual({
      attempts: 4,
      successes: 1,
      escalated: true,
    });
  });

  it('omits deadManSelfHeal from the snapshot until self-heal has acted (issue #1903)', async () => {
    const runner = new ScheduleRunner({
      store,
      service,
      validator,
      launcher: async () => ({ task: { id: 'unused' } as any, queued: false }),
      getActiveCount: () => 0,
      getMaxActiveTasks: () => 10,
      isTaskBlockingSchedule: () => false,
      // stats() always returns an object, but with no activity yet.
      deadMan: {
        check: vi.fn(),
        stats: () => ({ attempts: 0, successes: 0, episodeAttempts: 0, escalated: false, firing: false }),
      },
    });

    await runner.tick();

    // Absent when unconfigured / never-run, matching the field's documented contract.
    expect(service.getStatusSnapshot().deadManSelfHeal).toBeUndefined();
  });

  it('clears the snapshot self-heal state on recovery once it has surfaced (issue #1903)', async () => {
    // Regression: the push was gated on `attempts > 0 || escalated`, so the
    // recovery tick (attempts→0, escalated cleared) was dropped and the stale
    // in-episode value froze — e.g. a cap=0 escalate→recover left escalated:true
    // standing on /api/health forever. Once surfaced, every tick must re-sync.
    const stats = vi
      .fn()
      // Tick 1: escalated episode in flight (surfaces the field).
      .mockReturnValueOnce({ attempts: 0, successes: 0, episodeAttempts: 0, escalated: true, firing: true })
      // Tick 2: recovered — everything reset.
      .mockReturnValueOnce({ attempts: 0, successes: 0, episodeAttempts: 0, escalated: false, firing: false });
    const runner = new ScheduleRunner({
      store,
      service,
      validator,
      launcher: async () => ({ task: { id: 'unused' } as any, queued: false }),
      getActiveCount: () => 0,
      getMaxActiveTasks: () => 10,
      isTaskBlockingSchedule: () => false,
      deadMan: { check: vi.fn(), stats },
    });

    await runner.tick();
    expect(service.getStatusSnapshot().deadManSelfHeal).toEqual({ attempts: 0, successes: 0, escalated: true });

    await runner.tick();
    // Not frozen at escalated:true — the recovery is reflected.
    expect(service.getStatusSnapshot().deadManSelfHeal).toEqual({ attempts: 0, successes: 0, escalated: false });
  });

  it('selfHealRefire() forces a re-fire of the named schedules WITHOUT re-running the dead-man check, and is a no-op after stop() (issue #1903)', async () => {
    const waitFor = async (cond: () => boolean, ms = 1000): Promise<void> => {
      const start = Date.now();
      while (!cond() && Date.now() - start < ms) await new Promise((r) => setTimeout(r, 5));
    };

    const check = vi.fn();
    const launched: string[] = [];
    const sched = store.create({
      name: 'Starved',
      cron: '0 0 1 1 *', // far-future due time: NOT due now, so only a forced re-fire launches it
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
    });
    const runner = new ScheduleRunner({
      store,
      service,
      validator,
      launcher: async () => {
        launched.push(sched.id);
        return { task: { id: 'task-heal' } as any, queued: false };
      },
      getActiveCount: () => 0,
      getMaxActiveTasks: () => 10,
      isTaskBlockingSchedule: () => false,
      deadMan: { check },
    });

    runner.selfHealRefire([sched.id]);
    await waitFor(() => launched.length > 0); // let the deferred re-fire + its async fire settle

    expect(launched).toEqual([sched.id]); // exactly one forced re-fire
    // Crux of the #1903 correctness fix: the actuator must NOT loop back through
    // deadMan.check() (which would re-arm self-heal and burst the cap).
    expect(check).not.toHaveBeenCalled();

    await runner.stop();
    runner.selfHealRefire([sched.id]);
    await new Promise((r) => setTimeout(r, 30));
    expect(launched).toEqual([sched.id]); // stopped runner ignores the re-fire
  });

  it('selfHealRefire() skips a schedule whose cron fire is still in flight — no double launch (issue #1903)', async () => {
    let launchCount = 0;
    const sched = store.create({
      name: 'DueStarved',
      cron: '* * * * *', // due every minute
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
    });
    // Backdate so it is due now.
    store.replace({ ...store.get(sched.id)!, createdAt: new Date(Date.now() - 2 * 60_000).toISOString() });
    // Cap must sit above real fs-persist cost under full-suite load (same
    // rationale as the hung-fire wall-clock test below). A 50ms cap could
    // expire during reserveExecution, so tick() returned before the hung
    // launcher was entered and launchCount stayed 0.
    const CAP = 1_000;
    const runner = new ScheduleRunner({
      store,
      service,
      validator,
      fireTimeoutMs: CAP,
      launcher: async () => {
        launchCount += 1;
        return new Promise<never>(() => {}); // hang: the cron fire never settles → stays in flight
      },
      getActiveCount: () => 0,
      getMaxActiveTasks: () => 10,
      isTaskBlockingSchedule: () => false,
      deadMan: { check: vi.fn() },
    });

    // The cron fire launches (once) and hangs; the tick releases at the cap with
    // the fire still in `inFlightFires`.
    await runner.tick();
    expect(launchCount).toBe(1);

    // A self-heal re-fire of the same in-flight schedule must NOT launch a second
    // task — the in-flight guard skips it (coalesce alone can't: no accepted
    // taskId yet).
    runner.selfHealRefire([sched.id]);
    await new Promise((r) => setTimeout(r, 40)); // let the deferred re-fire run
    expect(launchCount).toBe(1);

    // Stop so afterEach can rm the temp dir without racing the hung fire's
    // rollup write (ENOTEMPTY under suite load).
    await runner.stop();
  });

  it('the re-queue-after-reset sweep is evaluated once per tick (issue #1896)', async () => {
    const sweep = vi.fn();
    const runner = new ScheduleRunner({
      store,
      service,
      validator,
      launcher: async () => ({ task: { id: 'unused' } as any, queued: false }),
      getActiveCount: () => 0,
      getMaxActiveTasks: () => 10,
      isTaskBlockingSchedule: () => false,
      resetScheduler: { sweep },
    });

    await runner.tick();
    await runner.tick();

    expect(sweep).toHaveBeenCalledTimes(2);
  });

  it('a throwing reset-scheduler sweep does not abort the tick — due fires still run (issue #1896)', async () => {
    const schedule = store.create({
      name: 'Test',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
    });
    store.replace({
      ...store.get(schedule.id)!,
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });

    const launched: string[] = [];
    const sweep = vi.fn(() => {
      throw new Error('sweep boom');
    });
    const runner = new ScheduleRunner({
      store,
      service,
      validator,
      launcher: async (opts) => {
        launched.push(opts.prompt);
        return { task: { id: `task-${launched.length}` } as any, queued: false };
      },
      getActiveCount: () => 0,
      getMaxActiveTasks: () => 10,
      isTaskBlockingSchedule: () => false,
      resetScheduler: { sweep },
    });

    await expect(runner.tick()).resolves.toBeUndefined();
    expect(sweep).toHaveBeenCalledTimes(1);
    // The sweep runs before the fire loop; a sweep throw must not prevent the
    // due schedule from firing.
    expect(launched).toHaveLength(1);
  });

  it('suppresses the reset sweep under the automation kill-switch (issue #1896)', async () => {
    const sweep = vi.fn();
    const runner = new ScheduleRunner({
      store,
      service,
      validator,
      launcher: async () => ({ task: { id: 'unused' } as any, queued: false }),
      getActiveCount: () => 0,
      getMaxActiveTasks: () => 10,
      isTaskBlockingSchedule: () => false,
      isAutomationEnabled: () => false,
      resetScheduler: { sweep },
    });

    await runner.tick();

    expect(sweep).not.toHaveBeenCalled();
  });

  it('keeps the wall-clock cap below the tick interval (issue #1708 invariant)', () => {
    // The whole decoupling relies on a stalled fire settling within one tick so
    // it can never bleed into the next; the source comment claims "kept below
    // TICK_INTERVAL_MS" (60_000). Lock that relationship in.
    expect(FIRE_WALL_CLOCK_CAP_MS).toBeLessThan(60_000);
  });

  it('wall-clock-bounds a hung fire() so other fires and the dead-man still run (issue #1708)', async () => {
    // Two due schedules. The FIRST schedule's launcher hangs forever; the
    // second launches normally. A single hung fire() must not block the other
    // fire OR the dead-man self-check — the whole point of #1708.
    await writeFile(join(dir, '.kookr', 'playbooks', 'hang.md'), `---
name: Hang Playbook
parameters: []
---

HANG forever.
`);
    await writeFile(join(dir, '.kookr', 'playbooks', 'ok.md'), `---
name: OK Playbook
parameters: []
---

Launch fine.
`);

    // `hung` is created first so it is first in store.list() insertion order —
    // under a (rejected) sequential-but-bounded implementation the ok fire
    // would not even start until hung's cap elapsed. The concurrency assertion
    // below relies on this ordering.
    const hung = store.create({
      name: 'Hangs',
      cron: '* * * * *',
      playbook: { path: 'hang.md', parameters: {} },
      cwd: dir,
    });
    store.replace({ ...store.get(hung.id)!, createdAt: new Date(Date.now() - 2 * 60_000).toISOString() });
    const ok = store.create({
      name: 'Fires fine',
      cron: '* * * * *',
      playbook: { path: 'ok.md', parameters: {} },
      cwd: dir,
    });
    store.replace({ ...store.get(ok.id)!, createdAt: new Date(Date.now() - 2 * 60_000).toISOString() });

    const CAP = 1_000;
    const start = Date.now();
    let hungLauncherEntered = false;
    let okLaunchedAtMs: number | undefined;
    // Capture the hung schedule's receipt status AT dead-man-check time to prove
    // the check runs BEFORE the fires reserve (decoupled), not merely once.
    let hungStatusAtCheck: string | undefined = 'sentinel';
    const deadManCheck = vi.fn((schedules: Array<ReturnType<ScheduleStore['get']>>) => {
      const h = schedules.find((s) => s?.id === hung.id);
      hungStatusAtCheck = h?.currentExecution?.status;
    });
    const runner = new ScheduleRunner({
      store,
      service,
      validator,
      // Short cap so the hung launcher is bounded in real time without slowing
      // the suite; production default is FIRE_WALL_CLOCK_CAP_MS. Comfortably
      // above the healthy fire's real fs-persist cost so only the stuck fire
      // trips it.
      fireTimeoutMs: CAP,
      launcher: async (opts) => {
        if (opts.prompt.includes('HANG')) {
          hungLauncherEntered = true;
          return new Promise<never>(() => {}); // never settles — models a stuck launcher
        }
        okLaunchedAtMs = Date.now() - start;
        return { task: { id: 'task-ok' } as any, queued: false };
      },
      getActiveCount: () => 0,
      getMaxActiveTasks: () => 10,
      isTaskBlockingSchedule: () => false,
      deadMan: { check: deadManCheck },
    });

    await runner.tick();
    const elapsed = Date.now() - start;

    // The tick was bounded — it did NOT wait on the never-settling launcher
    // (which would hang the tick forever without the cap).
    expect(elapsed).toBeLessThan(CAP * 3);
    // The stuck launcher WAS entered — the cap is what let the tick move on.
    expect(hungLauncherEntered).toBe(true);
    // Concurrency: the ok fire launched WELL BEFORE hung's cap elapsed. Under a
    // sequential-but-bounded loop (hung first) ok would not launch until ~CAP;
    // proving it launched early is what proves a hung fire does not *block* the
    // others, not merely that they eventually run.
    expect(okLaunchedAtMs).toBeDefined();
    expect(okLaunchedAtMs!).toBeLessThan(CAP / 2);
    // The dead-man self-check ran, and ran BEFORE the fires reserved (its
    // captured view of the hung schedule had no receipt yet) — i.e. decoupled
    // from, not gated behind, the fire loop.
    expect(deadManCheck).toHaveBeenCalledTimes(1);
    expect(hungStatusAtCheck).toBeUndefined();
    // The healthy schedule's fire completed and recorded an accepted execution.
    const okAfter = store.get(ok.id)!;
    expect(okAfter.currentExecution?.status).toBe('accepted');
    expect(okAfter.latestExecution?.taskId).toBe('task-ok');
    // The hung schedule is bounded: its reservation exists but never advanced
    // past 'reserved' within the tick (its fire is still hanging in the
    // background, where its own error path will eventually record the outcome).
    const hungAfter = store.get(hung.id)!;
    expect(hungAfter.currentExecution?.status).toBe('reserved');
  });

  it('does not re-fire (duplicate) a schedule whose previous fire is still in flight past the cap (issue #1708)', async () => {
    // Regression guard: bounding a fire releases the tick's `firing` gate while
    // the launcher is still stuck. Without an in-flight guard, the NEXT tick
    // would see the same occurrence as due (reserveExecution already advanced
    // lastScheduledFor) and, with disableDedup set, launch a SECOND task.
    await writeFile(join(dir, '.kookr', 'playbooks', 'stuck.md'), `---
name: Stuck Playbook
parameters: []
---

Launch and stall.
`);
    const schedule = store.create({
      name: 'Stuck',
      cron: '* * * * *',
      playbook: { path: 'stuck.md', parameters: {} },
      cwd: dir,
    });
    store.replace({ ...store.get(schedule.id)!, createdAt: new Date(Date.now() - 2 * 60_000).toISOString() });

    let launchCount = 0;
    const runner = new ScheduleRunner({
      store,
      service,
      validator,
      fireTimeoutMs: 200,
      launcher: async () => {
        launchCount += 1;
        return new Promise<never>(() => {}); // never settles — the fire stays in flight
      },
      getActiveCount: () => 0,
      getMaxActiveTasks: () => 10,
      isTaskBlockingSchedule: () => false,
    });

    // Force the schedule due again for the given tick. reserveExecution advances
    // lastScheduledFor, so without this reset a later tick might not be due and
    // the test would pass vacuously — we want due-ness so the in-flight guard is
    // provably the ONLY thing preventing a second launch.
    const forceDue = () =>
      store.replace({ ...store.get(schedule.id)!, lastScheduledFor: new Date(Date.now() - 2 * 60_000).toISOString() });

    // First tick launches once and is bounded by the cap.
    await runner.tick();
    expect(launchCount).toBe(1);

    // Subsequent ticks — schedule due each time, fire still in flight — must
    // NOT launch again.
    forceDue();
    await runner.tick();
    forceDue();
    await runner.tick();
    expect(launchCount).toBe(1);
  });

  it('feeds the resolution alerter the unresolvable schedules (issue #1661)', async () => {
    // A legacy (no-scope) schedule whose playbook does NOT exist in the project
    // tier — cwd exists, but `.kookr/playbooks/missing.md` does not. This is the
    // shape of the 68e9cb52 incident.
    const broken = store.create({
      name: 'Lucy parallel issue batch',
      cron: '* * * * *',
      playbook: { path: 'missing.md', parameters: {} },
      cwd: dir,
    });
    // A resolvable schedule (test.md exists in the project tier) — must NOT be
    // reported as unresolvable, but SHOULD appear in the resolved-ids set.
    const healthy = store.create({
      name: 'Healthy',
      cron: '* * * * *',
      playbook: { path: 'test.md', parameters: {} },
      cwd: dir,
    });

    const check = vi.fn();
    const runner = new ScheduleRunner({
      store,
      service,
      validator,
      launcher: async () => ({ task: { id: 'unused' } as any, queued: false }),
      getActiveCount: () => 0,
      getMaxActiveTasks: () => 10,
      isTaskBlockingSchedule: () => false,
      resolutionAlerter: { check },
    });

    runner.refreshPlaybookResolution();

    expect(check).toHaveBeenCalledTimes(1);
    const [reported, resolvedIds] = check.mock.calls[0];
    expect(reported).toEqual([
      expect.objectContaining({
        id: broken.id,
        name: 'Lucy parallel issue batch',
        playbookPath: 'missing.md',
        scope: 'project',
        legacy: true,
      }),
    ]);
    // The healthy schedule is not in the unresolvable report...
    expect(reported).toHaveLength(1);
    // ...but IS in the genuinely-resolved set that gates recovery alerts.
    expect(resolvedIds).toEqual([healthy.id]);
  });
});
