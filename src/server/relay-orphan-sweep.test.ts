import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_RELAY_ORPHAN_SWEEP_INTERVAL_HOURS,
  resolveRelayOrphanSweepIntervalHours,
  runRelayOrphanSweep,
} from './relay-orphan-sweep.js';
import { runScheduledRelayOrphanSweep } from './maintenance-prune-schedule.js';
import type { StaleProcess } from '../core/orphan-process-scanner.js';

function relay(overrides: Partial<StaleProcess> & { pid: number }): StaleProcess {
  return {
    klass: 'relay-server',
    ageMs: 120_000,
    rssBytes: 50 * 1024 * 1024,
    cwd: '/gone',
    cwdExists: false,
    testSpawned: false,
    ...overrides,
  };
}

describe('runRelayOrphanSweep', () => {
  it('reaps an aged relay orphan whose worktree is gone and logs pid/age/rss', async () => {
    const reap = vi.fn().mockResolvedValue(undefined);
    const warn = vi.fn();
    const result = await runRelayOrphanSweep({
      now: () => 1_000_000,
      scan: () => [relay({ pid: 4242, ageMs: 3 * 60 * 60 * 1000, rssBytes: 100 * 1024 * 1024 })],
      reap,
      logger: { log: vi.fn(), warn, error: vi.fn() },
    });

    expect(reap).toHaveBeenCalledWith(4242);
    expect(result.reaped).toEqual([
      { pid: 4242, ageMs: 3 * 60 * 60 * 1000, rssBytes: 100 * 1024 * 1024, cwd: '/gone' },
    ]);
    expect(result.reapedRssBytes).toBe(100 * 1024 * 1024);
    // Reap log carries pid + age + rss (acceptance criterion #3).
    const line = warn.mock.calls[0]![0] as string;
    expect(line).toContain('pid=4242');
    expect(line).toMatch(/age=3h/);
    expect(line).toMatch(/rss=100\.0MB/);
  });

  it('does not reap a still-present-cwd relay (production-safe)', async () => {
    const reap = vi.fn();
    const result = await runRelayOrphanSweep({
      scan: () => [relay({ pid: 5, cwd: '/prod', cwdExists: true, ageMs: 10 * 60 * 60 * 1000 })],
      reap,
    });
    expect(reap).not.toHaveBeenCalled();
    expect(result.reaped).toEqual([]);
    expect(result.candidates).toBe(0);
    expect(result.scanned).toBe(1);
  });

  it('reaps an aged test-spawned relay whose worktree still exists (#1885)', async () => {
    const reap = vi.fn().mockResolvedValue(undefined);
    const warn = vi.fn();
    const result = await runRelayOrphanSweep({
      scan: () => [
        relay({
          pid: 77,
          cwd: '/home/x/kookr-smoke', // still on disk — worktree-gone signal is blind here
          cwdExists: true,
          testSpawned: true,
          ageMs: 2 * 60 * 60 * 1000,
        }),
      ],
      reap,
      logger: { log: vi.fn(), warn, error: vi.fn() },
    });
    expect(reap).toHaveBeenCalledWith(77);
    expect(result.reaped.map((r) => r.pid)).toEqual([77]);
    // Log attributes the reap to the test-spawn marker, not worktree-gone.
    expect(warn.mock.calls[0]![0] as string).toContain('test-runner marker, #1885');
  });

  it('does not reap a freshly-spawned relay whose cwd just vanished (teardown race)', async () => {
    const reap = vi.fn();
    const result = await runRelayOrphanSweep({
      scan: () => [relay({ pid: 6, ageMs: 5_000 })],
      reap,
    });
    expect(reap).not.toHaveBeenCalled();
    expect(result.reaped).toEqual([]);
  });

  it('continues past a kill failure and records only the successful reaps', async () => {
    const error = vi.fn();
    const reap = vi
      .fn()
      .mockRejectedValueOnce(new Error('EPERM'))
      .mockResolvedValueOnce(undefined);
    const result = await runRelayOrphanSweep({
      scan: () => [relay({ pid: 7 }), relay({ pid: 8 })],
      reap,
      logger: { log: vi.fn(), warn: vi.fn(), error },
    });
    expect(result.reaped.map((r) => r.pid)).toEqual([8]);
    expect(error).toHaveBeenCalledOnce();
    expect(error.mock.calls[0]![0]).toContain('pid=7');
  });
});

describe('runScheduledRelayOrphanSweep', () => {
  it('swallows a throwing sweep so the interval callback never crashes the server', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const run = vi.fn().mockRejectedValue(new Error('boom'));
      await expect(runScheduledRelayOrphanSweep({ intervalHours: 2, run })).resolves.toBeUndefined();
      expect(run).toHaveBeenCalledOnce();
      // The sweep is invoked with the server's own pid excluded from reaping.
      expect(run.mock.calls[0]![0].excludePids.has(process.pid)).toBe(true);
      expect(err).toHaveBeenCalled();
    } finally {
      err.mockRestore();
    }
  });

  it('runs the sweep when it succeeds', async () => {
    const run = vi.fn().mockResolvedValue({ scanned: 0, candidates: 0, reaped: [], reapedRssBytes: 0 });
    await runScheduledRelayOrphanSweep({ intervalHours: 1, run });
    expect(run).toHaveBeenCalledOnce();
  });
});

describe('resolveRelayOrphanSweepIntervalHours', () => {
  it('is ON by default and for invalid values (#1885 — was off in #1723)', () => {
    expect(resolveRelayOrphanSweepIntervalHours({})).toBe(
      DEFAULT_RELAY_ORPHAN_SWEEP_INTERVAL_HOURS,
    );
    expect(resolveRelayOrphanSweepIntervalHours({ KOOKR_RELAY_ORPHAN_SWEEP_INTERVAL_HOURS: 'nope' })).toBe(
      DEFAULT_RELAY_ORPHAN_SWEEP_INTERVAL_HOURS,
    );
    expect(resolveRelayOrphanSweepIntervalHours({ KOOKR_RELAY_ORPHAN_SWEEP_INTERVAL_HOURS: '-2' })).toBe(
      DEFAULT_RELAY_ORPHAN_SWEEP_INTERVAL_HOURS,
    );
  });

  it('an explicit 0 disables the timer', () => {
    expect(resolveRelayOrphanSweepIntervalHours({ KOOKR_RELAY_ORPHAN_SWEEP_INTERVAL_HOURS: '0' })).toBe(0);
  });

  it('reads a positive interval override', () => {
    expect(resolveRelayOrphanSweepIntervalHours({ KOOKR_RELAY_ORPHAN_SWEEP_INTERVAL_HOURS: '2' })).toBe(2);
    expect(resolveRelayOrphanSweepIntervalHours({ KOOKR_RELAY_ORPHAN_SWEEP_INTERVAL_HOURS: '0.5' })).toBe(0.5);
  });
});
