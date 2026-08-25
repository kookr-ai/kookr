import { afterEach, describe, expect, test, vi } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('./dirty-worktree-completion-finding.js', () => ({
  surfaceDirtyWorktreeOnHeadlessCompletion: vi.fn(async () => false),
}));
import { surfaceDirtyWorktreeOnHeadlessCompletion } from './dirty-worktree-completion-finding.js';
const mockSurfaceDirty = vi.mocked(surfaceDirtyWorktreeOnHeadlessCompletion);
import {
  clearAllTimers,
  findFirstActiveSession,
  maybeReapHungTask,
  runBudgetCheck,
  runProgressBudgetBurnDiagnosticSample,
  runReapWarningMaintenance,
  REAP_WARNING_STUCK_CLEAR_MS,
  startLifecycleTimers,
  TOKEN_SCAN_INTERVAL_MS,
  WATCHDOG_INTERVAL_MS,
  SNOOZE_EXPIRY_INTERVAL_MS,
  RELAY_ORPHAN_SWEEP_STARTUP_DELAY_MS,
  HOST_STALE_DTACH_REAP_STARTUP_DELAY_MS,
  HOURLY_SAFETY_NET_STARTUP_DELAY_MS,
  type TimerDeps,
} from './lifecycle-timers.js';
import { ReapWarningCoordinator } from '../core/reap-warning-coordinator.js';
import {
  AUTO_CLOSE_SWEEP_MIN_INTERVAL_MS,
  autoCloseStaleCompletionReadyTasks,
  createAutoCloseSweepThrottle,
} from './completion-ready-sweep.js';
import {
  resolveMaintenancePruneIntervalHours,
  runScheduledMaintenancePrune,
} from './maintenance-prune-schedule.js';
import { restoreExpiredSnoozes } from './snooze-restore.js';
import { runPersistenceSaveTick } from './persistence-save-tick.js';
import { TimerHealthTracker } from '../core/timer-health.js';
import type { MaintenancePruneResult } from '../core/maintenance-prune.js';
import { BudgetChecker } from '../core/budget-checker.js';
import type { Task } from '../core/tasks.js';
import { makePausedByFailureSnapshot } from '../test-utils/paused-schedules-fixture.js';
import { TaskStore } from '../core/tasks.js';
import { AttentionQueue } from '../core/attention-queue.js';
import { Watchdog } from '../core/watchdog.js';
import type { Anomaly } from '../core/types.js';
import type { ProgressBudgetBurnDiagnostics } from '../core/progress-budget-burn-diagnostics.js';
import { PersistenceHealthTracker } from '../core/persistence-health.js';
import { aSession, aTask } from '../core/__fixtures__/task-builders.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function makeAnomaly(agentId: string): Anomaly {
  return {
    agentId,
    type: 'needs_input',
    severity: 'info',
    explanation: 'Agent needs input',
    detectedAt: new Date('2026-04-15T00:00:00Z'),
  };
}

function timerTask(overrides: Partial<Task> = {}): Task {
  const createdAt = new Date('2026-04-15T00:00:00Z');
  return aTask({
    prompt: 'do something',
    cwd: '/tmp',
    createdAt,
    updatedAt: createdAt,
    sessions: [aSession({ tmuxSession: 'agent-1', cwd: '/tmp', createdAt, lastStatus: 'running' })],
    ...overrides,
  });
}

describe('runBudgetCheck', () => {
  test('enqueues a budget_exceeded anomaly on the first active session', () => {
    const checker = new BudgetChecker(5);
    const enqueue = vi.fn();
    const task = timerTask();

    const fired = runBudgetCheck(task, 5, checker, enqueue);

    expect(fired).toBe(true);
    expect(enqueue).toHaveBeenCalledTimes(1);
    const [agentId, anomaly] = enqueue.mock.calls[0];
    expect(agentId).toBe('agent-1');
    expect(anomaly.type).toBe('budget_exceeded');
    expect(anomaly.severity).toBe('warning');
  });

  test('does nothing when cost is below threshold', () => {
    const checker = new BudgetChecker(5);
    const enqueue = vi.fn();
    expect(runBudgetCheck(timerTask(), 4.99, checker, enqueue)).toBe(false);
    expect(enqueue).not.toHaveBeenCalled();
  });

  test('does nothing when budget checker is undefined', () => {
    const enqueue = vi.fn();
    expect(runBudgetCheck(timerTask(), 100, undefined, enqueue)).toBe(false);
    expect(enqueue).not.toHaveBeenCalled();
  });

  test('does nothing when threshold is disabled (<= 0)', () => {
    const checker = new BudgetChecker(0);
    const enqueue = vi.fn();
    expect(runBudgetCheck(timerTask(), 100, checker, enqueue)).toBe(false);
    expect(enqueue).not.toHaveBeenCalled();
  });

  test('prefers the task project budget threshold over the global threshold', () => {
    const checker = new BudgetChecker(25);
    const enqueue = vi.fn();
    const task = timerTask({ projectId: 'github.com/org/repo' });
    const projectConfigStore = {
      getConfig: vi.fn(() => ({ project: task.projectId!, budgetWarnUsd: 5 })),
    };

    expect(runBudgetCheck(task, 5, checker, enqueue, projectConfigStore)).toBe(true);
    expect(enqueue.mock.calls[0][1].explanation).toContain('threshold ($5.00)');
  });

  test('project threshold 0 disables alerts even when the global threshold is enabled', () => {
    const checker = new BudgetChecker(5);
    const enqueue = vi.fn();
    const task = timerTask({ projectId: 'github.com/org/repo' });
    const projectConfigStore = {
      getConfig: vi.fn(() => ({ project: task.projectId!, budgetWarnUsd: 0 })),
    };

    expect(runBudgetCheck(task, 100, checker, enqueue, projectConfigStore)).toBe(false);
    expect(enqueue).not.toHaveBeenCalled();
  });

  test('project threshold works when the global threshold is disabled', () => {
    const checker = new BudgetChecker(0);
    const enqueue = vi.fn();
    const task = timerTask({ projectId: 'github.com/org/repo' });
    const projectConfigStore = {
      getConfig: vi.fn(() => ({ project: task.projectId!, budgetWarnUsd: 5 })),
    };

    expect(runBudgetCheck(task, 5, checker, enqueue, projectConfigStore)).toBe(true);
  });

  test('does nothing when all sessions are completed or aborted', () => {
    const checker = new BudgetChecker(5);
    const enqueue = vi.fn();
    const task = timerTask({
      sessions: [
        { tmuxSession: 'agent-1', agentType: 'claude-code', cwd: '/tmp', createdAt: new Date(), lastStatus: 'completed' },
        { tmuxSession: 'agent-2', agentType: 'claude-code', cwd: '/tmp', createdAt: new Date(), lastStatus: 'aborted' },
      ],
    });
    expect(runBudgetCheck(task, 100, checker, enqueue)).toBe(false);
    expect(enqueue).not.toHaveBeenCalled();
  });

  test('skips completed sessions and targets the first running one', () => {
    const checker = new BudgetChecker(5);
    const enqueue = vi.fn();
    const task = timerTask({
      sessions: [
        { tmuxSession: 'agent-dead', agentType: 'claude-code', cwd: '/tmp', createdAt: new Date(), lastStatus: 'completed' },
        { tmuxSession: 'agent-live', agentType: 'claude-code', cwd: '/tmp', createdAt: new Date(), lastStatus: 'running' },
      ],
    });
    expect(runBudgetCheck(task, 5, checker, enqueue)).toBe(true);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][0]).toBe('agent-live');
  });

  test('uses the shared active-session selection helper', () => {
    const task = timerTask({
      sessions: [
        { tmuxSession: 'agent-dead', agentType: 'claude-code', cwd: '/tmp', createdAt: new Date(), lastStatus: 'completed' },
        { tmuxSession: 'agent-live', agentType: 'claude-code', cwd: '/tmp', createdAt: new Date(), lastStatus: 'running' },
      ],
    });

    expect(findFirstActiveSession(task)?.tmuxSession).toBe('agent-live');
  });

  test('samples progress-aware budget diagnostics with events from the selected live session', () => {
    const task = timerTask({
      sessions: [
        { tmuxSession: 'agent-dead', agentType: 'claude-code', cwd: '/tmp', createdAt: new Date(), lastStatus: 'completed' },
        { tmuxSession: 'agent-live', agentType: 'claude-code', cwd: '/tmp', createdAt: new Date(), lastStatus: 'running' },
      ],
    });
    const diagnostics = {
      sample: vi.fn(() => null),
    } satisfies Pick<ProgressBudgetBurnDiagnostics, 'sample'>;
    const getAgentEvents = vi.fn(() => [
      { type: 'permission_request' as const, sessionId: 'agent-live', toolName: 'Bash' },
    ]);

    expect(runProgressBudgetBurnDiagnosticSample(
      task,
      { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, costUsd: 0.25 },
      diagnostics,
      getAgentEvents,
    )).toBe(false);

    expect(getAgentEvents).toHaveBeenCalledWith('agent-live');
    expect(diagnostics.sample).toHaveBeenCalledWith(expect.objectContaining({
      task,
      agentId: 'agent-live',
      events: [{ type: 'permission_request', sessionId: 'agent-live', toolName: 'Bash' }],
    }));
  });

  test('does not re-fire on the next tick after warning already enqueued', () => {
    const checker = new BudgetChecker(5);
    const enqueue = vi.fn();
    const task = timerTask();

    expect(runBudgetCheck(task, 5, checker, enqueue)).toBe(true);
    // Cost climbs but stays below 2x threshold — no new anomaly.
    expect(runBudgetCheck(task, 7, checker, enqueue)).toBe(false);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  test('fires critical on second crossing at 2x threshold', () => {
    const checker = new BudgetChecker(5);
    const enqueue = vi.fn();
    const task = timerTask();

    expect(runBudgetCheck(task, 6, checker, enqueue)).toBe(true);
    expect(enqueue.mock.calls[0][1].severity).toBe('warning');

    expect(runBudgetCheck(task, 11, checker, enqueue)).toBe(true);
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue.mock.calls[1][1].severity).toBe('critical');
  });
});

describe('autoCloseStaleCompletionReadyTasks', () => {
  function startTask(taskStore: TaskStore, id: string): void {
    taskStore.addSession(id, {
      tmuxSession: `kookr-${id}`,
      agentType: 'claude-code',
      cwd: '/tmp',
      createdAt: new Date('2026-06-21T00:00:00.000Z'),
    });
  }

  function lifecycleDeps(taskStore: TaskStore, issueClaimRegistry?: { safeReleaseAllFor: ReturnType<typeof vi.fn> }) {
    return {
      adapter: { stop: vi.fn(async () => undefined) },
      monitor: { unregisterAgent: vi.fn(), getAgentEvents: vi.fn(() => []) },
      taskStore,
      queue: new AttentionQueue(),
      hookWatcher: { stop: vi.fn() },
      watchdog: { unregisterAgent: vi.fn() },
      ...(issueClaimRegistry ? { issueClaimRegistry } : {}),
    };
  }

  test('completes opted-in completion-ready tasks after the one-hour threshold', async () => {
    const taskStore = new TaskStore();
    const eligible = taskStore.createTask({ prompt: 'Eligible', cwd: '/tmp', autoCloseOnSignal: true });
    const fresh = taskStore.createTask({ prompt: 'Fresh', cwd: '/tmp', autoCloseOnSignal: true });
    const manual = taskStore.createTask({ prompt: 'Manual', cwd: '/tmp' });
    for (const task of [eligible, fresh, manual]) startTask(taskStore, task.id);

    taskStore.setPendingSignal(eligible.id, { kind: 'completion_ready', raisedAt: '2026-06-21T00:00:00.000Z' });
    taskStore.setPendingSignal(fresh.id, { kind: 'completion_ready', raisedAt: '2026-06-21T00:30:00.000Z' });
    taskStore.setPendingSignal(manual.id, { kind: 'completion_ready', raisedAt: '2026-06-21T00:00:00.000Z' });

    const result = await autoCloseStaleCompletionReadyTasks({
      taskStore,
      lifecycleDeps: lifecycleDeps(taskStore),
    }, {
      now: new Date('2026-06-21T01:00:00.000Z'),
    });

    expect(result).toEqual({ closedTaskIds: [eligible.id] });
    expect(taskStore.getTask(eligible.id)?.status).toBe('completed');
    expect(taskStore.getPendingSignal(eligible.id)).toBeUndefined();
    expect(taskStore.getTask(fresh.id)?.status).toBe('inProgress');
    expect(taskStore.getTask(manual.id)?.status).toBe('inProgress');
  });

  test('honors a configured thresholdMs (30-minute default delay)', async () => {
    const taskStore = new TaskStore();
    const eligible = taskStore.createTask({ prompt: 'Eligible', cwd: '/tmp', autoCloseOnSignal: true });
    const tooFresh = taskStore.createTask({ prompt: 'Too fresh', cwd: '/tmp', autoCloseOnSignal: true });
    for (const task of [eligible, tooFresh]) startTask(taskStore, task.id);

    // Signal raised exactly 30 minutes before `now` → due at the 30m threshold.
    taskStore.setPendingSignal(eligible.id, { kind: 'completion_ready', raisedAt: '2026-06-21T00:00:00.000Z' });
    // Raised 20 minutes before `now` → still within the grace window.
    taskStore.setPendingSignal(tooFresh.id, { kind: 'completion_ready', raisedAt: '2026-06-21T00:10:00.000Z' });

    const result = await autoCloseStaleCompletionReadyTasks({
      taskStore,
      lifecycleDeps: lifecycleDeps(taskStore),
    }, {
      now: new Date('2026-06-21T00:30:00.000Z'),
      thresholdMs: 30 * 60 * 1000,
    });

    expect(result).toEqual({ closedTaskIds: [eligible.id] });
    expect(taskStore.getTask(eligible.id)?.status).toBe('completed');
    expect(taskStore.getTask(tooFresh.id)?.status).toBe('inProgress');
  });

  test('leaves active Ralph loops for the Ralph lifecycle path', async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask({ prompt: 'Loop', cwd: '/tmp', autoCloseOnSignal: true });
    startTask(taskStore, task.id);
    taskStore.getTaskForMutation(task.id)!.ralphLoop = {
      prompt: 'Loop',
      iterationCap: 3,
      currentIteration: 1,
      status: 'running',
      lastIterationStartedAt: Date.parse('2026-06-21T00:00:00.000Z'),
      cumulativeIterations: 1,
    };
    taskStore.setPendingSignal(task.id, { kind: 'completion_ready', raisedAt: '2026-06-21T00:00:00.000Z' });

    const result = await autoCloseStaleCompletionReadyTasks({
      taskStore,
      lifecycleDeps: lifecycleDeps(taskStore),
    }, {
      now: new Date('2026-06-21T02:00:00.000Z'),
    });

    expect(result.closedTaskIds).toEqual([]);
    expect(taskStore.getTask(task.id)?.status).toBe('inProgress');
    expect(taskStore.getPendingSignal(task.id)?.kind).toBe('completion_ready');
  });

  test('does not auto-close a later run from a pre-start completion-ready signal', async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask({ prompt: 'Manual review', cwd: '/tmp', autoCloseOnSignal: true });
    taskStore.setPendingSignal(task.id, { kind: 'completion_ready', raisedAt: '2026-06-21T00:00:00.000Z' });
    taskStore.addSession(task.id, {
      tmuxSession: `kookr-${task.id}`,
      agentType: 'claude-code',
      cwd: '/tmp',
      createdAt: new Date('2026-06-21T00:30:00.000Z'),
    });

    const result = await autoCloseStaleCompletionReadyTasks({
      taskStore,
      lifecycleDeps: lifecycleDeps(taskStore),
    }, {
      now: new Date('2026-06-21T02:00:00.000Z'),
    });

    expect(result.closedTaskIds).toEqual([]);
    expect(taskStore.getTask(task.id)?.status).toBe('inProgress');
    expect(taskStore.getPendingSignal(task.id)?.kind).toBe('completion_ready');
  });

  test('releases issue claims through the normal completion lifecycle', async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask({ prompt: 'Eligible', cwd: '/tmp', autoCloseOnSignal: true });
    startTask(taskStore, task.id);
    taskStore.setPendingSignal(task.id, { kind: 'completion_ready', raisedAt: '2026-06-21T00:00:00.000Z' });
    const safeReleaseAllFor = vi.fn(() => []);

    const result = await autoCloseStaleCompletionReadyTasks({
      taskStore,
      lifecycleDeps: lifecycleDeps(taskStore, { safeReleaseAllFor }),
    }, {
      now: new Date('2026-06-21T01:00:00.000Z'),
    });

    expect(result.closedTaskIds).toEqual([task.id]);
    expect(taskStore.getTask(task.id)?.status).toBe('completed');
    expect(safeReleaseAllFor).toHaveBeenCalledWith(task.id, 'released');
  });

  test('surfaces a dirty-worktree finding before completing on the headless path (issue #1580)', async () => {
    mockSurfaceDirty.mockClear();
    mockSurfaceDirty.mockResolvedValue(true);
    const taskStore = new TaskStore();
    const task = taskStore.createTask({ prompt: 'Dirty', cwd: '/tmp', autoCloseOnSignal: true });
    startTask(taskStore, task.id);
    taskStore.setPendingSignal(task.id, { kind: 'completion_ready', raisedAt: '2026-06-21T00:00:00.000Z' });
    const broadcastToAll = vi.fn();

    const result = await autoCloseStaleCompletionReadyTasks(
      { taskStore, lifecycleDeps: lifecycleDeps(taskStore), broadcastToAll },
      { now: new Date('2026-06-21T01:00:00.000Z') },
    );

    // The finding is surfaced for the auto-closed task, and completion still proceeds.
    expect(mockSurfaceDirty).toHaveBeenCalledTimes(1);
    expect(mockSurfaceDirty.mock.calls[0]![0].id).toBe(task.id);
    expect(mockSurfaceDirty.mock.calls[0]![1]).toMatchObject({ taskStore, broadcastToAll });
    expect(result.closedTaskIds).toEqual([task.id]);
    expect(taskStore.getTask(task.id)?.status).toBe('completed');
  });

  describe('TTL escalation and stagger (issue #1526 Phase A)', () => {
    async function readAuditRows(auditLogPath: string): Promise<Record<string, unknown>[]> {
      try {
        const content = await readFile(auditLogPath, 'utf-8');
        return content.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw err;
      }
    }

    test('drains at most 2 tasks per call, oldest signal first, across successive ticks', async () => {
      const taskStore = new TaskStore();
      const tasks = Array.from({ length: 11 }, (_, i) => {
        const task = taskStore.createTask({ prompt: `Task ${i}`, cwd: '/tmp', deliveryAuthorization: 'ask-first' });
        // Session must start before the signal is raised, or the signal reads
        // as a pre-start manual-review breadcrumb (see listStaleCompletionReadyTasks).
        taskStore.addSession(task.id, {
          tmuxSession: `kookr-${task.id}`,
          agentType: 'claude-code',
          cwd: '/tmp',
          createdAt: new Date('2026-06-19T00:00:00.000Z'),
        });
        // Stagger raisedAt so drain order (oldest-first) is deterministic and
        // distinguishable — all are well past the 2h TTL relative to `now`.
        taskStore.setPendingSignal(task.id, {
          kind: 'completion_ready',
          raisedAt: new Date(Date.parse('2026-06-20T00:00:00.000Z') + i * 1000).toISOString(),
        });
        return task;
      });

      const now = new Date('2026-06-21T00:00:00.000Z');
      const closedInOrder: string[] = [];
      for (let tick = 0; tick < 6; tick++) {
        const result = await autoCloseStaleCompletionReadyTasks(
          { taskStore, lifecycleDeps: lifecycleDeps(taskStore) },
          { now, ttlMs: 2 * 60 * 60 * 1000 },
        );
        expect(result.closedTaskIds.length).toBeLessThanOrEqual(2);
        closedInOrder.push(...result.closedTaskIds);
      }

      expect(closedInOrder).toEqual(tasks.map((t) => t.id));
      for (const task of tasks) {
        expect(taskStore.getTask(task.id)?.status).toBe('completed');
      }
      // A 7th tick finds nothing left to drain.
      const finalResult = await autoCloseStaleCompletionReadyTasks(
        { taskStore, lifecycleDeps: lifecycleDeps(taskStore) },
        { now, ttlMs: 2 * 60 * 60 * 1000 },
      );
      expect(finalResult.closedTaskIds).toEqual([]);
    });

    test('throttles sweep batches to at most one per AUTO_CLOSE_SWEEP_MIN_INTERVAL_MS', async () => {
      // The liveness tick runs every 5s in production — without this
      // throttle, "max 2 per batch" alone would still drain 11 tasks in
      // ~30s. This proves batches are spaced at least 60s apart regardless
      // of how often the caller invokes the sweep.
      const taskStore = new TaskStore();
      const tasks = Array.from({ length: 4 }, (_, i) => {
        const task = taskStore.createTask({ prompt: `Task ${i}`, cwd: '/tmp', deliveryAuthorization: 'ask-first' });
        taskStore.addSession(task.id, {
          tmuxSession: `kookr-${task.id}`,
          agentType: 'claude-code',
          cwd: '/tmp',
          createdAt: new Date('2026-06-19T00:00:00.000Z'),
        });
        taskStore.setPendingSignal(task.id, {
          kind: 'completion_ready',
          raisedAt: new Date(Date.parse('2026-06-20T00:00:00.000Z') + i * 1000).toISOString(),
        });
        return task;
      });

      const t0 = Date.parse('2026-06-21T00:00:00.000Z');
      const throttle = createAutoCloseSweepThrottle();
      const opts = (now: Date) => ({ now, ttlMs: 2 * 60 * 60 * 1000, throttle });

      // Invocation 1 (t=0): runs, closes the first batch of 2.
      const result1 = await autoCloseStaleCompletionReadyTasks(
        { taskStore, lifecycleDeps: lifecycleDeps(taskStore) },
        opts(new Date(t0)),
      );
      expect(result1.closedTaskIds).toEqual([tasks[0].id, tasks[1].id]);

      // Invocation 2 (t=+5s): throttled — closes nothing, even though 2
      // more eligible tasks remain.
      const result2 = await autoCloseStaleCompletionReadyTasks(
        { taskStore, lifecycleDeps: lifecycleDeps(taskStore) },
        opts(new Date(t0 + 5_000)),
      );
      expect(result2.closedTaskIds).toEqual([]);
      expect(taskStore.getTask(tasks[2].id)?.status).toBe('inProgress');

      // Invocation 3 (t=+65s, i.e. > AUTO_CLOSE_SWEEP_MIN_INTERVAL_MS after
      // invocation 1): throttle window has elapsed — closes the next batch.
      const result3 = await autoCloseStaleCompletionReadyTasks(
        { taskStore, lifecycleDeps: lifecycleDeps(taskStore) },
        opts(new Date(t0 + AUTO_CLOSE_SWEEP_MIN_INTERVAL_MS + 5_000)),
      );
      expect(result3.closedTaskIds).toEqual([tasks[2].id, tasks[3].id]);
    });

    test('a TTL-escalated close writes an audit row and broadcasts an alert', async () => {
      const auditLogPath = join(await mkdtemp(join(tmpdir(), 'kookr-audit-')), 'audit.jsonl');
      const taskStore = new TaskStore();
      const task = taskStore.createTask({ prompt: 'Stuck ask-first', cwd: '/tmp', deliveryAuthorization: 'ask-first' });
      startTask(taskStore, task.id); // session createdAt: 2026-06-21T00:00:00.000Z
      taskStore.setPendingSignal(task.id, { kind: 'completion_ready', raisedAt: '2026-06-21T00:00:00.000Z' });
      const broadcastToAll = vi.fn();

      const result = await autoCloseStaleCompletionReadyTasks(
        { taskStore, lifecycleDeps: lifecycleDeps(taskStore), auditLogPath, broadcastToAll },
        { now: new Date('2026-06-21T02:00:00.000Z'), ttlMs: 2 * 60 * 60 * 1000 },
      );

      expect(result.closedTaskIds).toEqual([task.id]);
      expect(taskStore.getTask(task.id)?.status).toBe('completed');

      const rows = await readAuditRows(auditLogPath);
      expect(rows).toEqual([{
        type: 'task.completionReadyTtlEscalation',
        timestamp: expect.any(String),
        actor: 'system:completion-ready-ttl',
        taskId: task.id,
        signalRaisedAt: '2026-06-21T00:00:00.000Z',
        ageMs: 2 * 60 * 60 * 1000,
      }]);

      expect(broadcastToAll).toHaveBeenCalledTimes(1);
      expect(broadcastToAll).toHaveBeenCalledWith({
        type: 'alert',
        agentId: `kookr-${task.id}`, // per startTask() above
        // Named from birth (issue #1554): the alert now carries the task's
        // deterministic name instead of the generic 'Task' fallback.
        summary: 'Auto-closed after TTL: Stuck ask-first',
        details: 'completion_ready pending 120m with no manual review — closed automatically to free the slot.',
        severity: 'info',
      });
    });

    test('an opted-in (autoCloseOnSignal) close does NOT write an audit row or broadcast', async () => {
      const auditLogPath = join(await mkdtemp(join(tmpdir(), 'kookr-audit-')), 'audit.jsonl');
      const taskStore = new TaskStore();
      const task = taskStore.createTask({ prompt: 'Opted-in', cwd: '/tmp', autoCloseOnSignal: true });
      startTask(taskStore, task.id);
      taskStore.setPendingSignal(task.id, { kind: 'completion_ready', raisedAt: '2026-06-21T00:00:00.000Z' });
      const broadcastToAll = vi.fn();

      const result = await autoCloseStaleCompletionReadyTasks(
        { taskStore, lifecycleDeps: lifecycleDeps(taskStore), auditLogPath, broadcastToAll },
        { now: new Date('2026-06-21T01:00:00.000Z'), ttlMs: 2 * 60 * 60 * 1000 },
      );

      expect(result.closedTaskIds).toEqual([task.id]);
      expect(await readAuditRows(auditLogPath)).toEqual([]);
      expect(broadcastToAll).not.toHaveBeenCalled();
    });
  });
});

describe('maybeReapHungTask (issue #1526 Phase A)', () => {
  const REAP_THRESHOLD_MS = 3 * 60 * 60 * 1000;
  // Fixed reference clock (issue #1526 Phase A review fix): maybeReapHungTask
  // takes an injectable `now`, so every test below uses this instant instead
  // of the real wall clock — no `+60_000`/`-60_000` fudge buffer needed to
  // survive test execution latency, and exact threshold boundaries are
  // actually testable.
  const NOW = Date.parse('2026-06-21T00:00:00.000Z');
  const now = () => new Date(NOW);

  function makeHungTask(taskStore: TaskStore, agentId: string): Task {
    const task = taskStore.createTask({ prompt: 'Hung agent', cwd: '/tmp' });
    taskStore.addSession(task.id, {
      tmuxSession: agentId,
      agentType: 'claude-code',
      cwd: '/tmp',
      createdAt: new Date(NOW - 2 * REAP_THRESHOLD_MS),
    });
    return taskStore.getTask(task.id)!;
  }

  /** Registers `agentId` with all three liveness channels last active `ageMs` before NOW. */
  function makeSilentWatchdog(agentId: string, ageMs: number): Watchdog {
    const watchdog = new Watchdog();
    const lastActivityAt = NOW - ageMs;
    watchdog.registerAgent(agentId, lastActivityAt, lastActivityAt);
    // registerAgent seeds lastPaneChangeAt = registeredAt, which is what we want here.
    return watchdog;
  }

  function timerDeps(overrides: Partial<TimerDeps> = {}): TimerDeps {
    return {
      monitor: {} as any,
      taskStore: {} as any,
      queue: {} as any,
      adapter: {} as any,
      adapterRegistry: { get: vi.fn() } as any,
      tokenTracker: {} as any,
      watchdog: new Watchdog(),
      hookWatcher: {} as any,
      terminalBackend: {} as any,
      hooksDir: '/tmp/hooks',
      tasksFile: '/tmp/tasks.json',
      serverCwd: '/tmp/repo',
      saveIntervalMs: 60_000,
      livenessIntervalMs: 60_000,
      broadcastToAll: vi.fn(),
      ...overrides,
    };
  }

  function lifecycleDeps(taskStore: TaskStore) {
    return {
      adapter: { stop: vi.fn(async () => undefined) },
      monitor: { unregisterAgent: vi.fn(), getAgentEvents: vi.fn(() => []) },
      taskStore,
      queue: new AttentionQueue(),
      hookWatcher: { stop: vi.fn() },
      watchdog: { unregisterAgent: vi.fn() },
    };
  }

  test('reaps a task silent past the threshold and reports true', async () => {
    const taskStore = new TaskStore();
    const agentId = 'kookr-hung-1';
    const task = makeHungTask(taskStore, agentId);
    const watchdog = makeSilentWatchdog(agentId, REAP_THRESHOLD_MS + 1);

    const reaped = await maybeReapHungTask(
      agentId,
      'frozen pane',
      timerDeps({ watchdog, getHungTaskReapMs: () => REAP_THRESHOLD_MS }),
      taskStore,
      lifecycleDeps(taskStore),
      now,
    );

    expect(reaped).toBe(true);
    expect(taskStore.getTask(task.id)?.status).toBe('terminated');
  });

  test('does not reap a task not yet silent long enough', async () => {
    const taskStore = new TaskStore();
    const agentId = 'kookr-fresh-1';
    const task = makeHungTask(taskStore, agentId);
    const watchdog = makeSilentWatchdog(agentId, REAP_THRESHOLD_MS - 1);

    const reaped = await maybeReapHungTask(
      agentId,
      'pane',
      timerDeps({ watchdog, getHungTaskReapMs: () => REAP_THRESHOLD_MS }),
      taskStore,
      lifecycleDeps(taskStore),
      now,
    );

    expect(reaped).toBe(false);
    expect(taskStore.getTask(task.id)?.status).toBe('inProgress');
  });

  test('never reaps a task with a pending signal, even if fully silent', async () => {
    const taskStore = new TaskStore();
    const agentId = 'kookr-signaled-1';
    const task = makeHungTask(taskStore, agentId);
    taskStore.setPendingSignal(task.id, { kind: 'completion_ready', raisedAt: now().toISOString() });
    const watchdog = makeSilentWatchdog(agentId, REAP_THRESHOLD_MS + 1);

    const reaped = await maybeReapHungTask(
      agentId,
      'pane',
      timerDeps({ watchdog, getHungTaskReapMs: () => REAP_THRESHOLD_MS }),
      taskStore,
      lifecycleDeps(taskStore),
      now,
    );

    expect(reaped).toBe(false);
    expect(taskStore.getTask(task.id)?.status).toBe('inProgress');
  });

  test('respects the disable config flag', async () => {
    const taskStore = new TaskStore();
    const agentId = 'kookr-disabled-1';
    const task = makeHungTask(taskStore, agentId);
    const watchdog = makeSilentWatchdog(agentId, REAP_THRESHOLD_MS + 1);

    const reaped = await maybeReapHungTask(
      agentId,
      'pane',
      timerDeps({ watchdog, getHungTaskReapMs: () => REAP_THRESHOLD_MS, getHungTaskReapEnabled: () => false }),
      taskStore,
      lifecycleDeps(taskStore),
      now,
    );

    expect(reaped).toBe(false);
    expect(taskStore.getTask(task.id)?.status).toBe('inProgress');
  });

  // Issue #1896: provider_paused → recordProviderPause hand-off.
  const PAUSE_PANE = 'Error: Credit balance is too low';

  test('holds a provider_paused task before reset — records the pause, does not reap', async () => {
    const taskStore = new TaskStore();
    const agentId = 'kookr-paused-hold';
    const task = makeHungTask(taskStore, agentId);
    const watchdog = makeSilentWatchdog(agentId, REAP_THRESHOLD_MS + 1);
    const recordProviderPause = vi.fn(() => ({ holdForResume: true }));

    const reaped = await maybeReapHungTask(
      agentId,
      PAUSE_PANE,
      timerDeps({ watchdog, getHungTaskReapMs: () => REAP_THRESHOLD_MS, recordProviderPause }),
      taskStore,
      lifecycleDeps(taskStore),
      now,
    );

    expect(reaped).toBe(false);
    expect(taskStore.getTask(task.id)?.status).toBe('inProgress');
    expect(recordProviderPause).toHaveBeenCalledTimes(1);
    expect(recordProviderPause.mock.calls[0][0].id).toBe(task.id);
  });

  test('reaps a provider_paused task once its reset has elapsed (frees slot + lease)', async () => {
    const taskStore = new TaskStore();
    const agentId = 'kookr-paused-reap';
    const task = makeHungTask(taskStore, agentId);
    const watchdog = makeSilentWatchdog(agentId, REAP_THRESHOLD_MS + 1);
    const recordProviderPause = vi.fn(() => ({ holdForResume: false }));

    const reaped = await maybeReapHungTask(
      agentId,
      PAUSE_PANE,
      timerDeps({ watchdog, getHungTaskReapMs: () => REAP_THRESHOLD_MS, recordProviderPause }),
      taskStore,
      lifecycleDeps(taskStore),
      now,
    );

    expect(reaped).toBe(true);
    expect(taskStore.getTask(task.id)?.status).toBe('terminated');
    expect(recordProviderPause).toHaveBeenCalledTimes(1);
  });

  test('a throwing recordProviderPause never turns a hold into a reap (safety)', async () => {
    const taskStore = new TaskStore();
    const agentId = 'kookr-paused-throw';
    const task = makeHungTask(taskStore, agentId);
    const watchdog = makeSilentWatchdog(agentId, REAP_THRESHOLD_MS + 1);
    const recordProviderPause = vi.fn(() => {
      throw new Error('hook boom');
    });

    const reaped = await maybeReapHungTask(
      agentId,
      PAUSE_PANE,
      timerDeps({ watchdog, getHungTaskReapMs: () => REAP_THRESHOLD_MS, recordProviderPause }),
      taskStore,
      lifecycleDeps(taskStore),
      now,
    );

    expect(reaped).toBe(false);
    expect(taskStore.getTask(task.id)?.status).toBe('inProgress');
  });

  test('with no recordProviderPause wired, a provider_paused task is still never reaped (pre-#1896 / #1667)', async () => {
    const taskStore = new TaskStore();
    const agentId = 'kookr-paused-unwired';
    const task = makeHungTask(taskStore, agentId);
    const watchdog = makeSilentWatchdog(agentId, REAP_THRESHOLD_MS + 1);

    const reaped = await maybeReapHungTask(
      agentId,
      PAUSE_PANE,
      timerDeps({ watchdog, getHungTaskReapMs: () => REAP_THRESHOLD_MS }),
      taskStore,
      lifecycleDeps(taskStore),
      now,
    );

    expect(reaped).toBe(false);
    expect(taskStore.getTask(task.id)?.status).toBe('inProgress');
  });

  test('triggers pending-task promotion after reaping', async () => {
    const taskStore = new TaskStore();
    const agentId = 'kookr-hung-2';
    makeHungTask(taskStore, agentId);
    const watchdog = makeSilentWatchdog(agentId, REAP_THRESHOLD_MS + 1);
    const pending = taskStore.createTask({ prompt: 'Waiting in queue', cwd: '/tmp' });
    taskStore.pendTask(pending.id);
    const launch = vi.fn(async () => undefined);

    await maybeReapHungTask(
      agentId,
      'pane',
      timerDeps({
        watchdog,
        getHungTaskReapMs: () => REAP_THRESHOLD_MS,
        getMaxActiveTasks: () => 1,
        adapterRegistry: { get: vi.fn(() => ({ launch })) } as any,
        agentLifecycleDeps: {
          monitor: { registerAgent: vi.fn(), getSnapshot: vi.fn(() => []) } as any,
          watchdog: { registerAgent: vi.fn() } as any,
          hookWatcher: { isWatching: vi.fn(() => false), watch: vi.fn() } as any,
          githubScanner: { isActive: vi.fn(() => false) } as any,
          autoNameTask: vi.fn(),
        },
      }),
      taskStore,
      lifecycleDeps(taskStore),
      now,
    );

    expect(launch).toHaveBeenCalledWith(
      pending.id,
      pending.prompt,
      '/tmp',
      undefined,
      expect.objectContaining({ onSessionCreated: expect.any(Function) }),
    );
  });
});

describe('restoreExpiredSnoozes', () => {
  test('rebinds an expired task-keyed finding to the latest live session', () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask('Task', '/tmp');
    taskStore.addSession(task.id, {
      tmuxSession: 'old-session',
      agentType: 'claude',
      cwd: '/tmp',
      createdAt: new Date('2026-04-15T00:00:00Z'),
      lastStatus: 'completed',
    });
    taskStore.addSession(task.id, {
      tmuxSession: 'live-session',
      agentType: 'claude',
      cwd: '/tmp',
      createdAt: new Date('2026-04-15T00:01:00Z'),
      lastStatus: 'running',
    });
    const queue = new AttentionQueue({ taskIdFor: (agentId) => taskStore.findTaskBySession(agentId)?.id ?? null });
    queue.importSnoozed([{
      agentId: 'old-session',
      key: task.id,
      kind: 'finding',
      anomaly: makeAnomaly('old-session'),
      expiresAt: Date.now() - 1,
      createdAt: Date.now() - 60_000,
    }]);

    expect(restoreExpiredSnoozes(queue, taskStore)).toBe(true);

    const next = queue.next();
    expect(next?.agentId).toBe('live-session');
    expect(next?.anomaly.agentId).toBe('live-session');
    expect(queue.getSnoozed()).toHaveLength(0);
  });

  test('keeps an expired active-task finding pending when no live session exists', () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask('Task', '/tmp');
    taskStore.addSession(task.id, {
      tmuxSession: 'old-session',
      agentType: 'claude',
      cwd: '/tmp',
      createdAt: new Date('2026-04-15T00:00:00Z'),
      lastStatus: 'completed',
    });
    const queue = new AttentionQueue({ taskIdFor: (agentId) => taskStore.findTaskBySession(agentId)?.id ?? null });
    queue.importSnoozed([{
      agentId: 'old-session',
      key: task.id,
      kind: 'finding',
      anomaly: makeAnomaly('old-session'),
      expiresAt: Date.now() - 1,
      createdAt: Date.now() - 60_000,
    }]);

    expect(restoreExpiredSnoozes(queue, taskStore)).toBe(false);

    expect(queue.next()).toBeNull();
    expect(queue.getSnoozed()).toMatchObject([{
      agentId: 'old-session',
      key: task.id,
      expiredPendingRestore: true,
    }]);
  });

  test('drops expired snoozes for terminal or deleted tasks', () => {
    const taskStore = new TaskStore();
    const terminalTask = taskStore.createTask('Done', '/tmp');
    taskStore.addSession(terminalTask.id, {
      tmuxSession: 'terminal-session',
      agentType: 'claude',
      cwd: '/tmp',
      createdAt: new Date('2026-04-15T00:00:00Z'),
      lastStatus: 'completed',
    });
    taskStore.completeTask(terminalTask.id);
    const queue = new AttentionQueue({ taskIdFor: (agentId) => taskStore.findTaskBySession(agentId)?.id ?? null });
    queue.importSnoozed([
      {
        agentId: 'terminal-session',
        key: terminalTask.id,
        kind: 'finding',
        anomaly: makeAnomaly('terminal-session'),
        expiresAt: Date.now() - 1,
        createdAt: Date.now() - 60_000,
      },
      {
        agentId: 'deleted-session',
        key: 'deleted-task',
        kind: 'task',
        expiresAt: Date.now() - 1,
        createdAt: Date.now() - 60_000,
      },
    ]);

    expect(restoreExpiredSnoozes(queue, taskStore)).toBe(true);

    expect(queue.next()).toBeNull();
    expect(queue.getSnoozed()).toHaveLength(0);
  });
});

describe('runPersistenceSaveTick', () => {
  test('records task-state and detection-stats save failures without blocking either path', async () => {
    const taskStore = new TaskStore();
    const queue = new AttentionQueue();
    const tracker = new PersistenceHealthTracker();
    const taskError = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    const statsError = new Error('stats busy');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await runPersistenceSaveTick({
      taskStore,
      queue,
      tasksFile: '/tmp/tasks.json',
      persistenceHealth: tracker,
      taskStateSaver: vi.fn(async () => {
        throw taskError;
      }),
      detectionStatsStore: {
        save: vi.fn(async () => {
          throw statsError;
        }),
      },
      getDetectionStatsSnapshot: () => ({ checks: {}, fires: {}, falsePositives: {} } as never),
    });

    expect(tracker.snapshot().targets.task_state).toMatchObject({
      totalFailures: 1,
      consecutiveFailures: 1,
      lastError: { code: 'ENOSPC', hard: true },
    });
    expect(tracker.snapshot().targets.detection_stats).toMatchObject({
      totalFailures: 1,
      consecutiveFailures: 1,
      lastError: { message: 'stats busy', hard: false },
    });
    expect(consoleError).toHaveBeenCalledWith('Error saving tasks:', taskError);
    expect(consoleError).toHaveBeenCalledWith('Error saving detection stats:', statsError);

    consoleError.mockRestore();
  });

  test('records recovery after successful saves', async () => {
    const taskStore = new TaskStore();
    const queue = new AttentionQueue();
    const tracker = new PersistenceHealthTracker();
    tracker.recordFailure('task_state', new Error('previous failure'));
    tracker.recordFailure('detection_stats', new Error('previous failure'));

    await runPersistenceSaveTick({
      taskStore,
      queue,
      tasksFile: '/tmp/tasks.json',
      persistenceHealth: tracker,
      taskStateSaver: vi.fn(async () => undefined),
      detectionStatsStore: { save: vi.fn(async () => undefined) },
      getDetectionStatsSnapshot: () => ({ checks: {}, fires: {}, falsePositives: {} } as never),
    });

    expect(tracker.snapshot().targets.task_state).toMatchObject({
      consecutiveFailures: 0,
      lastError: null,
    });
    expect(tracker.snapshot().targets.detection_stats).toMatchObject({
      consecutiveFailures: 0,
      lastError: null,
    });
  });

  test('force-flushes coalesced task-state saves on the periodic tick', async () => {
    const taskStore = new TaskStore();
    const queue = new AttentionQueue();
    const flush = vi.fn(async () => undefined);

    await runPersistenceSaveTick({
      taskStore,
      queue,
      tasksFile: '/tmp/tasks.json',
      taskStateSaveScheduler: {
        requestSave: vi.fn(),
        close: vi.fn(async () => undefined),
        flush,
      },
      detectionStatsStore: { save: vi.fn(async () => undefined) },
      getDetectionStatsSnapshot: () => ({ checks: {}, fires: {}, falsePositives: {} } as never),
    });

    expect(flush).toHaveBeenCalledWith('periodic', { force: true, policy: 'daily' });
  });
});

describe('startLifecycleTimers budget threshold wiring', () => {
  test('forwards the project config store to the token-scan budget check', async () => {
    vi.useFakeTimers();
    const taskStore = new TaskStore();
    const task = taskStore.createTask({
      prompt: 'budgeted task',
      cwd: '/tmp',
      projectId: 'github.com/org/repo',
    });
    taskStore.addSession(task.id, aSession({ tmuxSession: 'agent-budget', lastStatus: 'running' }));
    const queue = new AttentionQueue();
    const handles = startLifecycleTimers({
      monitor: {
        getSnapshot: () => [],
        getAgentEvents: () => [],
        applyWatchdogVerdict: vi.fn(),
        sampleFindingEvidence: vi.fn(),
        getCurrentAnomaly: vi.fn(),
      } as any,
      taskStore,
      queue,
      adapter: { captureDisplay: vi.fn(async () => '') } as any,
      adapterRegistry: {} as any,
      tokenTracker: {
        scanGrowth: vi.fn(async () => []),
        scanAll: vi.fn(async () => undefined),
        getTrackedTaskIds: vi.fn(() => [task.id]),
        getUsage: vi.fn(() => ({
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: 5,
        })),
      } as any,
      watchdog: {
        getTrackedAgents: vi.fn(() => []),
        recordTokenActivity: vi.fn(),
        tick: vi.fn(),
      } as any,
      hookWatcher: { drainNow: vi.fn(async () => undefined) } as any,
      terminalBackend: { listSessions: vi.fn(async () => []) } as any,
      hooksDir: '/tmp/hooks',
      tasksFile: '/tmp/tasks.json',
      serverCwd: '/tmp/repo',
      saveIntervalMs: 60_000,
      livenessIntervalMs: 60_000,
      broadcastToAll: vi.fn(),
      budgetChecker: new BudgetChecker(0),
      projectConfigStore: {
        getConfig: vi.fn(() => ({ project: task.projectId!, budgetWarnUsd: 5 })),
      },
    });

    try {
      await vi.advanceTimersByTimeAsync(5_000);
      expect(queue.getAll()).toEqual([
        expect.objectContaining({
          agentId: 'agent-budget',
          anomaly: expect.objectContaining({ type: 'budget_exceeded', severity: 'warning' }),
        }),
      ]);
    } finally {
      clearAllTimers(handles);
    }
  });
});

describe('startLifecycleTimers hung-task reaper wiring (issue #1526 Phase A)', () => {
  // The production safety property: maybeReapHungTask is only ever invoked
  // when the SAME watchdog.tick() call this tick already ran returned
  // 'stale_agent' — so a task the watchdog currently classifies as
  // needs_input/permission_blocked/etc. is excluded no matter how long its
  // liveness channels have been silent. Every other reaper test drives
  // maybeReapHungTask directly and therefore cannot exercise this gate —
  // this is the one test that does, through a REAL Watchdog and the real
  // startLifecycleTimers wiring.
  const STALE_PANE = 'some old tool output\nnothing recognizable here\n';
  // Matches CLAUDE_INPUT_PROMPT_RE (src/shared/pane-semantics.ts) — a lone
  // '❯' on its own trailing line is Claude Code's high-confidence input
  // prompt marker.
  const NEEDS_INPUT_PANE = 'Some final assistant message.\n❯\n';

  function baseTimerDeps(overrides: Partial<TimerDeps> = {}): { taskStore: TaskStore; deps: TimerDeps } {
    const taskStore = new TaskStore();
    const deps: TimerDeps = {
      monitor: {
        getSnapshot: () => [],
        getAgentEvents: () => [],
        applyWatchdogVerdict: vi.fn(() => false),
        sampleFindingEvidence: vi.fn(() => false),
        getCurrentAnomaly: vi.fn(),
        unregisterAgent: vi.fn(),
      } as any,
      taskStore,
      queue: new AttentionQueue(),
      adapter: {
        captureDisplay: vi.fn(async () => STALE_PANE),
        stop: vi.fn(async () => undefined),
      } as any,
      adapterRegistry: {} as any,
      tokenTracker: {
        scanGrowth: vi.fn(async () => []),
        scanAll: vi.fn(async () => undefined),
        getTrackedTaskIds: vi.fn(() => []),
        getUsage: vi.fn(() => undefined),
        unregister: vi.fn(),
      } as any,
      watchdog: new Watchdog(),
      hookWatcher: { drainNow: vi.fn(async () => undefined), stop: vi.fn(), isWatching: vi.fn(() => false), watch: vi.fn() } as any,
      terminalBackend: { listSessions: vi.fn(async () => []) } as any,
      hooksDir: '/tmp/hooks',
      tasksFile: '/tmp/tasks.json',
      serverCwd: '/tmp/repo',
      saveIntervalMs: 600_000,
      // Kept well above the 5s watchdog tick so only the watchdog interval
      // fires during a single 5s advance — the liveness/auto-close sweep is
      // out of scope for this test.
      livenessIntervalMs: 600_000,
      broadcastToAll: vi.fn(),
      getHungTaskReapMs: () => 1_000,
      ...overrides,
    };
    return { taskStore, deps };
  }

  function registerStaleAgent(watchdog: Watchdog, agentId: string): void {
    // Far enough in the past to already be past the grace period and the
    // watchdog's own stale threshold by the time the interval first ticks.
    const longAgo = Date.now() - 20 * 60_000;
    watchdog.registerAgent(agentId, longAgo, longAgo);
  }

  test('needs_input (fully silent) is NOT reaped', async () => {
    vi.useFakeTimers();
    const agentId = 'agent-needs-input';
    const { taskStore, deps } = baseTimerDeps({
      adapter: { captureDisplay: vi.fn(async () => NEEDS_INPUT_PANE), stop: vi.fn(async () => undefined) } as any,
    });
    const task = taskStore.createTask({ prompt: 'waiting', cwd: '/tmp' });
    taskStore.addSession(task.id, { tmuxSession: agentId, agentType: 'claude-code', cwd: '/tmp', createdAt: new Date() });
    registerStaleAgent(deps.watchdog, agentId);

    const handles = startLifecycleTimers(deps);
    try {
      await vi.advanceTimersByTimeAsync(5_000);
      // Sanity check on the gate itself: the real watchdog tick for this
      // pane really does classify as needs_input, not stale_agent.
      expect(deps.watchdog.tick(agentId, NEEDS_INPUT_PANE, []).status).toBe('needs_input');
      expect(taskStore.getTask(task.id)?.status).toBe('inProgress');
    } finally {
      clearAllTimers(handles);
    }
  });

  test('stale_agent (fully silent) IS reaped', async () => {
    vi.useFakeTimers();
    const agentId = 'agent-stale';
    const { taskStore, deps } = baseTimerDeps();
    const task = taskStore.createTask({ prompt: 'hung', cwd: '/tmp' });
    taskStore.addSession(task.id, { tmuxSession: agentId, agentType: 'claude-code', cwd: '/tmp', createdAt: new Date() });
    registerStaleAgent(deps.watchdog, agentId);

    // Sanity check on the gate itself, on an identically-registered SEPARATE
    // watchdog instance — the production one gets unregisterAgent'd as part
    // of the reap teardown below, so it can't be re-ticked afterward.
    const sanityWatchdog = new Watchdog();
    registerStaleAgent(sanityWatchdog, agentId);
    expect(sanityWatchdog.tick(agentId, STALE_PANE, []).status).toBe('stale_agent');

    const handles = startLifecycleTimers(deps);
    try {
      await vi.advanceTimersByTimeAsync(5_000);
      expect(taskStore.getTask(task.id)?.status).toBe('terminated');
    } finally {
      clearAllTimers(handles);
    }
  });
});

describe('startLifecycleTimers watchdog-tick re-entrancy guard (issue #1526 Phase A review fix)', () => {
  test('a slow tick blocks a second concurrent watchdog tick from starting', async () => {
    vi.useFakeTimers();
    const { deps } = (() => {
      const taskStore = new TaskStore();
      // captureDisplay never resolves within this test — simulates a tick
      // still mid-flight when the next 5s interval fires.
      const captureDisplay = vi.fn(() => new Promise<string>(() => {}));
      const deps: TimerDeps = {
        monitor: {
          getSnapshot: () => [],
          getAgentEvents: () => [],
          applyWatchdogVerdict: vi.fn(() => false),
          sampleFindingEvidence: vi.fn(() => false),
          getCurrentAnomaly: vi.fn(),
        } as any,
        taskStore,
        queue: new AttentionQueue(),
        adapter: { captureDisplay, stop: vi.fn(async () => undefined) } as any,
        adapterRegistry: {} as any,
        tokenTracker: {
          scanGrowth: vi.fn(async () => []),
          scanAll: vi.fn(async () => undefined),
          getTrackedTaskIds: vi.fn(() => []),
          getUsage: vi.fn(() => undefined),
        } as any,
        watchdog: { getTrackedAgents: vi.fn(() => ['agent-slow']), recordTokenActivity: vi.fn(), tick: vi.fn() } as any,
        hookWatcher: { drainNow: vi.fn(async () => undefined) } as any,
        terminalBackend: { listSessions: vi.fn(async () => []) } as any,
        hooksDir: '/tmp/hooks',
        tasksFile: '/tmp/tasks.json',
        serverCwd: '/tmp/repo',
        saveIntervalMs: 600_000,
        livenessIntervalMs: 600_000,
        broadcastToAll: vi.fn(),
      };
      return { deps };
    })();

    const handles = startLifecycleTimers(deps);
    try {
      // Two interval periods elapse while captureDisplay is still pending —
      // without the guard, watchdog.getTrackedAgents/captureDisplay would
      // fire again on the second tick even though the first never finished.
      await vi.advanceTimersByTimeAsync(11_000);
      expect(deps.adapter.captureDisplay).toHaveBeenCalledTimes(1);
    } finally {
      clearAllTimers(handles);
    }
  });
});

describe('startLifecycleTimers token-scan-tick re-entrancy guard (issue #1620 change c)', () => {
  test('a slow in-flight token scan blocks the next tick from starting a second scan', async () => {
    vi.useFakeTimers();
    const taskStore = new TaskStore();
    // scanGrowth never resolves within this test — simulates a full-corpus
    // scan still mid-flight (awaiting disk I/O) when the next 5s interval fires.
    const scanGrowth = vi.fn(() => new Promise<[]>(() => {}));
    const scanAll = vi.fn(async () => undefined);
    const deps: TimerDeps = {
      monitor: {
        getSnapshot: () => [],
        getAgentEvents: () => [],
        applyWatchdogVerdict: vi.fn(() => false),
        sampleFindingEvidence: vi.fn(() => false),
        getCurrentAnomaly: vi.fn(),
      } as any,
      taskStore,
      queue: new AttentionQueue(),
      adapter: { captureDisplay: vi.fn(async () => ''), stop: vi.fn(async () => undefined) } as any,
      adapterRegistry: {} as any,
      tokenTracker: {
        scanGrowth,
        scanAll,
        getTrackedTaskIds: vi.fn(() => []),
        getUsage: vi.fn(() => undefined),
      } as any,
      watchdog: { getTrackedAgents: vi.fn(() => []), recordTokenActivity: vi.fn(), tick: vi.fn() } as any,
      hookWatcher: { drainNow: vi.fn(async () => undefined) } as any,
      terminalBackend: { listSessions: vi.fn(async () => []) } as any,
      hooksDir: '/tmp/hooks',
      tasksFile: '/tmp/tasks.json',
      serverCwd: '/tmp/repo',
      saveIntervalMs: 600_000,
      livenessIntervalMs: 600_000,
      broadcastToAll: vi.fn(),
    };

    const handles = startLifecycleTimers(deps);
    try {
      // Two 5s interval periods elapse while scanGrowth is still pending —
      // without the guard, a second scanGrowth would fire on the next tick.
      await vi.advanceTimersByTimeAsync(11_000);
      expect(scanGrowth).toHaveBeenCalledTimes(1);
      expect(scanAll).not.toHaveBeenCalled();
    } finally {
      clearAllTimers(handles);
    }
  });
});

describe('startLifecycleTimers user input delivery retry sweep', () => {
  test('runs the sweep on watchdog cadence and broadcasts when it nudges input', async () => {
    vi.useFakeTimers();
    const taskStore = new TaskStore();
    const broadcastToAll = vi.fn();
    const sweepUnsubmittedDeliveries = vi.fn(async () => 1);
    const handles = startLifecycleTimers({
      monitor: {
        getSnapshot: () => [],
        getAgentEvents: () => [],
        applyWatchdogVerdict: vi.fn(),
        sampleFindingEvidence: vi.fn(),
        getCurrentAnomaly: vi.fn(),
      } as any,
      taskStore,
      queue: new AttentionQueue(),
      adapter: {
        captureDisplay: vi.fn(async () => ''),
      } as any,
      adapterRegistry: {} as any,
      tokenTracker: {
        scanGrowth: vi.fn(async () => []),
        scanAll: vi.fn(async () => undefined),
        getTrackedTaskIds: vi.fn(() => []),
      } as any,
      watchdog: {
        getTrackedAgents: vi.fn(() => []),
        recordTokenActivity: vi.fn(),
        tick: vi.fn(),
      } as any,
      hookWatcher: {
        drainNow: vi.fn(async () => undefined),
      } as any,
      terminalBackend: {
        listSessions: vi.fn(async () => []),
      } as any,
      hooksDir: '/tmp/hooks',
      tasksFile: '/tmp/tasks.json',
      serverCwd: '/tmp/repo',
      saveIntervalMs: 60_000,
      livenessIntervalMs: 60_000,
      broadcastToAll,
      userInputDeliveries: { sweepUnsubmittedDeliveries },
    });

    try {
      await vi.advanceTimersByTimeAsync(5_000);

      expect(sweepUnsubmittedDeliveries).toHaveBeenCalledTimes(1);
      expect(broadcastToAll).toHaveBeenCalledWith(expect.objectContaining({ type: 'snapshot' }));
    } finally {
      clearAllTimers(handles);
    }
  });

  test('logs sweep failures without broadcasting a retry snapshot', async () => {
    vi.useFakeTimers();
    const taskStore = new TaskStore();
    const broadcastToAll = vi.fn();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const sweepUnsubmittedDeliveries = vi.fn(async () => {
      throw new Error('capture failed');
    });
    const handles = startLifecycleTimers({
      monitor: {
        getSnapshot: () => [],
        getAgentEvents: () => [],
        applyWatchdogVerdict: vi.fn(),
        sampleFindingEvidence: vi.fn(),
        getCurrentAnomaly: vi.fn(),
      } as any,
      taskStore,
      queue: new AttentionQueue(),
      adapter: {
        captureDisplay: vi.fn(async () => ''),
      } as any,
      adapterRegistry: {} as any,
      tokenTracker: {
        scanGrowth: vi.fn(async () => []),
        scanAll: vi.fn(async () => undefined),
        getTrackedTaskIds: vi.fn(() => []),
      } as any,
      watchdog: {
        getTrackedAgents: vi.fn(() => []),
        recordTokenActivity: vi.fn(),
        tick: vi.fn(),
      } as any,
      hookWatcher: {
        drainNow: vi.fn(async () => undefined),
      } as any,
      terminalBackend: {
        listSessions: vi.fn(async () => []),
      } as any,
      hooksDir: '/tmp/hooks',
      tasksFile: '/tmp/tasks.json',
      serverCwd: '/tmp/repo',
      saveIntervalMs: 60_000,
      livenessIntervalMs: 60_000,
      broadcastToAll,
      userInputDeliveries: { sweepUnsubmittedDeliveries },
    });

    try {
      await vi.advanceTimersByTimeAsync(5_000);

      expect(sweepUnsubmittedDeliveries).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith(
        'Error sweeping unsubmitted user-input deliveries:',
        expect.any(Error),
      );
      expect(broadcastToAll).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'snapshot' }));
    } finally {
      clearAllTimers(handles);
    }
  });
});

describe('startLifecycleTimers schedules-paused residual wiring (issue #2426)', () => {
  function wiringDeps(overrides: Partial<TimerDeps> = {}): TimerDeps {
    return {
      monitor: {
        getSnapshot: () => [],
        getAgentEvents: () => [],
        applyWatchdogVerdict: vi.fn(() => false),
        sampleFindingEvidence: vi.fn(() => false),
        getCurrentAnomaly: vi.fn(),
        unregisterAgent: vi.fn(),
      } as TimerDeps['monitor'],
      taskStore: new TaskStore(),
      queue: new AttentionQueue(),
      adapter: {
        captureDisplay: vi.fn(async () => ''),
        stop: vi.fn(async () => undefined),
      } as TimerDeps['adapter'],
      adapterRegistry: {} as TimerDeps['adapterRegistry'],
      tokenTracker: {
        scanGrowth: vi.fn(async () => []),
        scanAll: vi.fn(async () => undefined),
        getTrackedTaskIds: vi.fn(() => []),
        getUsage: vi.fn(() => undefined),
        unregister: vi.fn(),
      } as TimerDeps['tokenTracker'],
      watchdog: new Watchdog(),
      hookWatcher: {
        drainNow: vi.fn(async () => undefined),
        stop: vi.fn(),
        isWatching: vi.fn(() => false),
        watch: vi.fn(),
      } as TimerDeps['hookWatcher'],
      terminalBackend: { listSessions: vi.fn(async () => []) } as TimerDeps['terminalBackend'],
      hooksDir: '/tmp/hooks',
      tasksFile: '/tmp/tasks.json',
      serverCwd: '/tmp/repo',
      saveIntervalMs: 600_000,
      livenessIntervalMs: 50,
      broadcastToAll: vi.fn(),
      ...overrides,
    };
  }

  test('liveness tick evaluates the snapshot and never calls setEnabled', async () => {
    vi.useFakeTimers();
    const evaluate = vi.fn();
    const snapshot = makePausedByFailureSnapshot({
      names: ['orchestrator', 'smoke tick', 'daily recon'],
    });
    const handles = startLifecycleTimers(wiringDeps({
      schedulesPausedResidualAlerter: { evaluate },
      scheduleService: {
        recordTaskTerminalOutcome: vi.fn(async () => undefined),
        getStatusSnapshot: () => snapshot,
      },
    }));
    try {
      await vi.advanceTimersByTimeAsync(60);
      expect(evaluate).toHaveBeenCalled();
      const last = evaluate.mock.calls[evaluate.mock.calls.length - 1]?.[0];
      expect(last).toEqual({
        paused: snapshot.schedulesPausedByFailure,
      });
    } finally {
      clearAllTimers(handles);
    }
  });

  test('omits evaluate when getStatusSnapshot is unwired', async () => {
    vi.useFakeTimers();
    const evaluate = vi.fn();
    const handles = startLifecycleTimers(wiringDeps({
      schedulesPausedResidualAlerter: { evaluate },
      scheduleService: {
        recordTaskTerminalOutcome: vi.fn(async () => undefined),
      },
    }));
    try {
      await vi.advanceTimersByTimeAsync(60);
      expect(evaluate).not.toHaveBeenCalled();
    } finally {
      clearAllTimers(handles);
    }
  });
});

describe('resolveMaintenancePruneIntervalHours', () => {
  test('is off (0) by default and for invalid values', () => {
    expect(resolveMaintenancePruneIntervalHours({})).toBe(0);
    expect(resolveMaintenancePruneIntervalHours({ KOOKR_MAINTENANCE_PRUNE_INTERVAL_HOURS: '' })).toBe(0);
    expect(resolveMaintenancePruneIntervalHours({ KOOKR_MAINTENANCE_PRUNE_INTERVAL_HOURS: 'nope' })).toBe(0);
    expect(resolveMaintenancePruneIntervalHours({ KOOKR_MAINTENANCE_PRUNE_INTERVAL_HOURS: '0' })).toBe(0);
    expect(resolveMaintenancePruneIntervalHours({ KOOKR_MAINTENANCE_PRUNE_INTERVAL_HOURS: '-4' })).toBe(0);
  });
  test('parses a positive number of hours', () => {
    expect(resolveMaintenancePruneIntervalHours({ KOOKR_MAINTENANCE_PRUNE_INTERVAL_HOURS: '24' })).toBe(24);
    expect(resolveMaintenancePruneIntervalHours({ KOOKR_MAINTENANCE_PRUNE_INTERVAL_HOURS: '0.5' })).toBe(0.5);
  });
});

describe('runScheduledMaintenancePrune', () => {
  const fakeResult = (over: Partial<MaintenancePruneResult> = {}): MaintenancePruneResult => ({
    dataDir: '/tmp/data',
    dryRun: false,
    maxAgeDays: 30,
    planned: [],
    removed: [],
    reclaimedBytes: 0,
    preserved: [],
    warnings: [],
    ...over,
  });

  test('forwards config to the prune core with dryRun=false and logs the reclaim', async () => {
    const run = vi.fn(async () => fakeResult({ reclaimedBytes: 4096, removed: [{} as never] }));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await runScheduledMaintenancePrune({
      dataDir: '/tmp/data',
      intervalHours: 24,
      maxAgeDays: 30,
      playbookStateKeepLast: 2,
      run,
    });
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ dataDir: '/tmp/data', maxAgeDays: 30, playbookStateKeepLast: 2, dryRun: false }),
    );
    expect(result?.reclaimedBytes).toBe(4096);
    expect(logSpy.mock.calls.flat().join(' ')).toMatch(/reclaimed 4096 byte/);
  });

  test('records success on the optional health tracker (issue #2345)', async () => {
    const run = vi.fn(async () => fakeResult({ reclaimedBytes: 2048, removed: [{} as never, {} as never] }));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const health = {
      recordSuccess: vi.fn(),
      recordFailure: vi.fn(),
    };
    await runScheduledMaintenancePrune({
      dataDir: '/tmp/data',
      intervalHours: 24,
      run,
      health,
    });
    expect(health.recordSuccess).toHaveBeenCalledWith(
      expect.objectContaining({ reclaimedBytes: 2048, removed: expect.any(Array) }),
    );
    expect(health.recordFailure).not.toHaveBeenCalled();
  });

  test('never throws — a failing sweep is logged and returns null', async () => {
    const run = vi.fn(async () => {
      throw new Error('disk exploded');
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await runScheduledMaintenancePrune({ dataDir: '/tmp/data', intervalHours: 24, run });
    expect(result).toBeNull();
    expect(errSpy.mock.calls.flat().join(' ')).toMatch(/scheduled sweep failed/);
  });

  test('records failure on the optional health tracker (issue #2345)', async () => {
    const run = vi.fn(async () => {
      throw new Error('disk exploded');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const health = {
      recordSuccess: vi.fn(),
      recordFailure: vi.fn(),
    };
    await runScheduledMaintenancePrune({ dataDir: '/tmp/data', intervalHours: 24, run, health });
    expect(health.recordFailure).toHaveBeenCalledWith(expect.any(Error));
    expect(health.recordSuccess).not.toHaveBeenCalled();
  });

  test('runs the task-record prune leg on the same tick and fires onTaskRecordsPruned (issue #1526 C2)', async () => {
    const run = vi.fn(async () => fakeResult());
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const pruneTaskRecords = vi.fn(async () => ({
      outcome: 'pruned' as const,
      prunedTaskIds: ['t-1', 't-2'],
      remainingTasks: 40,
      maxAgeDays: 7,
    }));
    const onTaskRecordsPruned = vi.fn();

    await runScheduledMaintenancePrune({
      dataDir: '/tmp/data',
      intervalHours: 24,
      run,
      pruneTaskRecords,
      onTaskRecordsPruned,
      getPayloadDietStats: () => ({ trackedTasks: 40, terminalTasks: 30, lastSnapshotBytes: 123456 }),
    });

    expect(pruneTaskRecords).toHaveBeenCalledTimes(1);
    expect(onTaskRecordsPruned).toHaveBeenCalledWith(
      expect.objectContaining({ prunedTaskIds: ['t-1', 't-2'], remainingTasks: 40 }),
    );
    const logged = logSpy.mock.calls.flat().join('\n');
    expect(logged).toMatch(/task-record prune removed 2 aged terminal task record\(s\)/);
    expect(logged).toMatch(/\[payload-diet\] tracked task records=40 \(terminal=30\); last snapshot broadcast=123456 bytes/);
  });

  test('does not fire onTaskRecordsPruned when nothing was pruned, and still logs the diet line', async () => {
    const run = vi.fn(async () => fakeResult());
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const onTaskRecordsPruned = vi.fn();

    await runScheduledMaintenancePrune({
      dataDir: '/tmp/data',
      intervalHours: 24,
      run,
      pruneTaskRecords: async () => ({
        outcome: 'pruned' as const,
        prunedTaskIds: [],
        remainingTasks: 12,
        maxAgeDays: 7,
      }),
      onTaskRecordsPruned,
      getPayloadDietStats: () => ({ trackedTasks: 12, terminalTasks: 3, lastSnapshotBytes: null }),
    });

    expect(onTaskRecordsPruned).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.flat().join('\n')).toMatch(/last snapshot broadcast=none yet/);
  });

  test('task-record prune leg still runs when the disk sweep throws, and its own failure is isolated', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const pruneTaskRecords = vi.fn(async () => {
      throw new Error('store hiccup');
    });
    const failingDiskSweep = vi.fn(async () => {
      throw new Error('disk exploded');
    });

    const result = await runScheduledMaintenancePrune({
      dataDir: '/tmp/data',
      intervalHours: 24,
      run: failingDiskSweep,
      pruneTaskRecords,
    });

    expect(result).toBeNull();
    expect(pruneTaskRecords).toHaveBeenCalledTimes(1);
    const errors = errSpy.mock.calls.flat().join('\n');
    expect(errors).toMatch(/scheduled sweep failed/);
    expect(errors).toMatch(/task-record prune failed/);
  });
});

describe('startLifecycleTimers maintenance prune scheduling', () => {
  function baseTimerDeps(overrides: Record<string, unknown>) {
    return {
      monitor: {
        getSnapshot: () => [],
        getAgentEvents: () => [],
        applyWatchdogVerdict: vi.fn(),
        sampleFindingEvidence: vi.fn(),
        getCurrentAnomaly: vi.fn(),
      } as any,
      taskStore: new TaskStore(),
      queue: new AttentionQueue(),
      adapter: { captureDisplay: vi.fn(async () => '') } as any,
      adapterRegistry: {} as any,
      tokenTracker: {
        scanGrowth: vi.fn(async () => []),
        scanAll: vi.fn(async () => undefined),
        getTrackedTaskIds: vi.fn(() => []),
        getUsage: vi.fn(() => undefined),
      } as any,
      watchdog: { getTrackedAgents: vi.fn(() => []) } as any,
      hookWatcher: { drainNow: vi.fn(async () => undefined) } as any,
      terminalBackend: { listSessions: vi.fn(async () => []) } as any,
      hooksDir: '/tmp/hooks',
      tasksFile: '/tmp/tasks.json',
      serverCwd: '/tmp/repo',
      saveIntervalMs: 60_000,
      livenessIntervalMs: 60_000,
      broadcastToAll: vi.fn(),
      ...overrides,
    };
  }

  test('fires the scheduled prune on its interval and stops on clear', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => ({
      dataDir: '/tmp/data', dryRun: false, maxAgeDays: 30,
      planned: [], removed: [], reclaimedBytes: 0, preserved: [], warnings: [],
    }));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const handles = startLifecycleTimers(baseTimerDeps({
      maintenancePrune: { dataDir: '/tmp/data', intervalHours: 0.0005 /* 1.8s */, run },
    }) as any);
    try {
      expect(handles.maintenancePruneInterval).not.toBeNull();
      expect(run).not.toHaveBeenCalled(); // no boot run
      await vi.advanceTimersByTimeAsync(1_900);
      expect(run).toHaveBeenCalledTimes(1);
    } finally {
      clearAllTimers(handles);
    }
    const callsAfterClear = run.mock.calls.length;
    await vi.advanceTimersByTimeAsync(4_000);
    expect(run.mock.calls.length).toBe(callsAfterClear); // cleared — no more sweeps
  });

  test('does not schedule a prune when the interval is 0 (off)', () => {
    vi.useFakeTimers();
    const run = vi.fn();
    const handles = startLifecycleTimers(baseTimerDeps({
      maintenancePrune: { dataDir: '/tmp/data', intervalHours: 0, run },
    }) as any);
    try {
      expect(handles.maintenancePruneInterval).toBeNull();
      expect(handles.maintenancePruneStartupTimer).toBeNull();
      expect(run).not.toHaveBeenCalled();
    } finally {
      clearAllTimers(handles);
    }
  });

  test('omitting maintenancePrune leaves scheduling off', () => {
    vi.useFakeTimers();
    const handles = startLifecycleTimers(baseTimerDeps({}) as any);
    try {
      expect(handles.maintenancePruneInterval).toBeNull();
      expect(handles.maintenancePruneStartupTimer).toBeNull();
    } finally {
      clearAllTimers(handles);
    }
  });

  test('schedules server.log size-cap rotation and stops on clear (issue #1991)', async () => {
    vi.useFakeTimers();
    const run = vi.fn();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const handles = startLifecycleTimers(baseTimerDeps({
      serverLogRotation: {
        logPath: '/tmp/server.log',
        maxBytes: 1024,
        generations: 3,
        intervalMs: 1_000,
        run,
      },
    }) as any);
    try {
      expect(handles.serverLogRotationInterval).not.toBeNull();
      expect(run).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_050);
      expect(run).toHaveBeenCalledTimes(1);
    } finally {
      clearAllTimers(handles);
    }
    const callsAfterClear = run.mock.calls.length;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(run.mock.calls.length).toBe(callsAfterClear);
  });

  test('does not schedule server.log rotation when disabled (issue #1991)', () => {
    vi.useFakeTimers();
    const run = vi.fn();
    const handles = startLifecycleTimers(baseTimerDeps({
      serverLogRotation: {
        logPath: '/tmp/server.log',
        maxBytes: 0,
        generations: 3,
        intervalMs: 1_000,
        run,
      },
    }) as any);
    try {
      expect(handles.serverLogRotationInterval).toBeNull();
      expect(run).not.toHaveBeenCalled();
    } finally {
      clearAllTimers(handles);
    }
  });

  test('skips the next maintenance prune tick when nonCriticalTickPause is elevated (issue #1785)', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => ({
      dataDir: '/tmp/data', dryRun: false, maxAgeDays: 30,
      planned: [], removed: [], reclaimedBytes: 0, preserved: [], warnings: [],
    }));
    let elevated = true;
    const recordPause = vi.fn();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const handles = startLifecycleTimers(baseTimerDeps({
      maintenancePrune: { dataDir: '/tmp/data', intervalHours: 0.0005 /* 1.8s */, run },
      nonCriticalTickPause: {
        shouldSkipTick: () => elevated,
        recordPause,
      },
    }) as any);
    try {
      await vi.advanceTimersByTimeAsync(1_900);
      expect(run).not.toHaveBeenCalled();
      expect(recordPause).toHaveBeenCalledWith('maintenancePrune');

      elevated = false;
      recordPause.mockClear();
      await vi.advanceTimersByTimeAsync(1_900);
      expect(run).toHaveBeenCalledTimes(1);
      expect(recordPause).not.toHaveBeenCalled();
    } finally {
      clearAllTimers(handles);
    }
  });

  // --- Relay-orphan sweep wiring (issue #1723 / #1885) ---
  test('fires a startup reclaim then the scheduled relay-orphan sweep on its interval', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const handles = startLifecycleTimers(baseTimerDeps({
      relayOrphanSweep: { intervalHours: 0.5, run },
    }) as any);
    try {
      expect(handles.relayOrphanSweepInterval).not.toBeNull();
      expect(handles.relayOrphanSweepStartupTimer).not.toBeNull();
      // Startup reclaim (#1885): one sweep fires shortly after boot, well before
      // the first 30-minute interval tick.
      expect(run).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(31_000);
      expect(run).toHaveBeenCalledTimes(1);
      // Then the periodic interval keeps sweeping.
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
      expect(run).toHaveBeenCalledTimes(2);
    } finally {
      clearAllTimers(handles);
    }
    const callsAfterClear = run.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(run.mock.calls.length).toBe(callsAfterClear);
  });

  test('clearAllTimers cancels the startup reclaim before it fires', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const handles = startLifecycleTimers(baseTimerDeps({
      relayOrphanSweep: { intervalHours: 0.5, run },
    }) as any);
    // Clear BEFORE the 30s startup delay elapses: the startup timer is still
    // pending, so clearTimeout must actually cancel it (not a no-op).
    await vi.advanceTimersByTimeAsync(5_000);
    expect(run).not.toHaveBeenCalled();
    clearAllTimers(handles);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(run).not.toHaveBeenCalled();
  });

  test('does not schedule a relay-orphan sweep when the interval is 0 (disabled)', () => {
    vi.useFakeTimers();
    const run = vi.fn();
    const handles = startLifecycleTimers(baseTimerDeps({
      relayOrphanSweep: { intervalHours: 0, run },
    }) as any);
    try {
      expect(handles.relayOrphanSweepInterval).toBeNull();
      expect(handles.relayOrphanSweepStartupTimer).toBeNull();
      expect(run).not.toHaveBeenCalled();
    } finally {
      clearAllTimers(handles);
    }
  });

  // --- Reflect-worktree orphan sweep wiring (issue #1860) ---
  test('fires the scheduled reflect-worktree sweep on its interval with fake clock', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => ({ removed: 1, kept: 0 }));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const handles = startLifecycleTimers(baseTimerDeps({
      reflectWorktreeSweep: {
        reflectWorktreesDir: '/tmp/reflect-worktrees',
        taskStore: new TaskStore(),
        intervalHours: 0.0005 /* 1.8s */,
        run,
      },
    }) as any);
    try {
      expect(handles.reflectWorktreeSweepInterval).not.toBeNull();
      expect(run).not.toHaveBeenCalled(); // no boot run on the timer (startup sweeps separately)
      await vi.advanceTimersByTimeAsync(1_900);
      expect(run).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_900);
      expect(run).toHaveBeenCalledTimes(2);
    } finally {
      clearAllTimers(handles);
    }
    const callsAfterClear = run.mock.calls.length;
    await vi.advanceTimersByTimeAsync(4_000);
    expect(run.mock.calls.length).toBe(callsAfterClear);
  });

  test('does not schedule a reflect-worktree sweep when the interval is 0 (off)', () => {
    vi.useFakeTimers();
    const run = vi.fn();
    const handles = startLifecycleTimers(baseTimerDeps({
      reflectWorktreeSweep: {
        reflectWorktreesDir: '/tmp/reflect-worktrees',
        taskStore: new TaskStore(),
        intervalHours: 0,
        run,
      },
    }) as any);
    try {
      expect(handles.reflectWorktreeSweepInterval).toBeNull();
      expect(run).not.toHaveBeenCalled();
    } finally {
      clearAllTimers(handles);
    }
  });

  test('omitting reflectWorktreeSweep leaves scheduling off', () => {
    vi.useFakeTimers();
    const handles = startLifecycleTimers(baseTimerDeps({}) as any);
    try {
      expect(handles.reflectWorktreeSweepInterval).toBeNull();
    } finally {
      clearAllTimers(handles);
    }
  });

  test('skips the next reflect-worktree sweep tick when nonCriticalTickPause is elevated', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => ({ removed: 0, kept: 0 }));
    let elevated = true;
    const recordPause = vi.fn();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const handles = startLifecycleTimers(baseTimerDeps({
      reflectWorktreeSweep: {
        reflectWorktreesDir: '/tmp/reflect-worktrees',
        taskStore: new TaskStore(),
        intervalHours: 0.0005 /* 1.8s */,
        run,
      },
      nonCriticalTickPause: {
        shouldSkipTick: () => elevated,
        recordPause,
      },
    }) as any);
    try {
      await vi.advanceTimersByTimeAsync(1_900);
      expect(run).not.toHaveBeenCalled();
      expect(recordPause).toHaveBeenCalledWith('reflectWorktreeSweep');

      elevated = false;
      recordPause.mockClear();
      await vi.advanceTimersByTimeAsync(1_900);
      expect(run).toHaveBeenCalledTimes(1);
      expect(recordPause).not.toHaveBeenCalled();
    } finally {
      clearAllTimers(handles);
    }
  });

  // --- Hourly prod smoke tick wiring (issue #1593) ---
  function stubSmokeTick() {
    return {
      hostIntervalMs: 2_000,
      alertArtifactPath: '/tmp/data/prod-smoke-tick-alert.json',
      maybeRun: vi.fn(async () => null),
    };
  }

  test('fires the prod smoke tick on its interval and stops on clear', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const smoke = stubSmokeTick();
    const handles = startLifecycleTimers(baseTimerDeps({ prodSmokeTick: smoke }) as any);
    try {
      expect(handles.prodSmokeTickInterval).not.toBeNull();
      expect(smoke.maybeRun).not.toHaveBeenCalled(); // no boot run
      await vi.advanceTimersByTimeAsync(2_100);
      expect(smoke.maybeRun).toHaveBeenCalledTimes(1);
    } finally {
      clearAllTimers(handles);
    }
    const callsAfterClear = smoke.maybeRun.mock.calls.length;
    await vi.advanceTimersByTimeAsync(4_000);
    expect(smoke.maybeRun.mock.calls.length).toBe(callsAfterClear); // cleared — no more ticks
  });

  test('omitting prodSmokeTick leaves the tick off', () => {
    vi.useFakeTimers();
    const handles = startLifecycleTimers(baseTimerDeps({}) as any);
    try {
      expect(handles.prodSmokeTickInterval).toBeNull();
    } finally {
      clearAllTimers(handles);
    }
  });

  // --- Hourly safety-net first fire (issue #2635) ---
  test('fires the four hourly safety nets once within 60s and stamps last-fired', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-18T04:00:00.000Z'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const timerHealth = new TimerHealthTracker(() => Date.now());
    const prune = vi.fn(async () => ({
      dataDir: '/tmp/data', dryRun: false, maxAgeDays: 30,
      planned: [], removed: [], reclaimedBytes: 0, preserved: [], warnings: [],
    }));
    const smoke = {
      hostIntervalMs: 60 * 60 * 1000,
      alertArtifactPath: '/tmp/data/prod-smoke-tick-alert.json',
      maybeRun: vi.fn(async () => null),
    };
    const deployLag = {
      hostIntervalMs: 60 * 60 * 1000,
      alertArtifactPath: '/tmp/data/deploy-lag-alert.json',
      maybeRun: vi.fn(async () => undefined),
    };
    const deployConvergence = {
      hostIntervalMs: 5 * 60 * 1000,
      maybeRun: vi.fn(async () => undefined),
    };
    const handles = startLifecycleTimers(baseTimerDeps({
      timerHealth,
      maintenancePrune: { dataDir: '/tmp/data', intervalHours: 1, run: prune },
      prodSmokeTick: smoke,
      deployLagDetector: deployLag,
      deployConvergenceController: deployConvergence,
    }) as any);
    try {
      expect(handles.maintenancePruneStartupTimer).not.toBeNull();
      expect(handles.prodSmokeTickStartupTimer).not.toBeNull();
      expect(handles.deployLagDetectorStartupTimer).not.toBeNull();
      expect(handles.deployConvergenceStartupTimer).not.toBeNull();
      expect(prune).not.toHaveBeenCalled();
      expect(smoke.maybeRun).not.toHaveBeenCalled();
      expect(deployLag.maybeRun).not.toHaveBeenCalled();
      expect(deployConvergence.maybeRun).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(HOURLY_SAFETY_NET_STARTUP_DELAY_MS - 1);
      expect(prune).not.toHaveBeenCalled();
      expect(smoke.maybeRun).not.toHaveBeenCalled();
      expect(deployLag.maybeRun).not.toHaveBeenCalled();
      expect(deployConvergence.maybeRun).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(prune).toHaveBeenCalledTimes(1);
      expect(smoke.maybeRun).toHaveBeenCalledTimes(1);
      expect(deployLag.maybeRun).toHaveBeenCalledTimes(1);
      expect(deployConvergence.maybeRun).toHaveBeenCalledTimes(1);

      const afterStartup = timerHealth.snapshot();
      for (const name of [
        'maintenancePrune',
        'prodSmokeTick',
        'deployLagDetector',
        'deployConvergence',
      ] as const) {
        const loop = afterStartup.loops.find((entry) => entry.name === name);
        expect(loop?.lastFiredAt).toBe('2026-08-18T04:01:00.000Z');
        expect(loop?.overdue).toBe(false);
      }
    } finally {
      clearAllTimers(handles);
    }
  });

  test('clearAllTimers cancels hourly safety-net startup fires before they run', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const prune = vi.fn(async () => ({
      dataDir: '/tmp/data', dryRun: false, maxAgeDays: 30,
      planned: [], removed: [], reclaimedBytes: 0, preserved: [], warnings: [],
    }));
    const smoke = {
      hostIntervalMs: 60 * 60 * 1000,
      alertArtifactPath: '/tmp/data/prod-smoke-tick-alert.json',
      maybeRun: vi.fn(async () => null),
    };
    const deployLag = {
      hostIntervalMs: 60 * 60 * 1000,
      alertArtifactPath: '/tmp/data/deploy-lag-alert.json',
      maybeRun: vi.fn(async () => undefined),
    };
    const deployConvergence = {
      hostIntervalMs: 5 * 60 * 1000,
      maybeRun: vi.fn(async () => undefined),
    };
    const handles = startLifecycleTimers(baseTimerDeps({
      maintenancePrune: { dataDir: '/tmp/data', intervalHours: 1, run: prune },
      prodSmokeTick: smoke,
      deployLagDetector: deployLag,
      deployConvergenceController: deployConvergence,
    }) as any);
    await vi.advanceTimersByTimeAsync(5_000);
    clearAllTimers(handles);
    await vi.advanceTimersByTimeAsync(HOURLY_SAFETY_NET_STARTUP_DELAY_MS);
    expect(prune).not.toHaveBeenCalled();
    expect(smoke.maybeRun).not.toHaveBeenCalled();
    expect(deployLag.maybeRun).not.toHaveBeenCalled();
    expect(deployConvergence.maybeRun).not.toHaveBeenCalled();
  });

  test('startup fire does not skip the first on-grid hourly tick (cadence)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-18T04:00:00.000Z'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const intervalMs = 60 * 60 * 1000;
    let lastRunAtMs = Number.NEGATIVE_INFINITY;
    const maybeRun = vi.fn(async (opts?: { ignoreCadence?: boolean }) => {
      const now = Date.now();
      if (!opts?.ignoreCadence && now - lastRunAtMs < intervalMs - 1_000) return null;
      if (!opts?.ignoreCadence) lastRunAtMs = now;
      return 'ran';
    });
    const smoke = {
      hostIntervalMs: intervalMs,
      alertArtifactPath: '/tmp/data/prod-smoke-tick-alert.json',
      maybeRun,
    };
    const handles = startLifecycleTimers(baseTimerDeps({ prodSmokeTick: smoke }) as any);
    try {
      await vi.advanceTimersByTimeAsync(HOURLY_SAFETY_NET_STARTUP_DELAY_MS);
      expect(maybeRun).toHaveBeenCalledTimes(1);
      expect(maybeRun).toHaveBeenLastCalledWith({ ignoreCadence: true });
      await expect(maybeRun.mock.results[0]?.value).resolves.toBe('ran');

      await vi.advanceTimersByTimeAsync(intervalMs - HOURLY_SAFETY_NET_STARTUP_DELAY_MS);
      expect(maybeRun).toHaveBeenCalledTimes(2);
      expect(maybeRun.mock.calls[1]?.[0]).toBeUndefined();
      await expect(maybeRun.mock.results[1]?.value).resolves.toBe('ran');
    } finally {
      clearAllTimers(handles);
    }
  });

  test('skips the hourly startup fire when the event loop is overloaded', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const recordPause = vi.fn();
    const smoke = {
      hostIntervalMs: 60 * 60 * 1000,
      alertArtifactPath: '/tmp/data/prod-smoke-tick-alert.json',
      maybeRun: vi.fn(async () => null),
    };
    const handles = startLifecycleTimers(baseTimerDeps({
      prodSmokeTick: smoke,
      nonCriticalTickPause: {
        shouldSkipTick: () => true,
        recordPause,
      },
    }) as any);
    try {
      await vi.advanceTimersByTimeAsync(HOURLY_SAFETY_NET_STARTUP_DELAY_MS);
      expect(smoke.maybeRun).not.toHaveBeenCalled();
      expect(recordPause).toHaveBeenCalledWith('prodSmokeTick');
    } finally {
      clearAllTimers(handles);
    }
  });

  test('stamps last-fired on the existing relay-orphan and host-stale startup reclaim', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-18T04:00:00.000Z'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const timerHealth = new TimerHealthTracker(() => Date.now());
    const relayRun = vi.fn(async () => undefined);
    const hostSweep = vi.fn(async () => undefined);
    const handles = startLifecycleTimers(baseTimerDeps({
      timerHealth,
      relayOrphanSweep: { intervalHours: 1, run: relayRun },
      hostStaleDtachReaper: { intervalMinutes: 5, service: { runSweep: hostSweep } },
    }) as any);
    try {
      expect(handles.relayOrphanSweepStartupTimer).not.toBeNull();
      expect(handles.hostStaleDtachReapStartupTimer).not.toBeNull();

      await vi.advanceTimersByTimeAsync(RELAY_ORPHAN_SWEEP_STARTUP_DELAY_MS);
      expect(relayRun).toHaveBeenCalledTimes(1);
      expect(hostSweep).not.toHaveBeenCalled();
      expect(
        timerHealth.snapshot().loops.find((loop) => loop.name === 'relayOrphanSweep')?.lastFiredAt,
      ).toBe('2026-08-18T04:00:30.000Z');

      await vi.advanceTimersByTimeAsync(
        HOST_STALE_DTACH_REAP_STARTUP_DELAY_MS - RELAY_ORPHAN_SWEEP_STARTUP_DELAY_MS,
      );
      expect(hostSweep).toHaveBeenCalledTimes(1);
      expect(
        timerHealth.snapshot().loops.find((loop) => loop.name === 'hostStaleDtachReap')?.lastFiredAt,
      ).toBe('2026-08-18T04:00:45.000Z');
    } finally {
      clearAllTimers(handles);
    }
  });
});

describe('startLifecycleTimers timer-health stamps (issue #1771)', () => {
  test('registers always-on loops and stamps lastFiredAt on each tick', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-01T16:00:00.000Z'));
    const timerHealth = new TimerHealthTracker(() => Date.now());
    const handles = startLifecycleTimers({
      monitor: {
        getSnapshot: () => [],
        getAgentEvents: () => [],
        applyWatchdogVerdict: vi.fn(() => false),
        sampleFindingEvidence: vi.fn(() => false),
        getCurrentAnomaly: vi.fn(),
      } as any,
      taskStore: new TaskStore(),
      queue: new AttentionQueue(),
      adapter: { captureDisplay: vi.fn(async () => '') } as any,
      adapterRegistry: {} as any,
      tokenTracker: {
        scanGrowth: vi.fn(async () => []),
        scanAll: vi.fn(async () => undefined),
        getTrackedTaskIds: vi.fn(() => []),
        getUsage: vi.fn(() => undefined),
      } as any,
      watchdog: {
        getTrackedAgents: vi.fn(() => []),
        recordTokenActivity: vi.fn(),
        tick: vi.fn(),
      } as any,
      hookWatcher: { drainNow: vi.fn(async () => undefined) } as any,
      terminalBackend: { listSessions: vi.fn(async () => []) } as any,
      hooksDir: '/tmp/hooks',
      tasksFile: '/tmp/tasks.json',
      serverCwd: '/tmp/repo',
      saveIntervalMs: 30_000,
      livenessIntervalMs: 15_000,
      broadcastToAll: vi.fn(),
      timerHealth,
    });

    try {
      const atStart = timerHealth.snapshot();
      const names = atStart.loops.map((l) => l.name).sort();
      expect(names).toEqual([
        'liveness',
        'save',
        'snoozeExpiry',
        'tokenScan',
        'watchdog',
      ]);
      for (const loop of atStart.loops) {
        expect(loop.lastFiredAt).toBeNull();
        expect(loop.overdue).toBe(false);
      }
      expect(atStart.loops.find((l) => l.name === 'tokenScan')?.expectedIntervalMs)
        .toBe(TOKEN_SCAN_INTERVAL_MS);
      expect(atStart.loops.find((l) => l.name === 'watchdog')?.expectedIntervalMs)
        .toBe(WATCHDOG_INTERVAL_MS);
      expect(atStart.loops.find((l) => l.name === 'snoozeExpiry')?.expectedIntervalMs)
        .toBe(SNOOZE_EXPIRY_INTERVAL_MS);
      expect(atStart.loops.find((l) => l.name === 'save')?.expectedIntervalMs).toBe(30_000);
      expect(atStart.loops.find((l) => l.name === 'liveness')?.expectedIntervalMs).toBe(15_000);

      await vi.advanceTimersByTimeAsync(TOKEN_SCAN_INTERVAL_MS);
      const afterTick = timerHealth.snapshot();
      for (const name of ['tokenScan', 'watchdog', 'snoozeExpiry'] as const) {
        const entry = afterTick.loops.find((l) => l.name === name);
        expect(entry?.lastFiredAt).not.toBeNull();
        expect(entry?.overdue).toBe(false);
      }
      // save / liveness intervals not reached yet
      expect(afterTick.loops.find((l) => l.name === 'save')?.lastFiredAt).toBeNull();
      expect(afterTick.loops.find((l) => l.name === 'liveness')?.lastFiredAt).toBeNull();
    } finally {
      clearAllTimers(handles);
    }
  });

  test('omitting timerHealth does not change timer behavior', async () => {
    vi.useFakeTimers();
    const scanGrowth = vi.fn(async () => []);
    const handles = startLifecycleTimers({
      monitor: {
        getSnapshot: () => [],
        getAgentEvents: () => [],
        applyWatchdogVerdict: vi.fn(() => false),
        sampleFindingEvidence: vi.fn(() => false),
        getCurrentAnomaly: vi.fn(),
      } as any,
      taskStore: new TaskStore(),
      queue: new AttentionQueue(),
      adapter: { captureDisplay: vi.fn(async () => '') } as any,
      adapterRegistry: {} as any,
      tokenTracker: {
        scanGrowth,
        scanAll: vi.fn(async () => undefined),
        getTrackedTaskIds: vi.fn(() => []),
        getUsage: vi.fn(() => undefined),
      } as any,
      watchdog: {
        getTrackedAgents: vi.fn(() => []),
        recordTokenActivity: vi.fn(),
        tick: vi.fn(),
      } as any,
      hookWatcher: { drainNow: vi.fn(async () => undefined) } as any,
      terminalBackend: { listSessions: vi.fn(async () => []) } as any,
      hooksDir: '/tmp/hooks',
      tasksFile: '/tmp/tasks.json',
      serverCwd: '/tmp/repo',
      saveIntervalMs: 600_000,
      livenessIntervalMs: 600_000,
      broadcastToAll: vi.fn(),
    });
    try {
      await vi.advanceTimersByTimeAsync(TOKEN_SCAN_INTERVAL_MS);
      expect(scanGrowth).toHaveBeenCalledTimes(1);
    } finally {
      clearAllTimers(handles);
    }
  });
});

describe('reap-warning grace phase (RFC rfc-reap-grace-warning.md)', () => {
  const REAP_THRESHOLD_MS = 3 * 60 * 60 * 1000;
  const GRACE_MS = 120_000;
  const NOW = Date.parse('2026-06-21T00:00:00.000Z');

  function makeHungTask(taskStore: TaskStore, agentId: string): Task {
    const task = taskStore.createTask({ prompt: 'Hung agent', cwd: '/tmp' });
    taskStore.addSession(task.id, {
      tmuxSession: agentId,
      agentType: 'claude-code',
      cwd: '/tmp',
      createdAt: new Date(NOW - 2 * REAP_THRESHOLD_MS),
    });
    return taskStore.getTask(task.id)!;
  }

  function makeSilentWatchdog(agentId: string, ageMs: number): Watchdog {
    const watchdog = new Watchdog();
    const lastActivityAt = NOW - ageMs;
    watchdog.registerAgent(agentId, lastActivityAt, lastActivityAt);
    return watchdog;
  }

  function timerDeps(coordinator: ReapWarningCoordinator, overrides: Partial<TimerDeps> = {}): TimerDeps {
    return {
      monitor: { getAgentEvents: vi.fn(() => []) } as any,
      taskStore: {} as any,
      queue: {} as any,
      adapter: {} as any,
      adapterRegistry: { get: vi.fn() } as any,
      tokenTracker: {} as any,
      watchdog: new Watchdog(),
      hookWatcher: {} as any,
      terminalBackend: {} as any,
      hooksDir: '/tmp/hooks',
      tasksFile: '/tmp/tasks.json',
      serverCwd: '/tmp/repo',
      saveIntervalMs: 60_000,
      livenessIntervalMs: 60_000,
      broadcastToAll: vi.fn(),
      reapWarningCoordinator: coordinator,
      getHungTaskReapMs: () => REAP_THRESHOLD_MS,
      getHungTaskReapGraceMs: () => GRACE_MS,
      ...overrides,
    };
  }

  function lifecycleDeps(taskStore: TaskStore) {
    return {
      adapter: { stop: vi.fn(async () => undefined) },
      monitor: { unregisterAgent: vi.fn(), getAgentEvents: vi.fn(() => []) },
      taskStore,
      queue: new AttentionQueue(),
      hookWatcher: { stop: vi.fn() },
      watchdog: { unregisterAgent: vi.fn() },
    } as any;
  }

  test('warns instead of reaping on the first eligible tick', async () => {
    const taskStore = new TaskStore();
    const agentId = 'kookr-warn-1';
    const task = makeHungTask(taskStore, agentId);
    const watchdog = makeSilentWatchdog(agentId, REAP_THRESHOLD_MS + 1);
    const coordinator = new ReapWarningCoordinator();

    const changed = await maybeReapHungTask(
      agentId, 'frozen pane',
      timerDeps(coordinator, { watchdog }),
      taskStore, lifecycleDeps(taskStore),
      () => new Date(NOW),
    );

    expect(changed).toBe(true); // a warning was raised → broadcast
    expect(taskStore.getTask(task.id)?.status).toBe('inProgress'); // NOT reaped
    expect(coordinator.getWarning(task.id)).toBeDefined();
  });

  test('reaps once the grace deadline passes', async () => {
    const taskStore = new TaskStore();
    const agentId = 'kookr-warn-2';
    const task = makeHungTask(taskStore, agentId);
    const watchdog = makeSilentWatchdog(agentId, REAP_THRESHOLD_MS + 1);
    const coordinator = new ReapWarningCoordinator();
    const deps = timerDeps(coordinator, { watchdog });

    await maybeReapHungTask(agentId, 'pane', deps, taskStore, lifecycleDeps(taskStore), () => new Date(NOW));
    expect(taskStore.getTask(task.id)?.status).toBe('inProgress');

    const reaped = await maybeReapHungTask(
      agentId, 'pane', deps, taskStore, lifecycleDeps(taskStore),
      () => new Date(NOW + GRACE_MS + 1),
    );
    expect(reaped).toBe(true);
    expect(taskStore.getTask(task.id)?.status).toBe('terminated');
    expect(coordinator.getWarning(task.id)).toBeUndefined();
  });

  test('presence auto-hold prevents the reap at the deadline while the task is selected', async () => {
    const taskStore = new TaskStore();
    const agentId = 'kookr-warn-3';
    const task = makeHungTask(taskStore, agentId);
    const watchdog = makeSilentWatchdog(agentId, REAP_THRESHOLD_MS + 1);
    const coordinator = new ReapWarningCoordinator();
    const deps = timerDeps(coordinator, {
      watchdog,
      isTaskSelectedByAnyConnection: (id) => id === task.id,
    });

    await maybeReapHungTask(agentId, 'pane', deps, taskStore, lifecycleDeps(taskStore), () => new Date(NOW));
    const reaped = await maybeReapHungTask(
      agentId, 'pane', deps, taskStore, lifecycleDeps(taskStore),
      () => new Date(NOW + GRACE_MS + 1),
    );
    expect(reaped).toBe(false);
    expect(taskStore.getTask(task.id)?.status).toBe('inProgress');
    expect(coordinator.getWarning(task.id)?.heldByPresence).toBe(true);
  });

  test('warned phase disabled → immediate reap (independent kill switch)', async () => {
    const taskStore = new TaskStore();
    const agentId = 'kookr-warn-4';
    const task = makeHungTask(taskStore, agentId);
    const watchdog = makeSilentWatchdog(agentId, REAP_THRESHOLD_MS + 1);
    const coordinator = new ReapWarningCoordinator();

    const reaped = await maybeReapHungTask(
      agentId, 'pane',
      timerDeps(coordinator, { watchdog, getHungTaskReapWarningEnabled: () => false }),
      taskStore, lifecycleDeps(taskStore),
      () => new Date(NOW),
    );
    expect(reaped).toBe(true);
    expect(taskStore.getTask(task.id)?.status).toBe('terminated');
    expect(coordinator.getWarning(task.id)).toBeUndefined();
  });

  test('maintenance clears a warning once the task recovers (no longer eligible)', async () => {
    const taskStore = new TaskStore();
    const agentId = 'kookr-warn-5';
    const task = makeHungTask(taskStore, agentId);
    const watchdog = makeSilentWatchdog(agentId, REAP_THRESHOLD_MS + 1);
    const coordinator = new ReapWarningCoordinator();
    const deps = timerDeps(coordinator, { watchdog });

    await maybeReapHungTask(agentId, 'pane', deps, taskStore, lifecycleDeps(taskStore), () => new Date(NOW));
    expect(coordinator.getWarning(task.id)).toBeDefined();

    // User acts → a liveness channel advances → no longer reap-eligible.
    watchdog.recordTokenActivity(agentId, NOW + 1_000);
    const changed = await runReapWarningMaintenance(
      { ...deps, watchdog }, taskStore, () => new Date(NOW + 2_000),
    );
    expect(changed).toBe(true);
    expect(coordinator.getWarning(task.id)).toBeUndefined(); // recovered
    expect(taskStore.getTask(task.id)?.status).toBe('inProgress');
  });

  test('maintenance clears a warning when its task left inProgress (gone)', async () => {
    const taskStore = new TaskStore();
    const agentId = 'kookr-warn-gone';
    const task = makeHungTask(taskStore, agentId);
    const watchdog = makeSilentWatchdog(agentId, REAP_THRESHOLD_MS + 1);
    const coordinator = new ReapWarningCoordinator();
    const deps = timerDeps(coordinator, { watchdog });

    await maybeReapHungTask(agentId, 'pane', deps, taskStore, lifecycleDeps(taskStore), () => new Date(NOW));
    expect(coordinator.getWarning(task.id)).toBeDefined();

    // Task terminated by another path → no longer inProgress.
    taskStore.terminateTask(task.id);
    const changed = await runReapWarningMaintenance({ ...deps, watchdog }, taskStore, () => new Date(NOW + 1_000));
    expect(changed).toBe(true);
    expect(coordinator.getWarning(task.id)).toBeUndefined();
  });

  test('maintenance self-heals a warning stuck past its deadline with no reap (stale)', async () => {
    const taskStore = new TaskStore();
    const agentId = 'kookr-warn-stale';
    const task = makeHungTask(taskStore, agentId);
    const watchdog = makeSilentWatchdog(agentId, REAP_THRESHOLD_MS + 1);
    const coordinator = new ReapWarningCoordinator();
    const deps = timerDeps(coordinator, { watchdog });

    await maybeReapHungTask(agentId, 'pane', deps, taskStore, lifecycleDeps(taskStore), () => new Date(NOW));
    // Still eligible (silent) and still inProgress, but the reaper stopped
    // firing; maintenance clears it once past deadline + the stuck window.
    const past = NOW + GRACE_MS + REAP_WARNING_STUCK_CLEAR_MS + 1;
    const changed = await runReapWarningMaintenance({ ...deps, watchdog }, taskStore, () => new Date(past));
    expect(changed).toBe(true);
    expect(coordinator.getWarning(task.id)).toBeUndefined();
    expect(taskStore.getTask(task.id)?.status).toBe('inProgress'); // never reaped by maintenance
  });

  test('maintenance applies the presence hold to a still-eligible warned task', async () => {
    const taskStore = new TaskStore();
    const agentId = 'kookr-warn-present';
    const task = makeHungTask(taskStore, agentId);
    const watchdog = makeSilentWatchdog(agentId, REAP_THRESHOLD_MS + 1);
    const coordinator = new ReapWarningCoordinator();
    const deps = timerDeps(coordinator, {
      watchdog,
      isTaskSelectedByAnyConnection: (id) => id === task.id,
    });

    await maybeReapHungTask(agentId, 'pane', deps, taskStore, lifecycleDeps(taskStore), () => new Date(NOW));
    const before = coordinator.getWarning(task.id)!.deadlineAt;
    // A later maintenance tick while the task is selected pushes the deadline.
    await runReapWarningMaintenance({ ...deps, watchdog }, taskStore, () => new Date(NOW + 5 * 60_000));
    const held = coordinator.getWarning(task.id)!;
    expect(held.heldByPresence).toBe(true);
    expect(held.deadlineAt).toBeGreaterThan(before);
  });

  test('maintenance clears all warnings when the warned phase is disabled at runtime', async () => {
    const taskStore = new TaskStore();
    const agentId = 'kookr-warn-6';
    const task = makeHungTask(taskStore, agentId);
    const watchdog = makeSilentWatchdog(agentId, REAP_THRESHOLD_MS + 1);
    const coordinator = new ReapWarningCoordinator();

    await maybeReapHungTask(
      agentId, 'pane', timerDeps(coordinator, { watchdog }), taskStore,
      lifecycleDeps(taskStore), () => new Date(NOW),
    );
    expect(coordinator.activeWarningCount()).toBe(1);

    const changed = await runReapWarningMaintenance(
      { reapWarningCoordinator: coordinator, watchdog, getHungTaskReapWarningEnabled: () => false },
      taskStore, () => new Date(NOW),
    );
    expect(changed).toBe(true);
    expect(coordinator.activeWarningCount()).toBe(0);
  });
});

describe('startLifecycleTimers systemd watchdog wiring (issue #2491)', () => {
  // The production property under test: the liveness tick pings the systemd
  // watchdog on EVERY delivered timer, and does so BEFORE the re-entrancy guard,
  // so a still-running reconcile can never starve the watchdog and bounce a
  // healthy server. A regression that dropped the ping — or moved it back below
  // the `livenessTickRunning` guard — would fail these tests.
  function makeWatchdogDeps(overrides: Partial<TimerDeps> = {}): {
    deps: TimerDeps;
    systemdNotifier: { ready: ReturnType<typeof vi.fn>; watchdog: ReturnType<typeof vi.fn> };
  } {
    const systemdNotifier = {
      enabled: true,
      watchdogEnabled: true,
      watchdogIntervalMs: 15_000,
      ready: vi.fn(),
      watchdog: vi.fn(),
    };
    const deps: TimerDeps = {
      monitor: {
        getSnapshot: () => [],
        getAgentEvents: () => [],
        applyWatchdogVerdict: vi.fn(() => false),
        sampleFindingEvidence: vi.fn(() => false),
        getCurrentAnomaly: vi.fn(),
        unregisterAgent: vi.fn(),
      } as any,
      taskStore: new TaskStore(),
      queue: new AttentionQueue(),
      adapter: { captureDisplay: vi.fn(async () => ''), stop: vi.fn(async () => undefined) } as any,
      adapterRegistry: {} as any,
      tokenTracker: {
        scanGrowth: vi.fn(async () => []),
        scanAll: vi.fn(async () => undefined),
        getTrackedTaskIds: vi.fn(() => []),
        getUsage: vi.fn(() => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 })),
      } as any,
      watchdog: { getTrackedAgents: vi.fn(() => []), recordTokenActivity: vi.fn(), tick: vi.fn() } as any,
      hookWatcher: { drainNow: vi.fn(async () => undefined) } as any,
      terminalBackend: { listSessions: vi.fn(async () => []) } as any,
      hooksDir: '/tmp/hooks',
      tasksFile: '/tmp/tasks.json',
      serverCwd: '/tmp/repo',
      saveIntervalMs: 3_600_000,
      livenessIntervalMs: 5_000,
      broadcastToAll: vi.fn(),
      systemdNotifier: systemdNotifier as any,
      ...overrides,
    };
    return { deps, systemdNotifier };
  }

  test('pings the watchdog on each liveness tick', async () => {
    vi.useFakeTimers();
    const { deps, systemdNotifier } = makeWatchdogDeps();
    const handles = startLifecycleTimers(deps);
    try {
      await vi.advanceTimersByTimeAsync(5_000);
      expect(systemdNotifier.watchdog).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(systemdNotifier.watchdog).toHaveBeenCalledTimes(2);
    } finally {
      clearAllTimers(handles);
      vi.useRealTimers();
    }
  });

  test('keeps pinging while a prior tick is still in flight (before the re-entrancy guard)', async () => {
    vi.useFakeTimers();
    // Wedge the first tick's reconcile on a never-resolving worktree refresh so
    // `livenessTickRunning` stays true and every later fire bails at the guard.
    const refresh = vi.fn(() => new Promise<void>(() => {}));
    const { deps, systemdNotifier } = makeWatchdogDeps({
      worktreeRegistry: { refresh } as any,
      worktreeRegistryRepoPath: '/tmp/repo',
      getDashboardClientCount: () => 1,
    });
    const handles = startLifecycleTimers(deps);
    try {
      await vi.advanceTimersByTimeAsync(15_000); // three 5s fires
      // Reconcile body was entered exactly once (it is stuck), but the watchdog
      // was pinged on all three fires — the ping is decoupled from the guard.
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(systemdNotifier.watchdog).toHaveBeenCalledTimes(3);
    } finally {
      clearAllTimers(handles);
      vi.useRealTimers();
    }
  });
});
