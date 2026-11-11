import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  clampFindingsWidth,
  loadFindingsWidth,
  saveFindingsWidth,
  DASHBOARD_SPLIT_KEY,
  MIN_FINDINGS_WIDTH,
  MAX_FINDINGS_WIDTH,
  clampNavWidth,
  loadNavWidth,
  saveNavWidth,
  clearNavWidth,
  NAV_WIDTH_KEY,
  DEFAULT_NAV_WIDTH,
  MIN_NAV_WIDTH,
  MAX_NAV_WIDTH,
} from './dashboard-layout-prefs.js';

function fakeStorage(data?: Map<string, string>) {
  const storage = data ?? new Map<string, string>();
  return {
    map: storage,
    impl: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => { storage.delete(key); },
    } as Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
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

  describe('navigation width', () => {
    test('the default sits inside the bounds', () => {
      expect(DEFAULT_NAV_WIDTH).toBeGreaterThanOrEqual(MIN_NAV_WIDTH);
      expect(DEFAULT_NAV_WIDTH).toBeLessThanOrEqual(MAX_NAV_WIDTH);
    });

    test('clamps into the bounds and rounds', () => {
      expect(clampNavWidth(300.4)).toBe(300);
      expect(clampNavWidth(-5)).toBe(MIN_NAV_WIDTH);
      expect(clampNavWidth(0)).toBe(MIN_NAV_WIDTH);
      expect(clampNavWidth(99999)).toBe(MAX_NAV_WIDTH);
    });

    test('non-finite input gives the default, not an edge', () => {
      expect(clampNavWidth(Number.NaN)).toBe(DEFAULT_NAV_WIDTH);
      expect(clampNavWidth(Number.POSITIVE_INFINITY)).toBe(DEFAULT_NAV_WIDTH);
    });

    test('returns null when unset', () => {
      expect(loadNavWidth()).toBeNull();
    });

    test('round-trips a width', () => {
      expect(saveNavWidth(300)).toBeNull();
      expect(storage.map.get(NAV_WIDTH_KEY)).toBe('300');
      expect(loadNavWidth()).toBe(300);
    });

    test.each([
      ['99999', MAX_NAV_WIDTH],
      ['-5', MIN_NAV_WIDTH],
      ['0', MIN_NAV_WIDTH],
    ])('pulls the out-of-range stored value %s back into the bounds', (raw, expected) => {
      storage.map.set(NAV_WIDTH_KEY, raw);
      expect(loadNavWidth()).toBe(expected);
    });

    // The key only ever holds what saveNavWidth wrote: a plain integer. Anything
    // else is read the way parseInt reads it (leading digits only), and the
    // result is still clamped, so it stays usable whatever was meant.
    test.each([
      ['300px', 300],
      ['300.9', 300],
      ['1e9', MIN_NAV_WIDTH],
    ])('reads only the leading integer of the hand-edited value %s', (raw, expected) => {
      storage.map.set(NAV_WIDTH_KEY, raw);
      expect(loadNavWidth()).toBe(expected);
    });

    test.each(['abc', '', 'NaN', 'null', '{"width":300}'])(
      'treats the unreadable stored value %j as unset',
      (raw) => {
        storage.map.set(NAV_WIDTH_KEY, raw);
        expect(loadNavWidth()).toBeNull();
      },
    );

    test('returns null when reading storage throws', () => {
      const throwing: Pick<Storage, 'getItem'> = {
        getItem: () => { throw new Error('denied'); },
      };
      expect(loadNavWidth(throwing)).toBeNull();
    });

    test('persists the clamped value rather than the raw request', () => {
      expect(saveNavWidth(5)).toBeNull();
      expect(storage.map.get(NAV_WIDTH_KEY)).toBe(String(MIN_NAV_WIDTH));
    });

    test('clearing removes the key so the default applies again', () => {
      saveNavWidth(300);
      expect(clearNavWidth()).toBeNull();
      expect(storage.map.has(NAV_WIDTH_KEY)).toBe(false);
      expect(loadNavWidth()).toBeNull();
    });

    test('clearing leaves the findings width alone', () => {
      saveFindingsWidth(450);
      saveNavWidth(300);
      clearNavWidth();
      expect(loadFindingsWidth()).toBe(450);
    });

    test('returns the error when storage refuses the write or the removal', () => {
      const refuse = () => { throw new Error('quota exceeded'); };
      expect(saveNavWidth(300, { setItem: refuse })?.message).toBe('quota exceeded');
      expect(clearNavWidth({ removeItem: refuse })?.message).toBe('quota exceeded');
    });
  });
});
