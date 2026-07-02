import { describe, test, expect } from 'vitest';
import {
  MIN_BOTTOM_SECTIONS_HEIGHT,
  MAX_BOTTOM_SECTIONS_HEIGHT,
  BOTTOM_SECTIONS_HEIGHT_KEY,
  clampBottomSectionsHeight,
  loadBottomSectionsHeight,
  saveBottomSectionsHeight,
  clearBottomSectionsHeight,
} from './bottom-sections-height-prefs.js';

/** Minimal in-memory Storage stub covering the surface these helpers use. */
function makeStorage(initial: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => { map.set(k, v); },
    removeItem: (k: string) => { map.delete(k); },
    get size() { return map.size; },
  };
}

describe('clampBottomSectionsHeight', () => {
  test('keeps an in-range value (rounded)', () => {
    expect(clampBottomSectionsHeight(240.4)).toBe(240);
  });

  test('floors at the minimum', () => {
    expect(clampBottomSectionsHeight(10)).toBe(MIN_BOTTOM_SECTIONS_HEIGHT);
  });

  test('caps at the hard maximum', () => {
    expect(clampBottomSectionsHeight(99999)).toBe(MAX_BOTTOM_SECTIONS_HEIGHT);
  });

  test('caps at a tighter live maxAvailable', () => {
    expect(clampBottomSectionsHeight(500, 300)).toBe(300);
  });

  test('never drops below the minimum even when maxAvailable is tiny', () => {
    // A cramped panel must still yield at least the minimum, not a sub-min or
    // negative height.
    expect(clampBottomSectionsHeight(500, 10)).toBe(MIN_BOTTOM_SECTIONS_HEIGHT);
  });

  test('non-finite input falls back to the minimum', () => {
    expect(clampBottomSectionsHeight(Number.NaN)).toBe(MIN_BOTTOM_SECTIONS_HEIGHT);
  });
});

describe('load/save/clear', () => {
  test('load returns null when unset', () => {
    expect(loadBottomSectionsHeight(makeStorage())).toBeNull();
  });

  test('round-trips a clamped value', () => {
    const storage = makeStorage();
    expect(saveBottomSectionsHeight(240, storage)).toBeNull();
    expect(storage.getItem(BOTTOM_SECTIONS_HEIGHT_KEY)).toBe('240');
    expect(loadBottomSectionsHeight(storage)).toBe(240);
  });

  test('save clamps out-of-range values before persisting', () => {
    const storage = makeStorage();
    saveBottomSectionsHeight(5, storage);
    expect(loadBottomSectionsHeight(storage)).toBe(MIN_BOTTOM_SECTIONS_HEIGHT);
  });

  test('load ignores a malformed value', () => {
    expect(loadBottomSectionsHeight(makeStorage({ [BOTTOM_SECTIONS_HEIGHT_KEY]: 'not-a-number' }))).toBeNull();
  });

  test('load returns null (not a throw) when storage is unavailable', () => {
    expect(loadBottomSectionsHeight(null)).toBeNull();
  });

  test('clear removes the stored value', () => {
    const storage = makeStorage({ [BOTTOM_SECTIONS_HEIGHT_KEY]: '240' });
    clearBottomSectionsHeight(storage);
    expect(loadBottomSectionsHeight(storage)).toBeNull();
  });
});
