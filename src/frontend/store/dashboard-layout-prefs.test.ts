import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  clampFindingsWidth,
  loadFindingsWidth,
  saveFindingsWidth,
  DASHBOARD_SPLIT_KEY,
  MIN_FINDINGS_WIDTH,
  MAX_FINDINGS_WIDTH,
} from './dashboard-layout-prefs.js';

function fakeStorage(data?: Map<string, string>) {
  const storage = data ?? new Map<string, string>();
  return {
    map: storage,
    impl: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    } as Pick<Storage, 'getItem' | 'setItem'>,
  };
}

describe('dashboard-layout-prefs', () => {
  let storage: ReturnType<typeof fakeStorage>;

  beforeEach(() => {
    storage = fakeStorage();
    vi.stubGlobal('localStorage', storage.impl);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('clampFindingsWidth', () => {
    test('keeps an in-range value', () => {
      expect(clampFindingsWidth(420)).toBe(420);
    });

    test('clamps below the minimum', () => {
      expect(clampFindingsWidth(10)).toBe(MIN_FINDINGS_WIDTH);
    });

    test('clamps above the maximum', () => {
      expect(clampFindingsWidth(5000)).toBe(MAX_FINDINGS_WIDTH);
    });

    test('respects a tighter live container bound', () => {
      expect(clampFindingsWidth(700, 500)).toBe(500);
    });

    test('never returns below the minimum even with a tiny container', () => {
      expect(clampFindingsWidth(700, 100)).toBe(MIN_FINDINGS_WIDTH);
    });

    test('rounds fractional widths', () => {
      expect(clampFindingsWidth(380.6)).toBe(381);
    });

    test('falls back to the minimum for non-finite input', () => {
      expect(clampFindingsWidth(Number.NaN)).toBe(MIN_FINDINGS_WIDTH);
    });
  });

  describe('load/save', () => {
    test('returns null when unset', () => {
      expect(loadFindingsWidth()).toBeNull();
    });

    test('round-trips a clamped width', () => {
      expect(saveFindingsWidth(450)).toBeNull();
      expect(storage.map.get(DASHBOARD_SPLIT_KEY)).toBe('450');
      expect(loadFindingsWidth()).toBe(450);
    });

    test('clamps an out-of-range stored value on load', () => {
      storage.map.set(DASHBOARD_SPLIT_KEY, '99999');
      expect(loadFindingsWidth()).toBe(MAX_FINDINGS_WIDTH);
    });

    test('returns null for a non-numeric stored value', () => {
      storage.map.set(DASHBOARD_SPLIT_KEY, 'not-a-number');
      expect(loadFindingsWidth()).toBeNull();
    });

    test('persists clamped value rather than the raw request', () => {
      expect(saveFindingsWidth(5)).toBeNull();
      expect(storage.map.get(DASHBOARD_SPLIT_KEY)).toBe(String(MIN_FINDINGS_WIDTH));
    });

    test('returns the error when the storage write throws', () => {
      const throwing: Pick<Storage, 'setItem'> = {
        setItem: () => { throw new Error('quota exceeded'); },
      };
      const result = saveFindingsWidth(420, throwing);
      expect(result).toBeInstanceOf(Error);
      expect(result?.message).toBe('quota exceeded');
    });
  });
});
