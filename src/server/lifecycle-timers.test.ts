import { describe, expect, test, vi } from 'vitest';
import { runBudgetCheck } from './lifecycle-timers.js';
import { BudgetChecker } from '../core/budget-checker.js';
import type { Task } from '../core/tasks.js';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    prompt: 'do something',
    cwd: '/tmp',
    agentType: 'claude-code',
    status: 'inProgress',
    autonomy: 'supervised',
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
