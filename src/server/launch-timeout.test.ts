import { describe, expect, test, vi } from 'vitest';
import {
  isLaunchTimeoutError,
  noteLaunchSession,
  raceLaunchAgainstTimeout,
  type LaunchReapGuard,
} from './launch-timeout.js';

describe('raceLaunchAgainstTimeout', () => {
  test('stops a session that settles after the timeout', async () => {
    let resolveLaunch!: (sessionId: string) => void;
    const launch = new Promise<string>((resolve) => { resolveLaunch = resolve; });
    const stop = vi.fn().mockResolvedValue(undefined);

    await expect(raceLaunchAgainstTimeout(launch, 5, {
      taskId: 'task-timeout',
      agentType: 'claude-code',
      adapter: { stop },
    })).rejects.toSatisfy(isLaunchTimeoutError);

    resolveLaunch('late-session');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stop).toHaveBeenCalledWith('late-session');
  });

  test('preserves an adapter rejection that arrives before the timeout', async () => {
    const error = new Error('adapter failed');
    await expect(raceLaunchAgainstTimeout(Promise.reject(error), 50, {
      taskId: 'task-failed',
      agentType: 'claude-code',
      adapter: { stop: vi.fn() },
    })).rejects.toBe(error);
  });

  test('does not mark a timeout cleanup reaped before physical stop succeeds', async () => {
    const guard: LaunchReapGuard = { reaped: false };
    let rejectStop!: (error: Error) => void;
    const stop = vi.fn(async () => {
      await new Promise<void>((_resolve, reject) => { rejectStop = reject; });
    });
    noteLaunchSession(guard, { stop }, 'claude-code', 'task-cleanup-fence', 'probe-session');

    await expect(raceLaunchAgainstTimeout(new Promise<string>(() => undefined), 5, {
      taskId: 'task-cleanup-fence',
      agentType: 'claude-code',
      adapter: { stop },
      reapGuard: guard,
      reapKnownSessionOnTimeout: true,
    })).rejects.toSatisfy(isLaunchTimeoutError);

    expect(stop).toHaveBeenCalledWith('probe-session');
    expect(guard.reaped).toBe(false);
    rejectStop(new Error('physical stop rejected'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(guard.reaped).toBe(false);
  });
});
