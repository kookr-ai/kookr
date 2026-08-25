import { describe, expect, test, vi } from 'vitest';
import {
  isLaunchTimeoutError,
  raceLaunchAgainstTimeout,
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
});
