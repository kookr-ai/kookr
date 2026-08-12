import { describe, expect, it, vi } from 'vitest';

import {
  classifyProcess,
  evaluateRelayOrphanBound,
  isKookrDtachMasterCmdline,
  isTestRunnerSpawnedRelayEnviron,
  isTestSpawnedRelayEnviron,
  resolveRelayOrphanBound,
  scanStaleProcesses,
  selectRelayOrphansToReap,
  summarizeStaleProcesses,
  DEFAULT_RELAY_ORPHAN_BOUND,
  RELAY_ORPHAN_FINDING_CODE,
  type ProcessSnapshot,
} from './orphan-process-scanner.js';

function proc(overrides: Partial<ProcessSnapshot> & { pid: number }): ProcessSnapshot {
  return {
    ppid: 1,
    cmdline: '',
    rssBytes: 0,
    startTimeMs: null,
    cwd: null,
    ...overrides,
  };
}

describe('classifyProcess', () => {
  it('classifies relay servers by the canonical path', () => {
    expect(classifyProcess('node --import tsx /home/x/kookr/relay/server.ts')).toBe('relay-server'); // portability-ok: fixture exercises cmdline path parsing
    expect(classifyProcess('node /app/relay/server.js')).toBe('relay-server');
    expect(classifyProcess('node /opt/relay/server')).toBe('relay-server');
  });

  it('classifies kookr dtach masters (-n and -N)', () => {
    expect(
      classifyProcess('dtach -n /tmp/kookr-dtach/1000/port-4800/sess.sock -E claude'),
    ).toBe('dtach');
    expect(classifyProcess('dtach -N /tmp/kookr-dtach/1000/port-4800/s1.sock')).toBe('dtach');
    expect(
      classifyProcess(
        'setsid -f /repo/vendor/dtach/dtach -n /tmp/kookr-dtach/1000/port-4800/k.sock -r winch -E claude',
      ),
    ).toBe('dtach');
  });

  it('does not classify kookr-dtach attach clients as dtach (issue #2383)', () => {
    expect(
      classifyProcess('dtach -a /tmp/kookr-dtach/1000/port-4800/sess.sock -E'),
    ).toBeNull();
    expect(
      classifyProcess('/repo/vendor/dtach/dtach -a /tmp/kookr-dtach/1000/port-4800/k.sock -E'),
    ).toBeNull();
    expect(isKookrDtachMasterCmdline('dtach -a /tmp/kookr-dtach/x.sock -E')).toBe(false);
    expect(isKookrDtachMasterCmdline('dtach -n /tmp/kookr-dtach/x.sock -E claude')).toBe(true);
  });

  it('does not misclassify unrelated processes', () => {
    expect(classifyProcess('vim relay/server-notes.md')).toBeNull();
    expect(classifyProcess('dtach -n /tmp/other/foo.sock bash')).toBeNull();
    expect(classifyProcess('')).toBeNull();
    expect(classifyProcess('node dist/index.js')).toBeNull();
  });
});

describe('isTestSpawnedRelayEnviron', () => {
  it('matches the vitest die-with-parent marker', () => {
    expect(isTestSpawnedRelayEnviron({ KOOKR_RELAY_DIE_WITH_PARENT: '1' })).toBe(true);
    expect(isTestSpawnedRelayEnviron({ KOOKR_RELAY_DIE_WITH_PARENT: 'true' })).toBe(true);
  });
  it('does not match a normal/prod relay environment', () => {
    expect(isTestSpawnedRelayEnviron({ KOOKR_RELAY_DIE_WITH_PARENT: '0' })).toBe(false);
    expect(isTestSpawnedRelayEnviron({})).toBe(false);
    expect(isTestSpawnedRelayEnviron(null)).toBe(false);
  });
});

describe('isTestRunnerSpawnedRelayEnviron', () => {
  it('matches the die-with-parent marker', () => {
    expect(isTestRunnerSpawnedRelayEnviron({ KOOKR_RELAY_DIE_WITH_PARENT: '1' })).toBe(true);
  });
  it('matches any VITEST env marker (the #1885 leak class: marker never armed)', () => {
    // The 22 stranded main-checkout relays carried VITEST but NOT the die marker.
    expect(isTestRunnerSpawnedRelayEnviron({ VITEST: 'true' })).toBe(true);
    expect(isTestRunnerSpawnedRelayEnviron({ VITEST_WORKER_ID: '3' })).toBe(true);
    expect(isTestRunnerSpawnedRelayEnviron({ VITEST_POOL_ID: '1', PORT: '5001' })).toBe(true);
  });
  it('does not match a production relay environment (neither signal)', () => {
    expect(isTestRunnerSpawnedRelayEnviron({ PORT: '4800', NODE_ENV: 'production' })).toBe(false);
    expect(isTestRunnerSpawnedRelayEnviron({ KOOKR_RELAY_DIE_WITH_PARENT: '0' })).toBe(false);
    expect(isTestRunnerSpawnedRelayEnviron({})).toBe(false);
    expect(isTestRunnerSpawnedRelayEnviron(null)).toBe(false);
    // Boundary: a key that begins with VITEST but not VITEST_ must NOT match
    // (the check is `=== 'VITEST' || startsWith('VITEST_')`, not a loose prefix).
    expect(isTestRunnerSpawnedRelayEnviron({ VITESTING_UNRELATED: '1' })).toBe(false);
    // A key that merely contains VITEST as a substring must NOT match.
    expect(isTestRunnerSpawnedRelayEnviron({ MYVITEST: '1' })).toBe(false);
  });
});

describe('scanStaleProcesses', () => {
  it('classifies, derives age, and checks cwd existence', () => {
    const now = 10_000;
    const result = scanStaleProcesses({
      now,
      cwdExists: (dir) => dir === '/live',
      listProcesses: () => [
        proc({ pid: 2, cmdline: 'node relay/server.ts', startTimeMs: 4_000, rssBytes: 100, cwd: '/live' }),
        proc({ pid: 3, cmdline: 'node relay/server.ts', startTimeMs: 1_000, rssBytes: 200, cwd: '/gone' }),
        proc({ pid: 4, cmdline: 'dtach -n /tmp/kookr-dtach/x.sock claude', startTimeMs: null, rssBytes: 50, cwd: null }),
        proc({ pid: 5, cmdline: 'node dist/other.js', startTimeMs: 0 }),
      ],
    });
    expect(result).toEqual([
      { pid: 2, klass: 'relay-server', ageMs: 6_000, rssBytes: 100, cwd: '/live', cwdExists: true, testSpawned: false },
      { pid: 3, klass: 'relay-server', ageMs: 9_000, rssBytes: 200, cwd: '/gone', cwdExists: false, testSpawned: false },
      { pid: 4, klass: 'dtach', ageMs: null, rssBytes: 50, cwd: null, cwdExists: false, testSpawned: false },
    ]);
  });

  it('marks relays with a die-marker OR a VITEST marker as test-spawned (relay only)', () => {
    const environs: Record<number, Record<string, string>> = {
      2: { KOOKR_RELAY_DIE_WITH_PARENT: '1' }, // post-#1723 marker
      3: { VITEST_WORKER_ID: '5' }, // #1885 class: VITEST only, no die marker
      5: { PORT: '4800' }, // prod-like: neither → not test-spawned
    };
    const readEnviron = vi.fn((pid: number) => environs[pid] ?? {});
    const result = scanStaleProcesses({
      now: 0,
      readEnviron,
      listProcesses: () => [
        proc({ pid: 2, cmdline: 'node relay/server.ts', cwd: '/wt' }),
        proc({ pid: 3, cmdline: 'node relay/server.ts', cwd: '/wt' }),
        proc({ pid: 5, cmdline: 'node relay/server.ts', cwd: '/prod' }),
        // dtach must never have its environ probed.
        proc({ pid: 4, cmdline: 'dtach -n /tmp/kookr-dtach/x.sock claude' }),
      ],
    });
    expect(result.map((p) => [p.pid, p.testSpawned])).toEqual([
      [2, true],
      [3, true],
      [5, false],
      [4, false],
    ]);
    expect(readEnviron).toHaveBeenCalledWith(2);
    expect(readEnviron).toHaveBeenCalledWith(3);
    expect(readEnviron).not.toHaveBeenCalledWith(4);
  });

  it('leaves testSpawned false when no environ reader is wired (health-summary path)', () => {
    const result = scanStaleProcesses({
      now: 0,
      listProcesses: () => [proc({ pid: 2, cmdline: 'node relay/server.ts', cwd: '/wt' })],
    });
    expect(result[0]!.testSpawned).toBe(false);
  });

  it('excludes pids in the exclude set', () => {
    const result = scanStaleProcesses({
      now: 0,
      excludePids: new Set([2]),
      listProcesses: () => [proc({ pid: 2, cmdline: 'node relay/server.ts' })],
    });
    expect(result).toEqual([]);
  });
});

describe('summarizeStaleProcesses', () => {
  it('aggregates count + rss per class', () => {
    const summary = summarizeStaleProcesses([
      { pid: 2, klass: 'relay-server', ageMs: 1, rssBytes: 100, cwd: null, cwdExists: false, testSpawned: false },
      { pid: 3, klass: 'relay-server', ageMs: 1, rssBytes: 250, cwd: null, cwdExists: false, testSpawned: false },
      { pid: 4, klass: 'dtach', ageMs: 1, rssBytes: 75, cwd: null, cwdExists: false, testSpawned: false },
    ]);
    expect(summary).toEqual({
      relayServer: { count: 2, rssBytes: 350 },
      dtach: { count: 1, rssBytes: 75 },
    });
  });

  it('is all-zero for an empty scan', () => {
    expect(summarizeStaleProcesses([])).toEqual({
      relayServer: { count: 0, rssBytes: 0 },
      dtach: { count: 0, rssBytes: 0 },
    });
  });

  it('counts masters only when N masters + N attachers are present (issue #2383)', () => {
    const n = 11;
    const processes: ProcessSnapshot[] = [];
    for (let i = 0; i < n; i += 1) {
      const sock = `/tmp/kookr-dtach/1000/port-4800/kookr-sess-${i}.sock`;
      processes.push(
        proc({
          pid: 1000 + i,
          cmdline: `dtach -n ${sock} -r winch -E claude`,
          rssBytes: 10,
        }),
        proc({
          pid: 2000 + i,
          cmdline: `dtach -a ${sock} -E`,
          rssBytes: 5,
        }),
      );
    }
    // Pre-#2383 this would have been 22; softBound 20 false-triggered under healthy load.
    const scanned = scanStaleProcesses({ now: 0, listProcesses: () => processes });
    const summary = summarizeStaleProcesses(scanned);
    expect(scanned).toHaveLength(n);
    expect(summary.dtach).toEqual({ count: n, rssBytes: n * 10 });
    expect(summary.dtach.count).toBeLessThan(20); // softBound stays a real leak ceiling
  });
});

describe('selectRelayOrphansToReap', () => {
  const gone = (pid: number, ageMs: number | null): Parameters<typeof selectRelayOrphansToReap>[0][number] => ({
    pid,
    klass: 'relay-server',
    ageMs,
    rssBytes: 0,
    cwd: '/gone',
    cwdExists: false,
    testSpawned: false,
  });

  it('reaps a relay whose worktree is gone and is older than minAge', () => {
    const selected = selectRelayOrphansToReap([gone(2, 120_000)], { minAgeMs: 60_000 });
    expect(selected.map((p) => p.pid)).toEqual([2]);
  });

  it('does not reap a freshly-spawned relay even if the cwd is gone (teardown race)', () => {
    const selected = selectRelayOrphansToReap([gone(2, 5_000)], { minAgeMs: 60_000 });
    expect(selected).toEqual([]);
  });

  it('never reaps a relay whose worktree still exists unless a maxAge ceiling is set', () => {
    const live = {
      pid: 9,
      klass: 'relay-server' as const,
      ageMs: 10 * 60 * 60 * 1000, // 10h, like a prod relay
      rssBytes: 0,
      cwd: '/prod',
      cwdExists: true,
      testSpawned: false,
    };
    expect(selectRelayOrphansToReap([live])).toEqual([]);
    // Only with an explicit ceiling does age alone qualify.
    expect(selectRelayOrphansToReap([live], { maxAgeMs: 2 * 60 * 60 * 1000 }).map((p) => p.pid)).toEqual([9]);
  });

  it('reaps an aged test-spawned relay whose worktree STILL exists (#1885 regression)', () => {
    // The exact leak class #1723 missed: a test/e2e relay stranded in a reused
    // worktree that was never deleted. cwdExists=true, so the worktree-gone
    // signal never fires — but the die-with-parent marker does.
    const strandedTestRelay = {
      pid: 42,
      klass: 'relay-server' as const,
      ageMs: 3 * 60 * 60 * 1000, // 3h old
      rssBytes: 52 * 1024 * 1024,
      cwd: '/home/x/kookr-worktrees/hourly-smoke', // still on disk
      cwdExists: true,
      testSpawned: true,
    };
    expect(selectRelayOrphansToReap([strandedTestRelay]).map((p) => p.pid)).toEqual([42]);
  });

  it('does not reap a freshly-spawned test relay even with the marker (teardown race)', () => {
    const fresh = {
      pid: 43,
      klass: 'relay-server' as const,
      ageMs: 5_000,
      rssBytes: 0,
      cwd: '/wt',
      cwdExists: true,
      testSpawned: true,
    };
    expect(selectRelayOrphansToReap([fresh], { minAgeMs: 60_000 })).toEqual([]);
  });

  it('never reaps a relay whose start time is unknown (ageMs null), even with the worktree gone', () => {
    const unknownAge = {
      pid: 3,
      klass: 'relay-server' as const,
      ageMs: null,
      rssBytes: 0,
      cwd: '/gone',
      cwdExists: false,
      testSpawned: true, // even the marker must not override an unknown age
    };
    // Safe posture: an unreadable start time must not qualify a kill under
    // either the worktree-gone floor or the age ceiling.
    expect(selectRelayOrphansToReap([unknownAge], { minAgeMs: 0 })).toEqual([]);
    expect(selectRelayOrphansToReap([unknownAge], { minAgeMs: 0, maxAgeMs: 0 })).toEqual([]);
  });

  it('never selects dtach orphans (owned by the session reconciler, #1720)', () => {
    const dtach = {
      pid: 7,
      klass: 'dtach' as const,
      ageMs: 99_999_999,
      rssBytes: 0,
      cwd: '/gone',
      cwdExists: false,
      testSpawned: false,
    };
    expect(selectRelayOrphansToReap([dtach], { minAgeMs: 0, maxAgeMs: 0 })).toEqual([]);
  });
});

describe('evaluateRelayOrphanBound', () => {
  const summary = (count: number, rssBytes = 0) => ({
    relayServer: { count, rssBytes },
    dtach: { count: 0, rssBytes: 0 },
  });

  it('returns null when at or below the bound', () => {
    expect(evaluateRelayOrphanBound(summary(0))).toBeNull();
    expect(evaluateRelayOrphanBound(summary(DEFAULT_RELAY_ORPHAN_BOUND))).toBeNull();
  });

  it('emits a first-class finding when strictly over the bound', () => {
    const finding = evaluateRelayOrphanBound(summary(29, 1_517_592_576), 5);
    expect(finding).toEqual({
      code: RELAY_ORPHAN_FINDING_CODE,
      count: 29,
      bound: 5,
      rssBytes: 1_517_592_576,
    });
  });

  it('respects a custom bound', () => {
    expect(evaluateRelayOrphanBound(summary(4), 3)?.count).toBe(4);
    expect(evaluateRelayOrphanBound(summary(3), 3)).toBeNull();
  });
});

describe('resolveRelayOrphanBound', () => {
  it('defaults, and floors/validates env overrides', () => {
    expect(resolveRelayOrphanBound({})).toBe(DEFAULT_RELAY_ORPHAN_BOUND);
    expect(resolveRelayOrphanBound({ KOOKR_RELAY_ORPHAN_ALERT_BOUND: '10' })).toBe(10);
    expect(resolveRelayOrphanBound({ KOOKR_RELAY_ORPHAN_ALERT_BOUND: '0' })).toBe(0);
    expect(resolveRelayOrphanBound({ KOOKR_RELAY_ORPHAN_ALERT_BOUND: '2.9' })).toBe(2);
    expect(resolveRelayOrphanBound({ KOOKR_RELAY_ORPHAN_ALERT_BOUND: '-1' })).toBe(DEFAULT_RELAY_ORPHAN_BOUND);
    expect(resolveRelayOrphanBound({ KOOKR_RELAY_ORPHAN_ALERT_BOUND: 'nope' })).toBe(DEFAULT_RELAY_ORPHAN_BOUND);
  });
});
