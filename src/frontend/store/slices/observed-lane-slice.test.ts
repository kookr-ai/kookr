import { describe, expect, test } from 'vitest';
import { createKookrStore } from '../useStore.js';
import type { ObservedActivitySnapshot } from '../../../shared/contracts/observed-activity.js';

function snapshot(overrides: Partial<ObservedActivitySnapshot> = {}): ObservedActivitySnapshot {
  return {
    sessions: [],
    counters: { accepted: 0, deduped: 0, rejected: {}, lastAcceptedAt: null, lastRejectAt: null, startedAt: 0 },
    now: 1000,
    ...overrides,
  };
}

describe('observed-lane-slice', () => {
  test('starts null (lane disabled until first frame)', () => {
    const store = createKookrStore();
    expect(store.getState().observedActivity).toBeNull();
  });

  test('handleObservedActivity stores the latest snapshot', () => {
    const store = createKookrStore();
    const snap = snapshot({
      sessions: [
        {
          sessionId: 'hermes-obs-x',
          state: 'working',
          label: 'reviewing PR #9',
          receivedAt: 900,
          firstSeen: 100,
          pulseCount: 3,
          effectiveState: 'working',
          ageMs: 100,
        },
      ],
    });

    store.getState().handleObservedActivity(snap);

    expect(store.getState().observedActivity).toEqual(snap);
  });

  test('a later frame replaces the earlier one (pure sink, no merge)', () => {
    const store = createKookrStore();
    store.getState().handleObservedActivity(snapshot({ now: 1 }));
    store.getState().handleObservedActivity(snapshot({ now: 2 }));
    expect(store.getState().observedActivity?.now).toBe(2);
  });

  test('clearObservedActivity drops the frame back to null (lane disabled)', () => {
    const store = createKookrStore();
    store.getState().handleObservedActivity(snapshot());
    store.getState().clearObservedActivity();
    expect(store.getState().observedActivity).toBeNull();
  });
});
