import { describe, expect, test, vi, afterEach } from 'vitest';
import { AuthThrottle } from './auth-throttle.js';
import { resolveActor, resolveUpgradeIdentity, type ApiAuthConfig } from './auth.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('AuthThrottle', () => {
  test('applies exponential backoff after the free failures', () => {
    let now = 1_000;
    const throttle = new AuthThrottle({
      freeFailures: 2,
      baseBackoffMs: 100,
      maxBackoffMs: 500,
      nowMs: () => now,
      audit: () => {},
    });

    throttle.recordFailure('10.0.0.1', 'bad_token');
    throttle.recordFailure('10.0.0.1', 'bad_token');
    expect(throttle.isLockedOut('10.0.0.1')).toBe(false);

    throttle.recordFailure('10.0.0.1', 'bad_token');
    expect(throttle.snapshot().lockedOutSources[0]).toEqual(expect.objectContaining({
      source: '10.0.0.1',
      failures: 3,
      retryAfterMs: 100,
    }));

    now += 100;
    expect(throttle.isLockedOut('10.0.0.1')).toBe(false);
    throttle.recordFailure('10.0.0.1', 'bad_token');
    expect(throttle.snapshot().lockedOutSources).toEqual([]);
  });

  test('bounds source state with LRU eviction', () => {
    const throttle = new AuthThrottle({ freeFailures: 0, maxEntries: 2, audit: () => {} });

    throttle.recordFailure('a', 'bad_token');
    throttle.recordFailure('b', 'bad_token');
    throttle.recordFailure('a', 'bad_token');
    throttle.recordFailure('c', 'bad_token');

    const snapshot = throttle.snapshot();
    expect(snapshot.activeSourceCount).toBe(2);
    expect(snapshot.lockedOutSources.map((s) => s.source).sort()).toEqual(['a', 'c']);
  });

  test('logs one audit record per source burst window', () => {
    let now = 0;
    const audit = vi.fn();
    const throttle = new AuthThrottle({
      freeFailures: 1,
      baseBackoffMs: 20_000,
      auditBurstWindowMs: 10_000,
      nowMs: () => now,
      audit,
    });

    throttle.recordFailure('10.0.0.2', 'bad_token');
    throttle.recordFailure('10.0.0.2', 'bad_token');
    throttle.recordThrottledAttempt('10.0.0.2');
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      event: 'auth_failure_burst',
      source: '10.0.0.2',
      failures: 2,
      reason: 'bad_token',
    }));

    now += 10_001;
    throttle.recordThrottledAttempt('10.0.0.2');
    expect(audit).toHaveBeenCalledTimes(2);
  });

  test('reset clears a locked-out source after successful authentication', () => {
    const throttle = new AuthThrottle({ freeFailures: 0, audit: () => {} });
    throttle.recordFailure('10.0.0.3', 'bad_token');
    expect(throttle.isLockedOut('10.0.0.3')).toBe(true);

    throttle.reset('10.0.0.3');
    expect(throttle.snapshot()).toEqual(expect.objectContaining({
      activeSourceCount: 0,
      lockedOutSources: [],
    }));
  });

  test('expires old failure state after the backoff or failure window passes', () => {
    let now = 0;
    const throttle = new AuthThrottle({
      freeFailures: 1,
      baseBackoffMs: 100,
      failureWindowMs: 500,
      nowMs: () => now,
      audit: () => {},
    });

    throttle.recordFailure('10.0.0.5', 'bad_token');
    now += 501;
    throttle.recordFailure('10.0.0.5', 'bad_token');
    expect(throttle.snapshot().lockedOutSources).toEqual([]);

    throttle.recordFailure('10.0.0.5', 'bad_token');
    expect(throttle.snapshot().lockedOutSources[0]).toEqual(expect.objectContaining({
      source: '10.0.0.5',
      failures: 2,
      retryAfterMs: 100,
    }));

    now += 100;
    throttle.recordFailure('10.0.0.5', 'bad_token');
    expect(throttle.snapshot().lockedOutSources).toEqual([]);
  });
});

describe('auth throttle integration', () => {
  test('plain production auth config lazily creates and enforces the default throttle', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const config: ApiAuthConfig = { required: true, token: 'secret' };
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    for (let i = 0; i < 6; i += 1) {
      expect(resolveActor(config, { authorization: 'Bearer nope', remoteAddr: '10.0.0.6' })).toBeNull();
    }
    expect(config.authThrottle?.snapshot()).toEqual(expect.objectContaining({
      totalFailedAttempts: 6,
      lockedOutSources: [expect.objectContaining({ source: '10.0.0.6' })],
    }));
    expect(resolveActor(config, { authorization: 'Bearer secret', remoteAddr: '10.0.0.6' })).toBeNull();

    vi.advanceTimersByTime(1_000);
    expect(resolveActor(config, { authorization: 'Bearer secret', remoteAddr: '10.0.0.6' })).toEqual({ kind: 'owner' });
    expect(config.authThrottle?.snapshot().activeSourceCount).toBe(0);
  });

  test('the same ApiAuthConfig throttles HTTP resolution and WS upgrade resolution', () => {
    let now = 0;
    const config: ApiAuthConfig = {
      required: true,
      token: 'secret',
      authThrottle: new AuthThrottle({
        freeFailures: 1,
        baseBackoffMs: 1_000,
        nowMs: () => now,
        audit: () => {},
      }),
    };
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(resolveActor(config, { authorization: 'Bearer nope', remoteAddr: '10.0.0.4' })).toBeNull();
    expect(resolveActor(config, { authorization: 'Bearer nope', remoteAddr: '10.0.0.4' })).toBeNull();

    expect(
      resolveUpgradeIdentity(config, {
        headers: { authorization: 'Bearer secret' },
        socket: { remoteAddress: '10.0.0.4' },
      }),
    ).toBeNull();

    now += 1_000;
    expect(
      resolveUpgradeIdentity(config, {
        headers: { authorization: 'Bearer secret' },
        socket: { remoteAddress: '10.0.0.4' },
      }),
    ).toEqual({ kind: 'owner' });
    expect(config.authThrottle?.snapshot().activeSourceCount).toBe(0);
  });

  test('valid viewer credentials do not reset owner-token failure state', () => {
    const config: ApiAuthConfig = {
      required: true,
      token: 'secret',
      authThrottle: new AuthThrottle({
        freeFailures: 1,
        baseBackoffMs: 1_000,
        audit: () => {},
      }),
      resolveViewer: (token) =>
        token === 'viewer-token'
          ? { kind: 'valid', grantId: 'g1', scope: { kind: 'all' } }
          : { kind: 'not-found' },
    };
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(resolveActor(config, { authorization: 'Bearer nope', remoteAddr: '10.0.0.7' })).toBeNull();
    expect(resolveActor(config, { authorization: 'Bearer viewer-token', remoteAddr: '10.0.0.7' })).toEqual({
      kind: 'viewer',
      grantId: 'g1',
      scope: { kind: 'all' },
    });
    expect(resolveActor(config, { authorization: 'Bearer nope', remoteAddr: '10.0.0.7' })).toBeNull();
    expect(config.authThrottle?.isLockedOut('10.0.0.7')).toBe(true);
  });
});
