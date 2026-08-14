import { afterEach, describe, expect, test } from 'vitest';
import { createKookrStore, useKookrStore } from './useStore.js';
import { applyRoundRobinIndex, noteRoundRobinLaunch } from './round-robin-cursor.js';

function syncGlobalStore() {
  const freshState = createKookrStore().getState();
  const nextData = Object.fromEntries(
    Object.entries(freshState).filter(([, value]) => typeof value !== 'function'),
  );
  useKookrStore.setState(nextData);
}

describe('round-robin cursor helpers', () => {
  afterEach(() => {
    syncGlobalStore();
  });

  test('applyRoundRobinIndex accepts a non-negative integer and ignores junk', () => {
    syncGlobalStore();
    applyRoundRobinIndex(3);
    expect(useKookrStore.getState().roundRobinIndex).toBe(3);
    applyRoundRobinIndex(-1);
    applyRoundRobinIndex(1.5);
    applyRoundRobinIndex('2');
    expect(useKookrStore.getState().roundRobinIndex).toBe(3);
  });

  test('noteRoundRobinLaunch advances only for the round-robin sentinel', () => {
    syncGlobalStore();
    applyRoundRobinIndex(1);
    noteRoundRobinLaunch('claude-code');
    expect(useKookrStore.getState().roundRobinIndex).toBe(1);
    noteRoundRobinLaunch('round-robin');
    expect(useKookrStore.getState().roundRobinIndex).toBe(2);
  });
});
