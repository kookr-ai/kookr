import { describe, expect, test, vi } from 'vitest';
import {
  isLaunchTimeoutError,
  noteLaunchSession,
  raceLaunchAgainstTimeout,
  reapAbandonedLaunchSession,
  reapLaunchSession,
  type LaunchReapGuard,
} from './launch-timeout.js';

/** Flush microtasks so fire-and-forget `.then` continuations run. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

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

  test('aborts the shared controller when the timeout fires', async () => {
    const abort = new AbortController();
    await expect(raceLaunchAgainstTimeout(new Promise<string>(() => undefined), 5, {
      taskId: 'task-abort',
      agentType: 'claude-code',
      adapter: { stop: vi.fn() },
      abort,
    })).rejects.toSatisfy(isLaunchTimeoutError);
    expect(abort.signal.aborted).toBe(true);
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

describe('reapAbandonedLaunchSession', () => {
  const bookkeeping = () => {
    const events: string[] = [];
    return {
      events,
      hooks: {
        link: () => { events.push('link'); },
        markAborted: () => { events.push('markAborted'); },
        beforeReap: () => { events.push('beforeReap'); },
        onLinkError: (_sid: string, err: unknown) => {
          events.push(`onLinkError:${err instanceof Error ? err.message : String(err)}`);
        },
        onReaped: () => { events.push('onReaped'); },
        onReapFailed: (_sid: string, err: unknown) => {
          events.push(`onReapFailed:${err instanceof Error ? err.message : String(err)}`);
        },
      },
    };
  };

  test('links immediately but marks aborted only after the shared stop resolves', async () => {
    const guard: LaunchReapGuard = { reaped: false };
    let resolveStop!: () => void;
    const stop = vi.fn(() => new Promise<void>((resolve) => { resolveStop = resolve; }));
    const { events, hooks } = bookkeeping();

    reapAbandonedLaunchSession(guard, { stop }, 'claude-code', 'task-own', 'sess', hooks);

    // Link + intent line run synchronously, before the physical stop is awaited.
    expect(events).toEqual(['link', 'beforeReap']);
    expect(stop).toHaveBeenCalledWith('sess');

    await tick();
    // Stop still pending: the session stays unresolved (never marked aborted).
    expect(events).toEqual(['link', 'beforeReap']);
    expect(guard.reaped).toBe(false);

    resolveStop();
    await tick();
    expect(events).toEqual(['link', 'beforeReap', 'markAborted', 'onReaped']);
    expect(guard.reaped).toBe(true);
  });

  test('keeps the session unresolved and runs onReapFailed when the stop rejects', async () => {
    const guard: LaunchReapGuard = { reaped: false };
    const stop = vi.fn().mockRejectedValue(new Error('stop rejected'));
    const { events, hooks } = bookkeeping();

    reapAbandonedLaunchSession(guard, { stop }, 'claude-code', 'task-fail', 'sess', hooks);
    await tick();

    expect(events).toEqual(['link', 'beforeReap', 'onReapFailed:stop rejected']);
    expect(events).not.toContain('markAborted');
    expect(events).not.toContain('onReaped');
    expect(guard.reaped).toBe(false);
  });

  test('shares one physical stop with a reap already started via the guard', async () => {
    const guard: LaunchReapGuard = { reaped: false, timedOut: true };
    const stop = vi.fn().mockResolvedValue(undefined);
    const { events, hooks } = bookkeeping();

    // Late-creation path: noteLaunchSession starts the shared stop first.
    noteLaunchSession(guard, { stop }, 'claude-code', 'task-dedup', 'sess');
    // Late-resolution path: the owner re-derives the same promise from the guard.
    reapAbandonedLaunchSession(guard, { stop }, 'claude-code', 'task-dedup', 'sess', hooks);
    await tick();

    expect(stop).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['link', 'beforeReap', 'markAborted', 'onReaped']);
  });

  test('routes a link failure to onLinkError and still reaps', async () => {
    const guard: LaunchReapGuard = { reaped: false };
    const stop = vi.fn().mockResolvedValue(undefined);
    const { events, hooks } = bookkeeping();
    hooks.link = () => { throw new Error('record failed'); };

    reapAbandonedLaunchSession(guard, { stop }, 'claude-code', 'task-linkerr', 'sess', hooks);
    await tick();

    expect(stop).toHaveBeenCalledWith('sess');
    expect(events).toEqual([
      'onLinkError:record failed',
      'beforeReap',
      'markAborted',
      'onReaped',
    ]);
  });

  test('a concurrent purge dropping markAborted still runs onReaped after a proven stop', async () => {
    const guard: LaunchReapGuard = { reaped: false };
    const stop = vi.fn().mockResolvedValue(undefined);
    const { events, hooks } = bookkeeping();
    hooks.markAborted = () => { throw new Error('task purged'); };

    reapAbandonedLaunchSession(guard, { stop }, 'claude-code', 'task-purge', 'sess', hooks);
    await tick();

    // markAborted threw (session already gone), but the proven stop still audits.
    expect(events).toEqual(['link', 'beforeReap', 'onReaped']);
    expect(guard.reaped).toBe(true);
  });

  test('does not double-stop when the shared guard already reaped', async () => {
    const guard: LaunchReapGuard = { reaped: true };
    const stop = vi.fn().mockResolvedValue(undefined);
    const { events, hooks } = bookkeeping();

    reapAbandonedLaunchSession(guard, { stop }, 'claude-code', 'task-already', 'sess', hooks);
    await tick();

    expect(stop).not.toHaveBeenCalled();
    expect(events).toEqual(['link', 'beforeReap', 'markAborted', 'onReaped']);
  });

  test('passes the reported session id to every bookkeeping hook', async () => {
    const guard: LaunchReapGuard = { reaped: false };
    const stop = vi.fn().mockResolvedValue(undefined);
    const link = vi.fn();
    const markAborted = vi.fn();
    const beforeReap = vi.fn();
    const onReaped = vi.fn();

    reapAbandonedLaunchSession(guard, { stop }, 'claude-code', 'task-id-arg', 'session-x', {
      link, markAborted, beforeReap, onReaped,
    });
    await tick();

    expect(link).toHaveBeenCalledWith('session-x');
    expect(beforeReap).toHaveBeenCalledWith('session-x');
    expect(markAborted).toHaveBeenCalledWith('session-x');
    expect(onReaped).toHaveBeenCalledWith('session-x');
  });
});

describe('reapLaunchSession sharing (common stop guard)', () => {
  test('a late creation and a late resolution share one physical stop', async () => {
    const guard: LaunchReapGuard = { reaped: false };
    const stop = vi.fn().mockResolvedValue(undefined);

    const first = reapLaunchSession(guard, { stop }, 'claude-code', 'task-share', 'sess');
    const second = reapLaunchSession(guard, { stop }, 'claude-code', 'task-share', 'sess');

    await Promise.all([first, second]);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(guard.reaped).toBe(true);
  });

  test('a shared rejected stop is attempted once and never marks reaped', async () => {
    const guard: LaunchReapGuard = { reaped: false };
    const stop = vi.fn().mockRejectedValue(new Error('stop rejected'));

    const first = reapLaunchSession(guard, { stop }, 'claude-code', 'task-share-rej', 'sess');
    const second = reapLaunchSession(guard, { stop }, 'claude-code', 'task-share-rej', 'sess');

    await expect(first).rejects.toThrow('stop rejected');
    await expect(second).rejects.toThrow('stop rejected');
    expect(stop).toHaveBeenCalledTimes(1);
    expect(guard.reaped).toBe(false);
  });
});
