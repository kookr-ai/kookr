import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  LOG_LEVELS,
  getLogLevel,
  getLogLevelState,
  isDebugEnabled,
  isLevelEnabled,
  isLogLevel,
  resetLogLevel,
  setLogLevel,
} from './runtime-log-level.js';

const DAY_SECONDS = 24 * 60 * 60;

describe('runtime-log-level', () => {
  beforeEach(() => {
    delete process.env.KOOKR_DEBUG;
    resetLogLevel();
  });

  afterEach(() => {
    delete process.env.KOOKR_DEBUG;
    vi.useRealTimers();
    resetLogLevel();
  });

  test('isLogLevel accepts the known levels and rejects everything else', () => {
    for (const level of LOG_LEVELS) expect(isLogLevel(level)).toBe(true);
    for (const bad of ['verbose', 'DEBUG', '', undefined, null, 3, {}]) {
      expect(isLogLevel(bad)).toBe(false);
    }
  });

  test('isLevelEnabled ranks levels from least to most verbose', () => {
    setLogLevel('warn');
    expect(isLevelEnabled('error')).toBe(true);
    expect(isLevelEnabled('warn')).toBe(true);
    expect(isLevelEnabled('info')).toBe(false);
    expect(isLevelEnabled('debug')).toBe(false);

    setLogLevel('debug');
    expect(LOG_LEVELS.every((l) => isLevelEnabled(l))).toBe(true);
    expect(isDebugEnabled()).toBe(true);

    setLogLevel('error');
    expect(isLevelEnabled('error')).toBe(true);
    expect(isLevelEnabled('warn')).toBe(false);
    expect(isDebugEnabled()).toBe(false);
  });

  test('default level is seeded from KOOKR_DEBUG and reverts target it', () => {
    expect(getLogLevelState().default).toBe('info');

    process.env.KOOKR_DEBUG = 'yes';
    resetLogLevel();
    expect(getLogLevelState()).toMatchObject({ level: 'debug', default: 'debug' });
  });

  test('setLogLevel rejects invalid levels and leaves state untouched', () => {
    expect(setLogLevel('verbose')).toEqual({ ok: false, error: 'invalid-level' });
    expect(getLogLevel()).toBe('info');
  });

  test('setLogLevel rejects sub-second, zero, negative, and non-finite ttls', () => {
    for (const ttl of [0, 0.5, -1, Number.NaN, Number.POSITIVE_INFINITY, '60' as unknown]) {
      expect(setLogLevel('debug', ttl)).toEqual({ ok: false, error: 'invalid-ttl' });
      expect(getLogLevel()).toBe('info'); // never partially applied
    }
  });

  test('a ttl is floored to whole seconds and clamped to one day', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-04T00:00:00.000Z'));
    const now = Date.now();

    expect(setLogLevel('debug', 90.9)).toEqual({ ok: true });
    expect(getLogLevelState().ttlExpiresAt).toBe(now + 90 * 1000);

    expect(setLogLevel('debug', DAY_SECONDS * 10)).toEqual({ ok: true });
    expect(getLogLevelState().ttlExpiresAt).toBe(now + DAY_SECONDS * 1000);
  });

  test('a sticky (no-ttl) change never auto-reverts', () => {
    vi.useFakeTimers();
    setLogLevel('debug');
    expect(getLogLevelState().ttlExpiresAt).toBeNull();
    vi.advanceTimersByTime(DAY_SECONDS * 1000 * 2);
    expect(getLogLevel()).toBe('debug');
  });

  test('the revert timer restores the default when the ttl elapses', () => {
    vi.useFakeTimers();
    setLogLevel('debug', 30);
    expect(getLogLevel()).toBe('debug');
    vi.advanceTimersByTime(30 * 1000);
    expect(getLogLevel()).toBe('info');
    expect(getLogLevelState().ttlExpiresAt).toBeNull();
  });

  test('a read lazily expires a ttl even if the timer never fired', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-04T00:00:00.000Z'));
    setLogLevel('debug', 60);
    expect(getLogLevel()).toBe('debug');

    // Advance the wall clock past expiry WITHOUT running pending timers, so the
    // setTimeout callback hasn't fired — exercises the maybeExpire() backstop.
    vi.setSystemTime(new Date('2026-06-04T00:02:00.000Z'));
    expect(getLogLevel()).toBe('info');
    expect(getLogLevelState().ttlExpiresAt).toBeNull();
  });

  test('setting a new ttl clears the prior revert timer', () => {
    vi.useFakeTimers();
    setLogLevel('debug', 30);
    setLogLevel('warn', 120); // supersedes the first timer
    vi.advanceTimersByTime(30 * 1000);
    // If the stale 30s timer still fired it would revert to the default here.
    expect(getLogLevel()).toBe('warn');
    vi.advanceTimersByTime(90 * 1000);
    expect(getLogLevel()).toBe('info');
  });
});
