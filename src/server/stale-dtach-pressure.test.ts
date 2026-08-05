import { describe, expect, it } from 'vitest';
import type { ProcessSnapshot } from '../core/orphan-process-scanner.js';
import { createCachedStaleDtachCountReader } from './stale-dtach-pressure.js';

function snap(pid: number, cmdline: string): ProcessSnapshot {
  return {
    pid,
    ppid: 1,
    cmdline,
    rssBytes: 1024,
    startTimeMs: Date.now() - 60_000,
    cwd: '/tmp',
  };
}

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
          snap(10, 'dtach -N /tmp/kookr-dtach/1000/port-4800/s1.sock'),
          snap(11, 'dtach -N /tmp/kookr-dtach/1000/port-4800/s2.sock'),
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
