import { describe, expect, it } from 'vitest';

import {
  classifyProcess,
  isTestSpawnedRelayEnviron,
  scanStaleProcesses,
  selectRelayOrphansToReap,
  summarizeStaleProcesses,
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

  it('classifies kookr dtach masters', () => {
    expect(
      classifyProcess('dtach -n /tmp/kookr-dtach/1000/port-4800/sess.sock -E claude'),
    ).toBe('dtach');
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
      { pid: 2, klass: 'relay-server', ageMs: 6_000, rssBytes: 100, cwd: '/live', cwdExists: true },
      { pid: 3, klass: 'relay-server', ageMs: 9_000, rssBytes: 200, cwd: '/gone', cwdExists: false },
      { pid: 4, klass: 'dtach', ageMs: null, rssBytes: 50, cwd: null, cwdExists: false },
    ]);
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
      { pid: 2, klass: 'relay-server', ageMs: 1, rssBytes: 100, cwd: null, cwdExists: false },
      { pid: 3, klass: 'relay-server', ageMs: 1, rssBytes: 250, cwd: null, cwdExists: false },
      { pid: 4, klass: 'dtach', ageMs: 1, rssBytes: 75, cwd: null, cwdExists: false },
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
});

describe('selectRelayOrphansToReap', () => {
  const gone = (pid: number, ageMs: number | null): Parameters<typeof selectRelayOrphansToReap>[0][number] => ({
    pid,
    klass: 'relay-server',
    ageMs,
    rssBytes: 0,
    cwd: '/gone',
    cwdExists: false,
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
    };
    expect(selectRelayOrphansToReap([live])).toEqual([]);
    // Only with an explicit ceiling does age alone qualify.
    expect(selectRelayOrphansToReap([live], { maxAgeMs: 2 * 60 * 60 * 1000 }).map((p) => p.pid)).toEqual([9]);
  });

  it('never reaps a relay whose start time is unknown (ageMs null), even with the worktree gone', () => {
    const unknownAge = {
      pid: 3,
      klass: 'relay-server' as const,
      ageMs: null,
      rssBytes: 0,
      cwd: '/gone',
      cwdExists: false,
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
    };
    expect(selectRelayOrphansToReap([dtach], { minAgeMs: 0, maxAgeMs: 0 })).toEqual([]);
  });
});
