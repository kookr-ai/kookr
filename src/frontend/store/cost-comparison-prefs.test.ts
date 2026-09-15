import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  loadCostComparisonPrefs,
  saveCostComparisonPrefs,
  COST_COMPARISON_PREFS_KEY,
} from './cost-comparison-prefs.js';

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

describe('cost-comparison-prefs', () => {
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
      expect(loadCostComparisonPrefs()).toEqual({ window: null, agent: null });
    });

    test('round-trips a window and agent-filter choice', () => {
      expect(saveCostComparisonPrefs({ window: '24h', agent: 'claude-code' })).toBeNull();
      expect(JSON.parse(storage.map.get(COST_COMPARISON_PREFS_KEY)!)).toEqual({
        window: '24h',
        agent: 'claude-code',
      });
      expect(loadCostComparisonPrefs()).toEqual({ window: '24h', agent: 'claude-code' });
    });

    test('round-trips the all-window and all-agents sentinels', () => {
      expect(saveCostComparisonPrefs({ window: 'all', agent: 'all' })).toBeNull();
      expect(loadCostComparisonPrefs()).toEqual({ window: 'all', agent: 'all' });
    });

    test('save writes only window and agent keys', () => {
      expect(saveCostComparisonPrefs({ window: '30d', agent: 'codex-cli' })).toBeNull();
      expect(Object.keys(JSON.parse(storage.map.get(COST_COMPARISON_PREFS_KEY)!))).toEqual([
        'window',
        'agent',
      ]);
    });

    test('ignores a stored search field rather than loading it', () => {
      storage.map.set(
        COST_COMPARISON_PREFS_KEY,
        JSON.stringify({ window: '24h', agent: 'claude-code', search: 'login' }),
      );
      expect(loadCostComparisonPrefs()).toEqual({ window: '24h', agent: 'claude-code' });
    });

    test('falls back to null for a non-JSON stored value', () => {
      storage.map.set(COST_COMPARISON_PREFS_KEY, 'not-json{');
      expect(loadCostComparisonPrefs()).toEqual({ window: null, agent: null });
    });

    test('falls back to null for a non-object stored value', () => {
      storage.map.set(COST_COMPARISON_PREFS_KEY, '"7d"');
      expect(loadCostComparisonPrefs()).toEqual({ window: null, agent: null });
    });

    test('ignores an array stored value', () => {
      storage.map.set(COST_COMPARISON_PREFS_KEY, '["7d","all"]');
      expect(loadCostComparisonPrefs()).toEqual({ window: null, agent: null });
    });

    test('rejects a window that is not a known TimeWindow but keeps a valid agent', () => {
      storage.map.set(
        COST_COMPARISON_PREFS_KEY,
        JSON.stringify({ window: '90d', agent: 'claude-code' }),
      );
      expect(loadCostComparisonPrefs()).toEqual({ window: null, agent: 'claude-code' });
    });

    test('rejects an unknown agent filter but keeps a valid window', () => {
      storage.map.set(
        COST_COMPARISON_PREFS_KEY,
        JSON.stringify({ window: '24h', agent: 'grok-build' }),
      );
      expect(loadCostComparisonPrefs()).toEqual({ window: '24h', agent: null });
    });

    test('tolerates a partial object (missing fields become null)', () => {
      storage.map.set(COST_COMPARISON_PREFS_KEY, JSON.stringify({ window: '7d' }));
      expect(loadCostComparisonPrefs()).toEqual({ window: '7d', agent: null });
    });

    test('ignores extra future-format fields and keeps known valid ones', () => {
      storage.map.set(
        COST_COMPARISON_PREFS_KEY,
        JSON.stringify({ v: 2, window: '30d', agent: 'codex-cli', sort: 'cost' }),
      );
      expect(loadCostComparisonPrefs()).toEqual({ window: '30d', agent: 'codex-cli' });
    });

    test('falls back to null when a future-format object has no known fields', () => {
      storage.map.set(
        COST_COMPARISON_PREFS_KEY,
        JSON.stringify({ v: 2, filters: { window: '24h', agent: 'claude-code' } }),
      );
      expect(loadCostComparisonPrefs()).toEqual({ window: null, agent: null });
    });

    test('returns an Error when localStorage is unavailable', () => {
      expect(saveCostComparisonPrefs({ window: '7d', agent: 'all' }, null)).toBeInstanceOf(Error);
    });

    test('returns the error when the storage write throws', () => {
      const throwing: Pick<Storage, 'setItem'> = {
        setItem: () => { throw new Error('quota exceeded'); },
      };
      const result = saveCostComparisonPrefs({ window: '7d', agent: 'all' }, throwing);
      expect(result).toBeInstanceOf(Error);
      expect(result?.message).toBe('quota exceeded');
    });
  });
});
