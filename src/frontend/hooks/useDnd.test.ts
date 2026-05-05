// @vitest-environment jsdom

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  __resetDndForTests,
  disableDnd,
  enableDnd,
  getDndState,
  isDndEnabled,
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
