import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  loadOutcomeScoreboardPrefs,
  saveOutcomeScoreboardPrefs,
  OUTCOME_SCOREBOARD_PREFS_KEY,
} from './outcome-scoreboard-prefs.js';

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

describe('outcome-scoreboard-prefs', () => {
  let storage: ReturnType<typeof fakeStorage>;

  beforeEach(() => {
    storage = fakeStorage();
    vi.stubGlobal('localStorage', storage.impl);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('load/save', () => {
    test('returns null fields when unset', () => {
      expect(loadOutcomeScoreboardPrefs()).toEqual({ window: null, project: null });
    });

    test('round-trips a window and project choice', () => {
      expect(saveOutcomeScoreboardPrefs({ window: '30d', project: 'assigned:org/repo' })).toBeNull();
      expect(JSON.parse(storage.map.get(OUTCOME_SCOREBOARD_PREFS_KEY)!)).toEqual({
        window: '30d',
        project: 'assigned:org/repo',
      });
      expect(loadOutcomeScoreboardPrefs()).toEqual({ window: '30d', project: 'assigned:org/repo' });
    });

    test('round-trips the sentinel scopes', () => {
      expect(saveOutcomeScoreboardPrefs({ window: 'all', project: 'unassigned' })).toBeNull();
      expect(loadOutcomeScoreboardPrefs()).toEqual({ window: 'all', project: 'unassigned' });
    });

    test('preserves an arbitrary stored project string (staleness is the panel guard)', () => {
      // A project that no longer exists still round-trips here; the panel's own
      // reset guard is what drops it, not the store.
      storage.map.set(
        OUTCOME_SCOREBOARD_PREFS_KEY,
        JSON.stringify({ window: '7d', project: 'assigned:deleted/repo' }),
      );
      expect(loadOutcomeScoreboardPrefs()).toEqual({ window: '7d', project: 'assigned:deleted/repo' });
    });

    test('falls back to null for a non-JSON stored value', () => {
      storage.map.set(OUTCOME_SCOREBOARD_PREFS_KEY, 'not-json{');
      expect(loadOutcomeScoreboardPrefs()).toEqual({ window: null, project: null });
    });

    test('falls back to null for a non-object stored value', () => {
      storage.map.set(OUTCOME_SCOREBOARD_PREFS_KEY, '"7d"');
      expect(loadOutcomeScoreboardPrefs()).toEqual({ window: null, project: null });
    });

    test('ignores an array stored value', () => {
      storage.map.set(OUTCOME_SCOREBOARD_PREFS_KEY, '["7d","all"]');
      expect(loadOutcomeScoreboardPrefs()).toEqual({ window: null, project: null });
    });

    test('rejects a window that is not a known TimeWindow but keeps a valid project', () => {
      storage.map.set(
        OUTCOME_SCOREBOARD_PREFS_KEY,
        JSON.stringify({ window: '90d', project: 'unassigned' }),
      );
      expect(loadOutcomeScoreboardPrefs()).toEqual({ window: null, project: 'unassigned' });
    });

    test('rejects a non-string project but keeps a valid window', () => {
      storage.map.set(
        OUTCOME_SCOREBOARD_PREFS_KEY,
        JSON.stringify({ window: '24h', project: 42 }),
      );
      expect(loadOutcomeScoreboardPrefs()).toEqual({ window: '24h', project: null });
    });

    test('tolerates a partial object (missing fields become null)', () => {
      storage.map.set(OUTCOME_SCOREBOARD_PREFS_KEY, JSON.stringify({ window: '7d' }));
      expect(loadOutcomeScoreboardPrefs()).toEqual({ window: '7d', project: null });
    });

    test('returns an Error when localStorage is unavailable', () => {
      expect(saveOutcomeScoreboardPrefs({ window: '7d', project: 'all' }, null)).toBeInstanceOf(Error);
    });

    test('returns the error when the storage write throws', () => {
      const throwing: Pick<Storage, 'setItem'> = {
        setItem: () => { throw new Error('quota exceeded'); },
      };
      const result = saveOutcomeScoreboardPrefs({ window: '7d', project: 'all' }, throwing);
      expect(result).toBeInstanceOf(Error);
      expect(result?.message).toBe('quota exceeded');
    });
  });
});
