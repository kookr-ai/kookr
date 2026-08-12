import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_DTACH_ORPHAN_MIN_AGE_MS,
  DEFAULT_DTACH_PRESSURE_SOFT_BOUND,
} from '../core/dtach-orphan-policy.js';
import type { ProcessSnapshot } from '../core/orphan-process-scanner.js';
import {
  DEFAULT_HOST_STALE_DTACH_REAP_INTERVAL_MINUTES,
  HostStaleDtachReaperService,
  readHostStaleDtachReaperConfigFromEnv,
  resolveHostStaleDtachReapIntervalMinutes,
  runScheduledHostStaleDtachReap,
  type HostStaleDtachReaperConfig,
} from './host-stale-dtach-reaper.js';

function snap(overrides: Partial<ProcessSnapshot> & { pid: number; cmdline: string }): ProcessSnapshot {
  return {
    ppid: 1,
    rssBytes: 1024 * 1024,
    startTimeMs: Date.now() - DEFAULT_DTACH_ORPHAN_MIN_AGE_MS - 5_000,
    cwd: null,
    ...overrides,
  };
}

function baseConfig(overrides: Partial<HostStaleDtachReaperConfig> = {}): HostStaleDtachReaperConfig {
  return {
    enabled: true,
    dryRun: false,
    softBound: DEFAULT_DTACH_PRESSURE_SOFT_BOUND,
    maxReapsPerSweep: 5,
    minAgeMs: DEFAULT_DTACH_ORPHAN_MIN_AGE_MS,
    killGraceMs: 50,
    ...overrides,
  };
}

function manyStale(count: number): ProcessSnapshot[] {
  return Array.from({ length: count }, (_, i) =>
    snap({
      pid: 2000 + i,
      cmdline: `dtach -n /tmp/kookr-dtach/1000/port-4800/kookr-stale-${i}.sock -r winch -E claude`,
    }),
  );
}

describe('HostStaleDtachReaperService (issue #2356)', () => {
  it('reaps eligible host-stale masters when count ≥ soft bound', async () => {
    const reap = vi.fn().mockResolvedValue(undefined);
    const processes = manyStale(DEFAULT_DTACH_PRESSURE_SOFT_BOUND);
    const service = new HostStaleDtachReaperService({
      listLiveSessionIds: () => new Set(),
      listProcesses: () => processes,
      socketExists: () => false,
      reap,
      getConfig: () => baseConfig({ maxReapsPerSweep: 3 }),
      now: () => Date.now(),
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    const result = await service.runSweep();
    expect(reap).toHaveBeenCalledTimes(3);
    expect(result.reaped).toHaveLength(3);
    expect(result.plan.underPressure).toBe(true);
    expect(result.plan.skippedRateLimited).toBe(DEFAULT_DTACH_PRESSURE_SOFT_BOUND - 3);

    const health = service.getHealthSnapshot();
    expect(health.lastHostStaleDtachReaped).toBe(3);
    expect(health.totalHostStaleDtachReaped).toBe(3);
    expect(health.skippedUnderBound).toBe(0);
    expect(health.lastUnderPressure).toBe(true);
  });

  it('reaps missing_socket_aged even under soft bound (issue #2384)', async () => {
    const reap = vi.fn().mockResolvedValue(undefined);
    const processes = manyStale(5); // well under soft bound 20
    const service = new HostStaleDtachReaperService({
      listLiveSessionIds: () => new Set(),
      listProcesses: () => processes,
      socketExists: () => false,
      reap,
      getConfig: () => baseConfig({ maxReapsPerSweep: 5 }),
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    const result = await service.runSweep();
    // Always-select: proven zombies must not wait for host pressure.
    expect(reap).toHaveBeenCalledTimes(5);
    expect(result.reaped).toHaveLength(5);
    expect(result.plan.underPressure).toBe(false);
    expect(result.plan.skippedUnderBound).toBe(0);
    expect(result.plan.selectedAlways).toBe(5);
    expect(service.getHealthSnapshot().skippedUnderBound).toBe(0);
    expect(service.getHealthSnapshot().lastHostStaleDtachReaped).toBe(5);
    expect(service.getHealthSnapshot().lastReapedAlways).toBe(5);
    expect(service.getHealthSnapshot().lastReapedUnderPressure).toBe(0);
    expect(service.getHealthSnapshot().totalHostStaleDtachReaped).toBe(5);
  });

  it('still never reaps live_session or socket_present under soft bound (issue #2384)', async () => {
    const reap = vi.fn();
    const liveSock = Array.from({ length: 3 }, (_, i) =>
      snap({
        pid: 4000 + i,
        cmdline: `dtach -n /tmp/kookr-dtach/1000/port-4800/kookr-live-${i}.sock -r winch -E claude`,
      }),
    );
    const withSocket = Array.from({ length: 2 }, (_, i) =>
      snap({
        pid: 5000 + i,
        cmdline: `dtach -n /tmp/kookr-dtach/1000/port-4800/kookr-sock-${i}.sock -r winch -E claude`,
      }),
    );
    const service = new HostStaleDtachReaperService({
      listLiveSessionIds: () => new Set(['kookr-live-0', 'kookr-live-1', 'kookr-live-2']),
      listProcesses: () => [...liveSock, ...withSocket],
      socketExists: (path) => path.includes('kookr-sock-'),
      reap,
      getConfig: () => baseConfig(),
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    const result = await service.runSweep();
    expect(reap).not.toHaveBeenCalled();
    expect(result.plan.toReap).toEqual([]);
    expect(result.plan.skippedLiveAttached).toBe(3);
    expect(result.plan.skippedSocketPresent).toBe(2);
  });

  it('does not count attach clients toward pressure (issue #2383)', async () => {
    const reap = vi.fn().mockResolvedValue(undefined);
    // 11 masters + 11 attachers would have been count=22 pre-#2383 and tripped softBound 20.
    // Masters-only count stays 11 (under soft bound). Issue #2384 still reaps
    // missing_socket_aged under soft bound (rate-limited); attachers never enter
    // the candidate list (no -n/-N master cmdline).
    const masters = manyStale(11);
    const attachers = masters.map((m, i) =>
      snap({
        pid: 9000 + i,
        cmdline: m.cmdline.replace('dtach -n ', 'dtach -a ').replace(/ -r winch -E claude$/, ' -E'),
      }),
    );
    const service = new HostStaleDtachReaperService({
      listLiveSessionIds: () => new Set(),
      listProcesses: () => [...masters, ...attachers],
      socketExists: () => false,
      reap,
      getConfig: () => baseConfig({ maxReapsPerSweep: 5 }),
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    const result = await service.runSweep();
    expect(result.plan.dtachCount).toBe(11);
    expect(result.plan.underPressure).toBe(false);
    // Attachers excluded from candidates; masters always-selected (#2384), rate-limited.
    expect(reap).toHaveBeenCalledTimes(5);
    expect(result.reaped.every((r) => r.pid >= 2000 && r.pid < 9000)).toBe(true);
    expect(result.plan.skippedUnderBound).toBe(0);
    expect(result.plan.skippedRateLimited).toBe(6);
  });

  it('never reaps a live-attached session (fail-closed)', async () => {
    const reap = vi.fn();
    // Inflate count with live-attached masters so pressure is high but all are live.
    const processes = Array.from({ length: DEFAULT_DTACH_PRESSURE_SOFT_BOUND }, (_, i) =>
      snap({
        pid: 3000 + i,
        cmdline: `dtach -n /tmp/kookr-dtach/1000/port-4800/kookr-live-${i}.sock -r winch -E claude`,
      }),
    );
    const live = new Set(processes.map((_, i) => `kookr-live-${i}`));
    const service = new HostStaleDtachReaperService({
      listLiveSessionIds: () => live,
      listProcesses: () => processes,
      socketExists: () => false,
      reap,
      getConfig: () => baseConfig(),
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    const result = await service.runSweep();
    expect(reap).not.toHaveBeenCalled();
    expect(result.plan.skippedLiveAttached).toBe(DEFAULT_DTACH_PRESSURE_SOFT_BOUND);
    expect(result.plan.toReap).toEqual([]);
    expect(service.getHealthSnapshot().skippedLiveAttached).toBe(DEFAULT_DTACH_PRESSURE_SOFT_BOUND);
  });

  it('never reaps when the socket still exists', async () => {
    const reap = vi.fn();
    const processes = manyStale(DEFAULT_DTACH_PRESSURE_SOFT_BOUND);
    const service = new HostStaleDtachReaperService({
      listLiveSessionIds: () => new Set(),
      listProcesses: () => processes,
      socketExists: () => true,
      reap,
      getConfig: () => baseConfig(),
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    const result = await service.runSweep();
    expect(reap).not.toHaveBeenCalled();
    expect(result.plan.skippedSocketPresent).toBe(DEFAULT_DTACH_PRESSURE_SOFT_BOUND);
    expect(service.getHealthSnapshot().skippedSocketPresent).toBe(DEFAULT_DTACH_PRESSURE_SOFT_BOUND);
  });

  it('dry-run logs without calling reap and does not bump total kills', async () => {
    const reap = vi.fn();
    const warn = vi.fn();
    const processes = manyStale(DEFAULT_DTACH_PRESSURE_SOFT_BOUND);
    const service = new HostStaleDtachReaperService({
      listLiveSessionIds: () => new Set(),
      listProcesses: () => processes,
      socketExists: () => false,
      reap,
      getConfig: () => baseConfig({ dryRun: true, maxReapsPerSweep: 2 }),
      logger: { log: vi.fn(), warn, error: vi.fn() },
    });

    const result = await service.runSweep();
    expect(reap).not.toHaveBeenCalled();
    expect(result.dryRun).toBe(true);
    expect(result.reaped).toHaveLength(2);
    expect(warn.mock.calls[0]![0] as string).toContain('dry-run would reap');
    expect(service.getHealthSnapshot().lastHostStaleDtachReaped).toBe(2);
    expect(service.getHealthSnapshot().totalHostStaleDtachReaped).toBe(0);
    expect(service.getHealthSnapshot().dryRun).toBe(true);
  });

  it('continues past a kill failure', async () => {
    const reap = vi
      .fn()
      .mockRejectedValueOnce(new Error('EPERM'))
      .mockResolvedValueOnce(undefined);
    const error = vi.fn();
    const processes = manyStale(DEFAULT_DTACH_PRESSURE_SOFT_BOUND);
    const service = new HostStaleDtachReaperService({
      listLiveSessionIds: () => new Set(),
      listProcesses: () => processes,
      socketExists: () => false,
      reap,
      getConfig: () => baseConfig({ maxReapsPerSweep: 2 }),
      logger: { log: vi.fn(), warn: vi.fn(), error },
    });

    const result = await service.runSweep();
    expect(result.reaped.map((r) => r.pid)).toEqual([2001]);
    expect(result.failedPids).toEqual([2000]);
    expect(error).toHaveBeenCalledOnce();
    expect(service.getHealthSnapshot().totalHostStaleDtachReaped).toBe(1);
  });

  it('is a no-op when disabled', async () => {
    const reap = vi.fn();
    const service = new HostStaleDtachReaperService({
      listLiveSessionIds: () => new Set(),
      listProcesses: () => manyStale(25),
      socketExists: () => false,
      reap,
      getConfig: () => baseConfig({ enabled: false }),
    });
    const result = await service.runSweep();
    expect(reap).not.toHaveBeenCalled();
    expect(result.reaped).toEqual([]);
    expect(service.getHealthSnapshot().enabled).toBe(false);
  });
});

describe('runScheduledHostStaleDtachReap', () => {
  it('swallows a throwing sweep so the interval never crashes the server', async () => {
    const error = vi.fn();
    const service = {
      runSweep: vi.fn().mockRejectedValue(new Error('boom')),
    };
    await expect(runScheduledHostStaleDtachReap(service, { error })).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
  });
});

describe('readHostStaleDtachReaperConfigFromEnv', () => {
  it('is enabled by default with dry-run off', () => {
    const cfg = readHostStaleDtachReaperConfigFromEnv({});
    expect(cfg.enabled).toBe(true);
    expect(cfg.dryRun).toBe(false);
    expect(cfg.softBound).toBe(DEFAULT_DTACH_PRESSURE_SOFT_BOUND);
    expect(cfg.maxReapsPerSweep).toBe(5);
  });

  it('disables on 0/false/off', () => {
    expect(readHostStaleDtachReaperConfigFromEnv({ KOOKR_HOST_STALE_DTACH_REAP: '0' }).enabled).toBe(
      false,
    );
    expect(
      readHostStaleDtachReaperConfigFromEnv({ KOOKR_HOST_STALE_DTACH_REAP: 'off' }).enabled,
    ).toBe(false);
  });

  it('enables dry-run on 1/true', () => {
    expect(
      readHostStaleDtachReaperConfigFromEnv({ KOOKR_HOST_STALE_DTACH_REAP_DRY_RUN: '1' }).dryRun,
    ).toBe(true);
  });

  it('reads numeric overrides', () => {
    const cfg = readHostStaleDtachReaperConfigFromEnv({
      KOOKR_HOST_STALE_DTACH_REAP_SOFT_BOUND: '12',
      KOOKR_HOST_STALE_DTACH_REAP_MAX_PER_SWEEP: '2',
      KOOKR_HOST_STALE_DTACH_REAP_MIN_AGE_MS: '30000',
    });
    expect(cfg.softBound).toBe(12);
    expect(cfg.maxReapsPerSweep).toBe(2);
    expect(cfg.minAgeMs).toBe(30_000);
  });
});

describe('resolveHostStaleDtachReapIntervalMinutes', () => {
  it('defaults to 5 minutes and treats invalid as default', () => {
    expect(resolveHostStaleDtachReapIntervalMinutes({})).toBe(
      DEFAULT_HOST_STALE_DTACH_REAP_INTERVAL_MINUTES,
    );
    expect(
      resolveHostStaleDtachReapIntervalMinutes({
        KOOKR_HOST_STALE_DTACH_REAP_INTERVAL_MINUTES: 'nope',
      }),
    ).toBe(DEFAULT_HOST_STALE_DTACH_REAP_INTERVAL_MINUTES);
  });

  it('explicit 0 disables the timer', () => {
    expect(
      resolveHostStaleDtachReapIntervalMinutes({
        KOOKR_HOST_STALE_DTACH_REAP_INTERVAL_MINUTES: '0',
      }),
    ).toBe(0);
  });

  it('reads a positive override', () => {
    expect(
      resolveHostStaleDtachReapIntervalMinutes({
        KOOKR_HOST_STALE_DTACH_REAP_INTERVAL_MINUTES: '15',
      }),
    ).toBe(15);
  });
});
