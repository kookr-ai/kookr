import { describe, it, expect, vi } from 'vitest';
import { aTask } from '../core/__fixtures__/task-builders.js';
import {
  createProviderTransientRetryHandler,
  createProviderTransientAlertHandler,
} from './provider-transient-retry.js';
import { buildTaskLaunchIntent } from '../core/task-launch-intent.js';

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
      provenance: { kind: 'schedule', sourceId: 'sched-lucy' },
      launchIntent: {
        ...buildTaskLaunchIntent('claude-code'),
        prompt: 'original caller prompt',
        cwd: '/repo',
        agentType: 'claude-code',
        effort: 'max',
        model: 'claude-fable-5',
        ralphVerdictEnv: true,
        dependencies: ['kb'],
        idempotencyKey: 'stable-key',
      },
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
      prompt: 'original caller prompt',
      cwd: '/repo',
      criteria: 'file 1 issue',
      agentType: 'claude-code',
      effort: 'max',
      model: 'claude-fable-5',
      ralphVerdictEnv: true,
      dependencies: ['kb'],
      disableDedup: true,
      launchSource: 'schedule',
      scheduleId: 'sched-lucy',
    }));
    await vi.waitFor(() =>
      expect(taskStore.setRetryLineage).toHaveBeenCalledWith('retry-1', { retryOf: 'orig', retryAttempt: 1 }),
    );
  });

  it('preserves independent pins on an automatic provider retry', async () => {
    const original = aTask({
      id: 'orig-pinned',
      agentType: 'claude-code',
      provenance: { kind: 'schedule', sourceId: 'sched-pinned' },
      launchIntent: buildTaskLaunchIntent('claude-code', { model: 'model-a', effort: 'effort-b' }),
    });
    const taskStore = { getTask: vi.fn().mockReturnValue(original), setRetryLineage: vi.fn() };
    const launchTask = vi.fn().mockResolvedValue({ task: aTask({ id: 'retry-pinned' }) });
    const handler = createProviderTransientRetryHandler({
      taskStore: taskStore as any,
      launchTask,
      setTimeoutFn: immediateTimer,
      logger: silentLogger,
    });

    handler({ originalTaskId: 'orig-pinned', failedTaskId: 'orig-pinned', attempt: 1, delayMs: 0 });
    await vi.waitFor(() => expect(launchTask).toHaveBeenCalledWith(expect.objectContaining({
      model: 'model-a',
      effort: 'effort-b',
    })));
  });

  it('records a durable non-relaunch outcome for a legacy task', () => {
    const original = aTask({ id: 'legacy', provenance: { kind: 'schedule', sourceId: 's1' } });
    const setRelaunchDisposition = vi.fn();
    const taskStore = { getTask: vi.fn().mockReturnValue(original), setRetryLineage: vi.fn(), setRelaunchDisposition };
    const launchTask = vi.fn();
    const handler = createProviderTransientRetryHandler({
      taskStore: taskStore as any,
      launchTask,
      setTimeoutFn: immediateTimer,
      logger: silentLogger,
    });

    handler({ originalTaskId: 'legacy', failedTaskId: 'legacy', attempt: 1, delayMs: 0 });

    expect(launchTask).not.toHaveBeenCalled();
    expect(setRelaunchDisposition).toHaveBeenCalledWith('legacy', expect.objectContaining({
      outcome: 'not_relaunched',
      reason: 'missing_launch_intent',
      source: 'provider-transient-retry',
    }));
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

  it('swallows a launch failure without throwing', async () => {
    const original = aTask({
      id: 'orig',
      provenance: { kind: 'schedule', sourceId: 's1' },
      launchIntent: buildTaskLaunchIntent('claude-code'),
    });
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
