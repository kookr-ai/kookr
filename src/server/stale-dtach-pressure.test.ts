import { describe, expect, it } from 'vitest';
import type { ProcessSnapshot } from '../core/orphan-process-scanner.js';
import {
  createCachedStaleDtachCountReader,
  createStaleProcessSummaryCache,
  STALE_PROCESS_CACHE_MS,
} from './stale-dtach-pressure.js';

function snap(pid: number, cmdline: string, rssBytes = 1024): ProcessSnapshot {
  return {
    pid,
    ppid: 1,
    cmdline,
    rssBytes,
    startTimeMs: Date.now() - 60_000,
    cwd: '/tmp',
  };
}

const DTACH_A = 'dtach -N /tmp/kookr-dtach/1000/port-4800/s1.sock';
const DTACH_B = 'dtach -N /tmp/kookr-dtach/1000/port-4800/s2.sock';
const RELAY = 'node /app/relay/server.js --port 9900';

describe('createCachedStaleDtachCountReader (issue #2081)', () => {
  it('counts kookr-dtach masters and caches across calls within the TTL', () => {
    let listCalls = 0;
    const now = { t: 1_000_000 };
    const reader = createCachedStaleDtachCountReader({
      ttlMs: 15_000,
      now: () => now.t,
      listProcesses: () => {
        listCalls += 1;
        return [
          snap(10, DTACH_A),
          snap(11, DTACH_B),
          snap(12, 'bash'), // ignored
        ];
      },
    });

    expect(reader()).toBe(2);
    expect(reader()).toBe(2);
    expect(listCalls).toBe(1); // second call served from cache

    now.t += 16_000; // past TTL
    expect(reader()).toBe(2);
    expect(listCalls).toBe(2);
  });

  it('returns null when the process snapshot is empty (non-Linux /proc)', () => {
    const reader = createCachedStaleDtachCountReader({
      listProcesses: () => [],
    });
    expect(reader()).toBeNull();
  });

  it('returns null when listProcesses throws', () => {
    const reader = createCachedStaleDtachCountReader({
      listProcesses: () => {
        throw new Error('EPERM');
      },
    });
    expect(reader()).toBeNull();
  });
});

describe('createStaleProcessSummaryCache (issue #2350)', () => {
  it('only one /proc scan per TTL for health + reaper + watchdog readers', () => {
    let listCalls = 0;
    const now = { t: 3_000_000 };
    const cache = createStaleProcessSummaryCache({
      ttlMs: STALE_PROCESS_CACHE_MS,
      now: () => now.t,
      // no-op schedule so SWR does not race; sync warms first
      schedule: () => {},
      listProcesses: () => {
        listCalls += 1;
        return [
          snap(10, DTACH_A, 4096),
          snap(11, DTACH_B, 2048),
          snap(20, RELAY, 8192),
          snap(99, 'bash'),
        ];
      },
    });

    // Warm via reaper/watchdog sync path (one scan)
    expect(cache.getDtachCount()).toBe(2);
    expect(listCalls).toBe(1);

    // Health SWR + reaper + watchdog all share the warm entry
    expect(cache.getSummary()).toEqual({
      relayServer: { count: 1, rssBytes: 8192 },
      dtach: { count: 2, rssBytes: 6144 },
    });
    expect(cache.getDtachCount()).toBe(2);
    expect(cache.getSummarySync()?.relayServer.count).toBe(1);
    expect(listCalls).toBe(1);

    // Past TTL → next sync scan only once; SWR serves last warm without a second walk
    now.t += STALE_PROCESS_CACHE_MS + 1;
    expect(cache.getDtachCount()).toBe(2);
    expect(cache.getSummary()?.dtach.count).toBe(2);
    expect(listCalls).toBe(2);
  });

  it('SWR returns null when cold and serves last warm summary while refresh is in flight', () => {
    let listCalls = 0;
    const now = { t: 4_000_000 };
    const pending: Array<() => void> = [];
    const cache = createStaleProcessSummaryCache({
      ttlMs: 15_000,
      now: () => now.t,
      schedule: (fn) => {
        pending.push(fn);
      },
      listProcesses: () => {
        listCalls += 1;
        return listCalls === 1
          ? [snap(10, DTACH_A)]
          : [snap(10, DTACH_A), snap(11, DTACH_B)];
      },
    });

    expect(cache.getSummary()).toBeNull();
    expect(listCalls).toBe(0);
    expect(pending).toHaveLength(1);

    pending.shift()?.();
    expect(listCalls).toBe(1);
    expect(cache.getSummary()?.dtach.count).toBe(1);

    now.t += 16_000;
    // Expired: SWR returns previous summary and queues refresh
    expect(cache.getSummary()?.dtach.count).toBe(1);
    expect(listCalls).toBe(1);
    expect(pending).toHaveLength(1);

    pending.shift()?.();
    expect(listCalls).toBe(2);
    expect(cache.getSummary()?.dtach.count).toBe(2);
  });

  it('skips queued SWR scan when sync already warmed the cache', () => {
    let listCalls = 0;
    const now = { t: 6_000_000 };
    const pending: Array<() => void> = [];
    const cache = createStaleProcessSummaryCache({
      ttlMs: 15_000,
      now: () => now.t,
      schedule: (fn) => {
        pending.push(fn);
      },
      listProcesses: () => {
        listCalls += 1;
        return [snap(10, DTACH_A), snap(20, RELAY)];
      },
    });

    // Expire after an initial warm so SWR schedules a refresh
    expect(cache.getDtachCount()).toBe(1);
    expect(listCalls).toBe(1);
    now.t += 16_000;
    expect(cache.getSummary()?.dtach.count).toBe(1); // schedules refresh
    expect(pending).toHaveLength(1);

    // Sync path refreshes first
    expect(cache.getDtachCount()).toBe(1);
    expect(listCalls).toBe(2);

    // Flush queued SWR — must not walk /proc again (already warm)
    pending.shift()?.();
    expect(listCalls).toBe(2);
  });

  it('single-flights concurrent SWR refreshes', () => {
    let listCalls = 0;
    const now = { t: 5_000_000 };
    const pending: Array<() => void> = [];
    const cache = createStaleProcessSummaryCache({
      ttlMs: 15_000,
      now: () => now.t,
      schedule: (fn) => {
        pending.push(fn);
      },
      listProcesses: () => {
        listCalls += 1;
        return [snap(10, DTACH_A)];
      },
    });

    expect(cache.getSummary()).toBeNull();
    expect(cache.getSummary()).toBeNull();
    expect(cache.getSummary()).toBeNull();
    expect(pending).toHaveLength(1);
    expect(listCalls).toBe(0);

    pending.shift()?.();
    expect(listCalls).toBe(1);
    expect(cache.getSummary()?.dtach.count).toBe(1);
    expect(listCalls).toBe(1);
  });

  it('exports the shared 15s TTL constant', () => {
    expect(STALE_PROCESS_CACHE_MS).toBe(15_000);
  });
});
