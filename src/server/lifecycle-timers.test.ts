import { describe, expect, test, vi } from 'vitest';
import {
  findFirstActiveSession,
  restoreExpiredSnoozes,
  runBudgetCheck,
  runProgressBudgetBurnDiagnosticSample,
} from './lifecycle-timers.js';
import { BudgetChecker } from '../core/budget-checker.js';
import type { Task } from '../core/tasks.js';
import { TaskStore } from '../core/tasks.js';
import { AttentionQueue } from '../core/attention-queue.js';
import type { Anomaly } from '../core/types.js';
import type { ProgressBudgetBurnDiagnostics } from '../core/progress-budget-burn-diagnostics.js';

function makeAnomaly(agentId: string): Anomaly {
  return {
    agentId,
    type: 'needs_input',
    severity: 'info',
    explanation: 'Agent needs input',
    detectedAt: new Date('2026-04-15T00:00:00Z'),
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    prompt: 'do something',
    cwd: '/tmp',
    agentType: 'claude-code',
    status: 'inProgress',
    createdAt: new Date('2026-04-15T00:00:00Z'),
    updatedAt: new Date('2026-04-15T00:00:00Z'),
    sessions: [
      {
        tmuxSession: 'agent-1',
        agentType: 'claude-code',
        cwd: '/tmp',
        createdAt: new Date('2026-04-15T00:00:00Z'),
        lastStatus: 'running',
      },
    ],
    ...overrides,
  };
}

describe('runBudgetCheck', () => {
  test('enqueues a budget_exceeded anomaly on the first active session', () => {
    const checker = new BudgetChecker(5);
    const enqueue = vi.fn();
    const task = makeTask();

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
    expect(runBudgetCheck(makeTask(), 4.99, checker, enqueue)).toBe(false);
    expect(enqueue).not.toHaveBeenCalled();
  });

  test('does nothing when budget checker is undefined', () => {
    const enqueue = vi.fn();
    expect(runBudgetCheck(makeTask(), 100, undefined, enqueue)).toBe(false);
    expect(enqueue).not.toHaveBeenCalled();
  });

  test('does nothing when threshold is disabled (<= 0)', () => {
    const checker = new BudgetChecker(0);
    const enqueue = vi.fn();
    expect(runBudgetCheck(makeTask(), 100, checker, enqueue)).toBe(false);
    expect(enqueue).not.toHaveBeenCalled();
  });

  test('does nothing when all sessions are completed or aborted', () => {
    const checker = new BudgetChecker(5);
    const enqueue = vi.fn();
    const task = makeTask({
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
    const task = makeTask({
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
    const task = makeTask({
      sessions: [
        { tmuxSession: 'agent-dead', agentType: 'claude-code', cwd: '/tmp', createdAt: new Date(), lastStatus: 'completed' },
        { tmuxSession: 'agent-live', agentType: 'claude-code', cwd: '/tmp', createdAt: new Date(), lastStatus: 'running' },
      ],
    });

    expect(findFirstActiveSession(task)?.tmuxSession).toBe('agent-live');
  });

  test('samples progress-aware budget diagnostics with events from the selected live session', () => {
    const task = makeTask({
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
    const task = makeTask();

    expect(runBudgetCheck(task, 5, checker, enqueue)).toBe(true);
    // Cost climbs but stays below 2x threshold — no new anomaly.
    expect(runBudgetCheck(task, 7, checker, enqueue)).toBe(false);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  test('fires critical on second crossing at 2x threshold', () => {
    const checker = new BudgetChecker(5);
    const enqueue = vi.fn();
    const task = makeTask();

    expect(runBudgetCheck(task, 6, checker, enqueue)).toBe(true);
    expect(enqueue.mock.calls[0][1].severity).toBe('warning');

    expect(runBudgetCheck(task, 11, checker, enqueue)).toBe(true);
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue.mock.calls[1][1].severity).toBe('critical');
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
