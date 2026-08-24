import { describe, it, expect, vi } from 'vitest';
import { aTask } from '../core/__fixtures__/task-builders.js';
import {
  createProviderTransientRetryHandler,
  createProviderTransientAlertHandler,
} from './provider-transient-retry.js';

const silentLogger = { warn: vi.fn(), log: vi.fn() };

function immediateTimer(cb: () => void): void {
  cb();
}

describe('createProviderTransientRetryHandler', () => {
  it('re-launches the original task as a schedule fire and stamps retry lineage', async () => {
    const original = aTask({
      id: 'orig',
      prompt: 'scout ideas',
      cwd: '/repo',
      criteria: 'file 1 issue',
      agentType: 'claude-code',
      metadata: { launchPins: { state: 'known-pinned', effort: 'high', model: 'claude-opus-4-8' } },
      provenance: { kind: 'schedule', sourceId: 'sched-lucy' },
    });
    const taskStore = { getTask: vi.fn().mockReturnValue(original), setRetryLineage: vi.fn() };
    const launchTask = vi.fn().mockResolvedValue({ task: aTask({ id: 'retry-1' }) });

    const handler = createProviderTransientRetryHandler({
      taskStore: taskStore as any,
      launchTask,
      setTimeoutFn: immediateTimer,
      logger: silentLogger,
    });

    handler({ originalTaskId: 'orig', failedTaskId: 'orig', attempt: 1, delayMs: 1000 });
    await vi.waitFor(() => expect(launchTask).toHaveBeenCalled());

    expect(launchTask).toHaveBeenCalledWith(expect.objectContaining({
      prompt: 'scout ideas',
      cwd: '/repo',
      criteria: 'file 1 issue',
      agentType: 'claude-code',
      effort: 'high',
      model: 'claude-opus-4-8',
      disableDedup: true,
      launchSource: 'schedule',
      scheduleId: 'sched-lucy',
    }));
    await vi.waitFor(() =>
      expect(taskStore.setRetryLineage).toHaveBeenCalledWith('retry-1', { retryOf: 'orig', retryAttempt: 1 }),
    );
  });

  it('skips when the original task is gone', () => {
    const taskStore = { getTask: vi.fn().mockReturnValue(undefined), setRetryLineage: vi.fn() };
    const launchTask = vi.fn();
    const handler = createProviderTransientRetryHandler({
      taskStore: taskStore as any,
      launchTask,
      setTimeoutFn: immediateTimer,
      logger: silentLogger,
    });

    handler({ originalTaskId: 'gone', failedTaskId: 'gone', attempt: 1, delayMs: 1000 });
    expect(launchTask).not.toHaveBeenCalled();
  });

  it('does not automatically retry unsafe legacy launch pins', () => {
    const original = aTask({
      id: 'orig',
      metadata: { launchPins: { version: 1, state: 'unknown' } },
      provenance: { kind: 'schedule', sourceId: 's1' },
    });
    const taskStore = { getTask: vi.fn().mockReturnValue(original), setRetryLineage: vi.fn() };
    const launchTask = vi.fn();
    const handler = createProviderTransientRetryHandler({
      taskStore: taskStore as any,
      launchTask,
      setTimeoutFn: immediateTimer,
      logger: silentLogger,
    });

    handler({ originalTaskId: 'orig', failedTaskId: 'orig', attempt: 1, delayMs: 0 });

    expect(launchTask).not.toHaveBeenCalled();
  });

  it('swallows a launch failure without throwing', async () => {
    const original = aTask({ id: 'orig', provenance: { kind: 'schedule', sourceId: 's1' } });
    const taskStore = { getTask: vi.fn().mockReturnValue(original), setRetryLineage: vi.fn() };
    const launchTask = vi.fn().mockRejectedValue(new Error('at capacity'));
    const warn = vi.fn();
    const handler = createProviderTransientRetryHandler({
      taskStore: taskStore as any,
      launchTask,
      setTimeoutFn: immediateTimer,
      logger: { warn, log: vi.fn() },
    });

    expect(() => handler({ originalTaskId: 'orig', failedTaskId: 'orig', attempt: 2, delayMs: 0 })).not.toThrow();
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    expect(taskStore.setRetryLineage).not.toHaveBeenCalled();
  });
});

describe('createProviderTransientAlertHandler', () => {
  it('enqueues one durable alert with lineage + attempt count', async () => {
    const enqueueAlert = vi.fn().mockResolvedValue(undefined);
    const handler = createProviderTransientAlertHandler({ enqueueAlert, logger: silentLogger });

    await handler({ failedTaskId: 'retry-2', originalTaskId: 'orig', attempts: 2, reason: 'API Error: 529 Overloaded' });

    expect(enqueueAlert).toHaveBeenCalledWith({
      taskId: 'retry-2',
      note: expect.stringContaining('orig'),
    });
    expect(enqueueAlert.mock.calls[0][0].note).toContain('2 auto-retries');
  });

  it('swallows an enqueue failure', async () => {
    const warn = vi.fn();
    const handler = createProviderTransientAlertHandler({
      enqueueAlert: vi.fn().mockRejectedValue(new Error('spool full')),
      logger: { warn },
    });
    await expect(
      handler({ failedTaskId: 'x', originalTaskId: 'orig', attempts: 1 }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});
