// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  __resetProjectNotificationMuteForTests,
  getProjectNotificationMuteState,
  isProjectNotificationMuted,
  muteProjectNotifications,
  toggleProjectNotificationMute,
  unmuteProjectNotifications,
} from './useProjectNotificationMute.js';

let store: Map<string, string>;

beforeEach(() => {
  store = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear(),
  });
  vi.useRealTimers();
  __resetProjectNotificationMuteForTests();
});

afterEach(() => {
  vi.useRealTimers();
  store.clear();
  __resetProjectNotificationMuteForTests();
  vi.unstubAllGlobals();
});

describe('project notification mute', () => {
  test('starts without muted projects', () => {
    expect(getProjectNotificationMuteState()).toEqual({});
    expect(isProjectNotificationMuted('github.com/kookr-ai/kookr')).toBe(false);
  });

  test('mutes and unmutes one project without affecting another', () => {
    muteProjectNotifications('github.com/kookr-ai/kookr');

    expect(isProjectNotificationMuted('github.com/kookr-ai/kookr')).toBe(true);
    expect(isProjectNotificationMuted('github.com/kookr-ai/other')).toBe(false);

    unmuteProjectNotifications('github.com/kookr-ai/kookr');

    expect(isProjectNotificationMuted('github.com/kookr-ai/kookr')).toBe(false);
    expect(store.has('kookr-project-notification-mutes')).toBe(false);
  });

  test('persists mutes across reloads', () => {
    muteProjectNotifications('github.com/kookr-ai/kookr');

    __resetProjectNotificationMuteForTests();

    expect(isProjectNotificationMuted('github.com/kookr-ai/kookr')).toBe(true);
    expect(JSON.parse(store.get('kookr-project-notification-mutes') ?? '{}')).toEqual({
      'github.com/kookr-ai/kookr': { mutedUntil: null },
    });
  });

  test('timed mutes expire and clear storage', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T08:00:00.000Z'));

    muteProjectNotifications('github.com/kookr-ai/kookr', 60_000);
    expect(isProjectNotificationMuted('github.com/kookr-ai/kookr')).toBe(true);

    vi.advanceTimersByTime(60_001);

    expect(isProjectNotificationMuted('github.com/kookr-ai/kookr')).toBe(false);
    expect(store.has('kookr-project-notification-mutes')).toBe(false);
  });

  test('expired stored mutes are dropped on read', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T08:00:00.000Z'));
    store.set('kookr-project-notification-mutes', JSON.stringify({
      'github.com/kookr-ai/kookr': { mutedUntil: Date.now() - 1 },
      'github.com/kookr-ai/active': { mutedUntil: null },
    }));

    __resetProjectNotificationMuteForTests();

    expect(isProjectNotificationMuted('github.com/kookr-ai/kookr')).toBe(false);
    expect(isProjectNotificationMuted('github.com/kookr-ai/active')).toBe(true);
    expect(JSON.parse(store.get('kookr-project-notification-mutes') ?? '{}')).toEqual({
      'github.com/kookr-ai/active': { mutedUntil: null },
    });
  });

  test('toggle returns the new muted state', () => {
    expect(toggleProjectNotificationMute('github.com/kookr-ai/kookr')).toBe(true);
    expect(isProjectNotificationMuted('github.com/kookr-ai/kookr')).toBe(true);

    expect(toggleProjectNotificationMute('github.com/kookr-ai/kookr')).toBe(false);
    expect(isProjectNotificationMuted('github.com/kookr-ai/kookr')).toBe(false);
  });

  test('storage event from another tab refreshes mutes', () => {
    store.set('kookr-project-notification-mutes', JSON.stringify({
      'github.com/kookr-ai/kookr': { mutedUntil: null },
    }));

    window.dispatchEvent(new StorageEvent('storage', { key: 'kookr-project-notification-mutes' }));

    expect(isProjectNotificationMuted('github.com/kookr-ai/kookr')).toBe(true);
  });
});
