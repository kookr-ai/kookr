import { describe, expect, test, vi } from 'vitest';
import {
  INVENT_PRIORITY_HEALTH_REFRESH_INTERVAL_MS,
  InventPriorityHealthRefresher,
} from './invent-priority-health-refresher.js';
import type { InventPriorityClassHealth } from '../core/pipeline-starvation-state.js';

const COUNTS: InventPriorityClassHealth = {
  product: 7,
  micro: 3,
  other: 2,
  windowHours: 24,
};

describe('InventPriorityHealthRefresher (#2912)', () => {
  test('single-flights concurrent refreshes and publishes completion metadata', async () => {
    let resolveLoad!: (counts: InventPriorityClassHealth) => void;
    const load = vi.fn(() => new Promise<InventPriorityClassHealth>((resolve) => {
      resolveLoad = resolve;
    }));
    let nowMs = Date.parse('2026-08-31T02:00:00.000Z');
    const refresher = new InventPriorityHealthRefresher({ load, nowMs: () => nowMs });

    const first = refresher.refresh();
    const second = refresher.refresh();
    expect(load).toHaveBeenCalledTimes(1);

    resolveLoad(COUNTS);
    await Promise.all([first, second]);
    expect(refresher.getSnapshot()).toEqual({
      ...COUNTS,
      generatedAt: '2026-08-31T02:00:00.000Z',
      ageMs: 0,
      lastRefreshError: null,
    });

    nowMs += 45_000;
    expect(refresher.getSnapshot().ageMs).toBe(45_000);
  });

  test('retains the last successful counts and timestamp when refresh fails', async () => {
    let nowMs = Date.parse('2026-08-31T02:00:00.000Z');
    const load = vi.fn()
      .mockResolvedValueOnce(COUNTS)
      .mockRejectedValueOnce(new Error('ledger temporarily unreadable'));
    const refresher = new InventPriorityHealthRefresher({ load, nowMs: () => nowMs });

    await refresher.refresh();
    nowMs += 60_000;
    await refresher.refresh();

    expect(refresher.getSnapshot()).toEqual({
      ...COUNTS,
      generatedAt: '2026-08-31T02:00:00.000Z',
      ageMs: 60_000,
      lastRefreshError: 'ledger temporarily unreadable',
    });
  });

  test('starts with an immediate refresh, repeats on cadence, and stops cleanly', async () => {
    vi.useFakeTimers();
    try {
      const load = vi.fn().mockResolvedValue(COUNTS);
      const refresher = new InventPriorityHealthRefresher({ load });

      refresher.start();
      await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(INVENT_PRIORITY_HEALTH_REFRESH_INTERVAL_MS);
      expect(load).toHaveBeenCalledTimes(2);

      refresher.stop();
      await vi.advanceTimersByTimeAsync(INVENT_PRIORITY_HEALTH_REFRESH_INTERVAL_MS);
      expect(load).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
