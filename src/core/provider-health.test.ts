import { describe, expect, test } from 'vitest';
import { ProviderHealthTracker } from './provider-health.js';

describe('ProviderHealthTracker', () => {
  test('starts healthy', () => {
    const tracker = new ProviderHealthTracker();
    expect(tracker.snapshot()).toEqual({ substitutionCount: 0, pausedSince: null });
  });

  test('accumulates fallback substitutions monotonically', () => {
    const tracker = new ProviderHealthTracker();
    tracker.recordSubstitution();
    tracker.recordSubstitution(2);
    expect(tracker.snapshot().substitutionCount).toBe(3);
  });

  test('ignores non-positive or non-finite substitution counts', () => {
    const tracker = new ProviderHealthTracker();
    tracker.recordSubstitution(0);
    tracker.recordSubstitution(-4);
    tracker.recordSubstitution(Number.NaN);
    expect(tracker.snapshot().substitutionCount).toBe(0);
  });

  test('latches the first paused edge and clears on resume', () => {
    const tracker = new ProviderHealthTracker();
    tracker.setPaused(true, 1_000);
    expect(tracker.snapshot().pausedSince).toBe(1_000);
    // A second paused call while already paused keeps the original edge.
    tracker.setPaused(true, 5_000);
    expect(tracker.snapshot().pausedSince).toBe(1_000);
    tracker.setPaused(false, 9_000);
    expect(tracker.snapshot().pausedSince).toBeNull();
    // A new pause episode after a resume latches the fresh edge.
    tracker.setPaused(true, 12_000);
    expect(tracker.snapshot().pausedSince).toBe(12_000);
  });

  test('ignores a non-finite paused-since timestamp', () => {
    const tracker = new ProviderHealthTracker();
    tracker.setPaused(true, Number.NaN);
    expect(tracker.snapshot().pausedSince).toBeNull();
  });
});
