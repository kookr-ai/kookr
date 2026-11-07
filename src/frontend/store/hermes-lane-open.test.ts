import { describe, expect, test } from 'vitest';
import {
  HERMES_LANE_OPEN_DEFAULT,
  loadHermesLaneOpen,
  saveHermesLaneOpen,
} from './hermes-lane-open.js';

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, v),
    _map: map,
  };
}

describe('hermes-lane-open', () => {
  test('defaults to collapsed when unset', () => {
    expect(loadHermesLaneOpen(memoryStorage())).toBe(HERMES_LANE_OPEN_DEFAULT);
    expect(HERMES_LANE_OPEN_DEFAULT).toBe(false);
  });

  test('round-trips open=true', () => {
    const s = memoryStorage();
    expect(saveHermesLaneOpen(true, s)).toBeNull();
    expect(loadHermesLaneOpen(s)).toBe(true);
  });

  test('round-trips open=false', () => {
    const s = memoryStorage();
    expect(saveHermesLaneOpen(false, s)).toBeNull();
    expect(loadHermesLaneOpen(s)).toBe(false);
  });

  test('a malformed stored value falls back to the default', () => {
    expect(loadHermesLaneOpen(memoryStorage({ 'kookr:hermesLaneOpen': 'yes' }))).toBe(HERMES_LANE_OPEN_DEFAULT);
  });

  test('a null storage reads the default and reports a write error', () => {
    expect(loadHermesLaneOpen(null)).toBe(HERMES_LANE_OPEN_DEFAULT);
    expect(saveHermesLaneOpen(true, null)).toBeInstanceOf(Error);
  });

  test('a throwing getItem is swallowed to the default', () => {
    const throwing = {
      getItem: () => {
        throw new Error('blocked');
      },
    };
    expect(loadHermesLaneOpen(throwing)).toBe(HERMES_LANE_OPEN_DEFAULT);
  });
});
