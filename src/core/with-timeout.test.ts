import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { withTimeout } from './with-timeout.js';

describe('withTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('resolves with the promise value when it settles before the deadline', async () => {
    const resultPromise = withTimeout(Promise.resolve('ok'), 1_000, 'fallback');

    await expect(resultPromise).resolves.toBe('ok');
  });

  test('returns fallback when the deadline fires first', async () => {
    let resolveSlow!: (value: string) => void;
    const slow = new Promise<string>((resolve) => {
      resolveSlow = resolve;
    });

    const resultPromise = withTimeout(slow, 500, 'timed-out');

    await vi.advanceTimersByTimeAsync(500);

    await expect(resultPromise).resolves.toBe('timed-out');

    // Late settlement must not change the already-resolved fallback result.
    resolveSlow('late');
    await expect(resultPromise).resolves.toBe('timed-out');
  });

  test('propagates promise rejection instead of converting to fallback', async () => {
    const err = new Error('boom');
    let rejectPromise!: (reason: unknown) => void;
    const failing = new Promise<string>((_, reject) => {
      rejectPromise = reject;
    });

    const resultPromise = withTimeout(failing, 1_000, 'fallback');
    // Reject after the race is wired so the rejection is not unhandled.
    rejectPromise(err);

    await expect(resultPromise).rejects.toBe(err);
  });

  test('clears the deadline timer when the promise wins so no open handles remain', async () => {
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    try {
      const resultPromise = withTimeout(Promise.resolve(42), 5_000, 0);
      await expect(resultPromise).resolves.toBe(42);

      expect(clearSpy).toHaveBeenCalled();
      // After clearTimeout in finally, the fake-timer queue should be empty.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      clearSpy.mockRestore();
    }
  });

  test('clears the deadline timer after timeout fires', async () => {
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    try {
      const never = new Promise<string>(() => {});

      const resultPromise = withTimeout(never, 200, 'fallback');
      await vi.advanceTimersByTimeAsync(200);

      await expect(resultPromise).resolves.toBe('fallback');
      expect(clearSpy).toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      clearSpy.mockRestore();
    }
  });

  test('unref path does not throw under Node', async () => {
    // Wrap Node Timeout.unref so we assert the helper actually calls it.
    const unrefSpy = vi.fn();
    const originalSetTimeout = globalThis.setTimeout;
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((
      handler: Parameters<typeof setTimeout>[0],
      timeout?: number,
      ...args: unknown[]
    ) => {
      const handle = originalSetTimeout(handler, timeout, ...(args as []));
      if (handle && typeof (handle as { unref?: () => void }).unref === 'function') {
        const originalUnref = (handle as { unref: () => unknown }).unref.bind(handle);
        (handle as { unref: () => unknown }).unref = () => {
          unrefSpy();
          return originalUnref();
        };
      }
      return handle;
    });

    try {
      const never = new Promise<string>(() => {});
      const resultPromise = withTimeout(never, 100, 'fallback');

      // unref is invoked synchronously when the timeout promise is constructed.
      expect(unrefSpy).toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(100);
      await expect(resultPromise).resolves.toBe('fallback');
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });
});
