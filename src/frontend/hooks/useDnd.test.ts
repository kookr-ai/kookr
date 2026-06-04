// @vitest-environment jsdom

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  __resetDndForTests,
  disableDnd,
  enableDnd,
  getDndState,
  isDndEnabled,
  isQuietHoursActive,
  setQuietHoursWindows,
} from './useDnd.js';

let store: Map<string, string>;

beforeEach(() => {
  store = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear(),
  });
  __resetDndForTests();
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
  disableDnd();
  __resetDndForTests();
});

describe('DND state', () => {
  test('starts disabled', () => {
    expect(isDndEnabled()).toBe(false);
    expect(getDndState().enabled).toBe(false);
    expect(getDndState().startedAt).toBeNull();
    expect(getDndState().expiresAt).toBeNull();
  });

  test('enableDnd() turns DND on indefinitely when no duration given', () => {
    enableDnd();
    expect(isDndEnabled()).toBe(true);
    expect(getDndState().expiresAt).toBeNull();
    expect(getDndState().startedAt).not.toBeNull();
  });

  test('enableDnd(durationMs) sets an expiration timestamp', () => {
    const before = Date.now();
    enableDnd(60_000);
    const after = Date.now();
    const state = getDndState();
    expect(state.enabled).toBe(true);
    expect(state.expiresAt).not.toBeNull();
    expect(state.expiresAt!).toBeGreaterThanOrEqual(before + 60_000);
    expect(state.expiresAt!).toBeLessThanOrEqual(after + 60_000);
  });

  test('disableDnd() clears state', () => {
    enableDnd(60_000);
    disableDnd();
    expect(isDndEnabled()).toBe(false);
    expect(getDndState().startedAt).toBeNull();
    expect(getDndState().expiresAt).toBeNull();
  });

  test('persists across reload via localStorage', () => {
    enableDnd();
    expect(store.get('kookr-dnd-enabled')).toBe('true');
    expect(store.get('kookr-dnd-started-at')).toBeDefined();
    expect(store.has('kookr-dnd-expires-at')).toBe(false);

    __resetDndForTests();

    expect(isDndEnabled()).toBe(true);
  });

  test('expired DND in localStorage is cleared on read', () => {
    store.set('kookr-dnd-enabled', 'true');
    store.set('kookr-dnd-started-at', String(Date.now() - 120_000));
    store.set('kookr-dnd-expires-at', String(Date.now() - 60_000));

    __resetDndForTests();

    expect(isDndEnabled()).toBe(false);
    expect(store.has('kookr-dnd-enabled')).toBe(false);
  });

  test('auto-disables after duration via setTimeout', () => {
    vi.useFakeTimers();
    enableDnd(60_000);
    expect(isDndEnabled()).toBe(true);
    vi.advanceTimersByTime(59_000);
    expect(isDndEnabled()).toBe(true);
    vi.advanceTimersByTime(2_000);
    expect(isDndEnabled()).toBe(false);
  });

  test('toggling on then setting a new duration replaces the old expiration', () => {
    vi.useFakeTimers();
    enableDnd(60_000);
    vi.advanceTimersByTime(10_000);
    enableDnd(120_000);
    vi.advanceTimersByTime(60_000);
    expect(isDndEnabled()).toBe(true);
    vi.advanceTimersByTime(70_000);
    expect(isDndEnabled()).toBe(false);
  });

  test('disable cancels pending auto-disable timer', () => {
    vi.useFakeTimers();
    enableDnd(60_000);
    disableDnd();
    expect(isDndEnabled()).toBe(false);
    vi.advanceTimersByTime(120_000);
    expect(isDndEnabled()).toBe(false);
  });

  test('durations beyond int32 do not silently misfire', () => {
    vi.useFakeTimers();
    // 30 days exceeds setTimeout's int32 cap (~24.8 days). Without the
    // re-arm/clamp logic, the timer would fire after ~1ms (truncated delay).
    enableDnd(30 * 24 * 60 * 60_000);
    expect(isDndEnabled()).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(isDndEnabled()).toBe(true);
    vi.advanceTimersByTime(2_147_483_647);
    expect(isDndEnabled()).toBe(true);
  });

  test('write failures do not crash the caller', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {
        throw new Error('QuotaExceededError');
      },
      clear: () => {},
    });
    __resetDndForTests();
    expect(() => enableDnd(60_000)).not.toThrow();
    expect(isDndEnabled()).toBe(true);
  });

  test('storage event from another tab updates this tab', () => {
    expect(isDndEnabled()).toBe(false);
    // Simulate another tab writing the keys directly, then dispatching a `storage` event.
    store.set('kookr-dnd-enabled', 'true');
    store.set('kookr-dnd-started-at', String(Date.now()));
    window.dispatchEvent(new StorageEvent('storage', { key: 'kookr-dnd-enabled' }));
    expect(isDndEnabled()).toBe(true);
  });

  test('storage event for unrelated key is ignored', () => {
    enableDnd();
    expect(isDndEnabled()).toBe(true);
    window.dispatchEvent(new StorageEvent('storage', { key: 'unrelated-key' }));
    expect(isDndEnabled()).toBe(true);
  });
});

describe('quiet hours', () => {
  // Inside the 22:00–08:00 window; Jan 5 2026 is a Monday.
  const INSIDE = new Date(2026, 0, 5, 23, 0);
  const OUTSIDE = new Date(2026, 0, 5, 9, 0);
  const NIGHTLY = [{ start: '22:00', end: '08:00' }];

  afterEach(() => {
    setQuietHoursWindows([]);
  });

  test('an active window silences alerts via the effective DND gate', () => {
    vi.useFakeTimers();
    vi.setSystemTime(INSIDE);
    setQuietHoursWindows(NIGHTLY);
    expect(isQuietHoursActive()).toBe(true);
    expect(isDndEnabled()).toBe(true);
    expect(getDndState().source).toBe('quiet-hours');
  });

  test('alerts resume automatically once the window ends', () => {
    vi.useFakeTimers();
    vi.setSystemTime(INSIDE);
    setQuietHoursWindows(NIGHTLY);
    expect(isDndEnabled()).toBe(true);

    // Time advances past the window; the periodic re-evaluation flips it back.
    vi.setSystemTime(OUTSIDE);
    vi.advanceTimersByTime(60_000);
    expect(isDndEnabled()).toBe(false);
    expect(getDndState().source).toBe('off');
  });

  test('outside the window, DND stays off', () => {
    vi.useFakeTimers();
    vi.setSystemTime(OUTSIDE);
    setQuietHoursWindows(NIGHTLY);
    expect(isQuietHoursActive()).toBe(false);
    expect(isDndEnabled()).toBe(false);
  });

  test('manual DND takes precedence over an active window', () => {
    vi.useFakeTimers();
    vi.setSystemTime(INSIDE);
    setQuietHoursWindows(NIGHTLY);
    enableDnd();
    expect(getDndState().source).toBe('manual');

    // Turning manual DND off falls back to the still-active quiet-hours window.
    disableDnd();
    expect(getDndState().source).toBe('quiet-hours');
    expect(isDndEnabled()).toBe(true);
  });

  test('invalid windows are dropped before they take effect', () => {
    vi.useFakeTimers();
    vi.setSystemTime(INSIDE);
    setQuietHoursWindows([{ start: '99:99', end: '08:00' }]);
    expect(isDndEnabled()).toBe(false);
  });

  test('resumes exactly at the window end boundary (end is exclusive)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 5, 7, 59));
    setQuietHoursWindows(NIGHTLY);
    expect(isDndEnabled()).toBe(true);

    vi.setSystemTime(new Date(2026, 0, 5, 8, 0)); // exclusive end
    vi.advanceTimersByTime(60_000);
    expect(isDndEnabled()).toBe(false);
  });

  test('matches a later window when an earlier one in the list does not', () => {
    vi.useFakeTimers();
    vi.setSystemTime(INSIDE); // 23:00 — outside lunch, inside nightly
    setQuietHoursWindows([{ start: '12:00', end: '13:00' }, ...NIGHTLY]);
    expect(isDndEnabled()).toBe(true);
    expect(getDndState().source).toBe('quiet-hours');
  });

  test('a quiet-hours storage event from another tab is honored', () => {
    expect(isDndEnabled()).toBe(false);
    vi.useFakeTimers();
    vi.setSystemTime(INSIDE);
    // Another tab persisted a schedule; we only receive the storage event.
    store.set('kookr-quiet-hours', JSON.stringify(NIGHTLY));
    window.dispatchEvent(new StorageEvent('storage', { key: 'kookr-quiet-hours' }));
    expect(isDndEnabled()).toBe(true);
    expect(getDndState().source).toBe('quiet-hours');
  });
});
