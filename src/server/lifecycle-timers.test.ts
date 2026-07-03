import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  autoCloseStaleCompletionReadyTasks,
  clearAllTimers,
  findFirstActiveSession,
  restoreExpiredSnoozes,
  runBudgetCheck,
  runPersistenceSaveTick,
  runProgressBudgetBurnDiagnosticSample,
  startLifecycleTimers,
} from './lifecycle-timers.js';
import { BudgetChecker } from '../core/budget-checker.js';
import type { Task } from '../core/tasks.js';
import { TaskStore } from '../core/tasks.js';
import { AttentionQueue } from '../core/attention-queue.js';
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
