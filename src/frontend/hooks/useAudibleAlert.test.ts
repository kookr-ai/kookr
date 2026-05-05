import { describe, test, expect, beforeEach, vi } from 'vitest';
import { isSoundEnabled, setSoundEnabled } from './useAudibleAlert.js';

describe('audible alert utilities', () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
      clear: () => store.clear(),
    });
  });

  test('sound is enabled by default', () => {
    expect(isSoundEnabled()).toBe(true);
  });

  test('setSoundEnabled(false) disables sound', () => {
    setSoundEnabled(false);
    expect(isSoundEnabled()).toBe(false);
  });

  test('setSoundEnabled(true) re-enables sound', () => {
    setSoundEnabled(false);
    setSoundEnabled(true);
    expect(isSoundEnabled()).toBe(true);
  });

  test('persists to localStorage key kookr-sound-enabled', () => {
    setSoundEnabled(false);
    expect(store.get('kookr-sound-enabled')).toBe('false');
    setSoundEnabled(true);
    expect(store.get('kookr-sound-enabled')).toBe('true');
  });
});
