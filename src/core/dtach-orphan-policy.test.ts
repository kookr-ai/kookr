import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DTACH_ORPHAN_MIN_AGE_MS,
  DEFAULT_DTACH_PRESSURE_SOFT_BOUND,
  DEFAULT_HOST_STALE_DTACH_MAX_REAPS_PER_SWEEP,
  buildDtachOrphanCandidate,
  buildDtachOrphanCandidateFromProcess,
  buildDtachOrphanCandidatesFromProcesses,
  evaluateDtachOrphanReap,
  extractKookrDtachSocketPath,
  planHostStaleDtachReap,
  selectDtachOrphansToReap,
  sessionIdFromDtachSocketPath,
} from './dtach-orphan-policy.js';

describe('extractKookrDtachSocketPath', () => {
  it('extracts the kookr-dtach socket token from a master cmdline', () => {
    expect(
      extractKookrDtachSocketPath(
        'dtach -n /tmp/kookr-dtach/1000/port-4800/kookr-abc.sock -r winch -E claude',
      ),
    ).toBe('/tmp/kookr-dtach/1000/port-4800/kookr-abc.sock');
  });

  it('returns null for non-kookr or socket-less command lines', () => {
    expect(extractKookrDtachSocketPath('dtach -n /tmp/other/foo.sock bash')).toBeNull();
    expect(extractKookrDtachSocketPath('node dist/index.js')).toBeNull();
    expect(extractKookrDtachSocketPath('')).toBeNull();
  });
});

describe('sessionIdFromDtachSocketPath', () => {
  it('strips the .sock suffix from the basename', () => {
    expect(
      sessionIdFromDtachSocketPath('/tmp/kookr-dtach/1000/port-4800/kookr-abc.sock'),
    ).toBe('kookr-abc');
  });

  it('returns null for non-socket paths', () => {
    expect(sessionIdFromDtachSocketPath('/tmp/kookr-dtach/1000/port-4800/rings')).toBeNull();
    expect(sessionIdFromDtachSocketPath('/tmp/kookr-dtach/1000/port-4800/.sock')).toBeNull();
  });
});

describe('buildDtachOrphanCandidate (fixture builder)', () => {
  it('defaults to a positive host-stale candidate', () => {
    const c = buildDtachOrphanCandidate({ pid: 42 });
    expect(c).toMatchObject({
      pid: 42,
      socketExists: false,
      liveSessionPresent: false,
    });
    expect(c.ageMs).toBeGreaterThanOrEqual(DEFAULT_DTACH_ORPHAN_MIN_AGE_MS);
    expect(evaluateDtachOrphanReap(c).shouldReap).toBe(true);
  });

  it('lets tests override a single dimension without rebuilding the rest', () => {
    const live = buildDtachOrphanCandidate({ pid: 1, liveSessionPresent: true });
    expect(live.socketExists).toBe(false);
    expect(live.liveSessionPresent).toBe(true);
    expect(evaluateDtachOrphanReap(live).shouldReap).toBe(false);
  });
});

describe('evaluateDtachOrphanReap', () => {
  it('never selects a master whose session id is still live (safe negative)', () => {
    const verdict = evaluateDtachOrphanReap(
      buildDtachOrphanCandidate({
        pid: 10,
        liveSessionPresent: true,
        // Even with every other signal screaming "orphan", live wins:
        socketExists: false,
        ageMs: 99 * 60 * 60 * 1000,
      }),
    );
    expect(verdict).toMatchObject({
      shouldReap: false,
      reason: 'live_session',
      pid: 10,
    });
  });

  it('never selects a master whose socket file still exists (safe negative)', () => {
    const verdict = evaluateDtachOrphanReap(
      buildDtachOrphanCandidate({
        pid: 11,
        socketExists: true,
        liveSessionPresent: false,
        ageMs: 99 * 60 * 60 * 1000,
      }),
    );
    expect(verdict).toMatchObject({
      shouldReap: false,
      reason: 'socket_present',
      pid: 11,
    });
  });

  it('skips when age is unknown even if the socket is missing (safe negative)', () => {
    const verdict = evaluateDtachOrphanReap(
      buildDtachOrphanCandidate({
        pid: 12,
        socketExists: false,
        liveSessionPresent: false,
        ageMs: null,
      }),
    );
    expect(verdict).toMatchObject({
      shouldReap: false,
      reason: 'unknown_age',
      ageMs: null,
      pid: 12,
    });
  });

  it('treats non-finite ageMs as unknown (fail-closed)', () => {
    for (const ageMs of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const verdict = evaluateDtachOrphanReap(
        buildDtachOrphanCandidate({ pid: 120, ageMs, socketExists: false }),
      );
      expect(verdict.shouldReap).toBe(false);
      expect(verdict.reason).toBe('unknown_age');
    }
  });

  it('skips a missing-socket master younger than minAge (teardown race)', () => {
    const verdict = evaluateDtachOrphanReap(
      buildDtachOrphanCandidate({
        pid: 13,
        socketExists: false,
        ageMs: 5_000,
      }),
      { minAgeMs: DEFAULT_DTACH_ORPHAN_MIN_AGE_MS },
    );
    expect(verdict).toMatchObject({
      shouldReap: false,
      reason: 'too_young',
      ageMs: 5_000,
    });
  });

  it('selects a missing-socket master at or past minAge (positive candidate)', () => {
    const atFloor = evaluateDtachOrphanReap(
      buildDtachOrphanCandidate({
        pid: 14,
        socketExists: false,
        liveSessionPresent: false,
        ageMs: DEFAULT_DTACH_ORPHAN_MIN_AGE_MS,
      }),
    );
    expect(atFloor).toMatchObject({
      shouldReap: true,
      reason: 'missing_socket_aged',
      pid: 14,
      ageMs: DEFAULT_DTACH_ORPHAN_MIN_AGE_MS,
    });

    const older = evaluateDtachOrphanReap(
      buildDtachOrphanCandidate({
        pid: 15,
        ageMs: DEFAULT_DTACH_ORPHAN_MIN_AGE_MS + 1,
      }),
    );
    expect(older.shouldReap).toBe(true);
    expect(older.reason).toBe('missing_socket_aged');
  });

  it('live_session short-circuits before unknown_age (priority)', () => {
    // A live session with unreadable start time must still never be selected.
    const verdict = evaluateDtachOrphanReap(
      buildDtachOrphanCandidate({
        pid: 16,
        liveSessionPresent: true,
        ageMs: null,
        socketExists: false,
      }),
    );
    expect(verdict.reason).toBe('live_session');
    expect(verdict.shouldReap).toBe(false);
  });

  it('socket_present short-circuits before unknown_age', () => {
    const verdict = evaluateDtachOrphanReap(
      buildDtachOrphanCandidate({
        pid: 17,
        socketExists: true,
        ageMs: null,
        liveSessionPresent: false,
      }),
    );
    expect(verdict.reason).toBe('socket_present');
    expect(verdict.shouldReap).toBe(false);
  });

  it('respects a custom minAgeMs', () => {
    const young = buildDtachOrphanCandidate({ pid: 18, ageMs: 30_000 });
    expect(evaluateDtachOrphanReap(young, { minAgeMs: 10_000 }).shouldReap).toBe(true);
    expect(evaluateDtachOrphanReap(young, { minAgeMs: 60_000 }).shouldReap).toBe(false);
  });

  it('allows unparseable sessionId when other signals are strong', () => {
    // Future scanners may see a kookr-dtach master whose socket token is
    // mangled; missing socket + aged still qualifies when not live-marked.
    const verdict = evaluateDtachOrphanReap(
      buildDtachOrphanCandidate({
        pid: 19,
        sessionId: null,
        socketPath: null,
        socketExists: false,
        liveSessionPresent: false,
        ageMs: DEFAULT_DTACH_ORPHAN_MIN_AGE_MS,
      }),
    );
    expect(verdict.shouldReap).toBe(true);
    expect(verdict.reason).toBe('missing_socket_aged');
  });
});

describe('selectDtachOrphansToReap', () => {
  it('returns only positive candidates and preserves order', () => {
    const candidates = [
      buildDtachOrphanCandidate({ pid: 1, liveSessionPresent: true }), // skip
      buildDtachOrphanCandidate({ pid: 2 }), // select
      buildDtachOrphanCandidate({ pid: 3, ageMs: null }), // skip
      buildDtachOrphanCandidate({ pid: 4, socketExists: true }), // skip
      buildDtachOrphanCandidate({ pid: 5, ageMs: DEFAULT_DTACH_ORPHAN_MIN_AGE_MS + 100 }), // select
    ];
    expect(selectDtachOrphansToReap(candidates).map((c) => c.pid)).toEqual([2, 5]);
  });

  it('returns empty when no signals qualify (safe default until wired)', () => {
    expect(selectDtachOrphansToReap([])).toEqual([]);
    expect(
      selectDtachOrphansToReap([
        buildDtachOrphanCandidate({ pid: 1, liveSessionPresent: true }),
        buildDtachOrphanCandidate({ pid: 2, ageMs: null }),
      ]),
    ).toEqual([]);
  });
});

describe('buildDtachOrphanCandidateFromProcess (issue #2356)', () => {
  const sock = '/tmp/kookr-dtach/1000/port-4800/kookr-abc.sock';
  const cmdline = `dtach -n ${sock} -r winch -E claude`;

  it('builds a candidate from cmdline + live set + socket probe', () => {
    const c = buildDtachOrphanCandidateFromProcess(
      { pid: 99, cmdline, startTimeMs: 1_000 },
      {
        now: 1_000 + DEFAULT_DTACH_ORPHAN_MIN_AGE_MS + 5_000,
        liveSessionIds: new Set(),
        socketExists: () => false,
      },
    );
    expect(c).toMatchObject({
      pid: 99,
      sessionId: 'kookr-abc',
      socketPath: sock,
      socketExists: false,
      liveSessionPresent: false,
    });
    expect(c!.ageMs).toBe(DEFAULT_DTACH_ORPHAN_MIN_AGE_MS + 5_000);
  });

  it('marks liveSessionPresent when the session id is in the live set', () => {
    const c = buildDtachOrphanCandidateFromProcess(
      { pid: 1, cmdline, startTimeMs: 0 },
      {
        now: 120_000,
        liveSessionIds: new Set(['kookr-abc']),
        socketExists: () => false,
      },
    );
    expect(c?.liveSessionPresent).toBe(true);
    expect(evaluateDtachOrphanReap(c!).shouldReap).toBe(false);
  });

  it('returns null for non-kookr-dtach command lines', () => {
    expect(
      buildDtachOrphanCandidateFromProcess(
        { pid: 1, cmdline: 'node dist/index.js', startTimeMs: 0 },
        { now: 1, liveSessionIds: new Set(), socketExists: () => false },
      ),
    ).toBeNull();
  });

  it('returns null for kookr-dtach attach clients (masters only, issue #2383)', () => {
    expect(
      buildDtachOrphanCandidateFromProcess(
        {
          pid: 9,
          cmdline: 'dtach -a /tmp/kookr-dtach/1000/port-4800/kookr-abc.sock -E',
          startTimeMs: 0,
        },
        { now: 120_000, liveSessionIds: new Set(), socketExists: () => false },
      ),
    ).toBeNull();
  });

  it('filters a mixed process list to kookr-dtach masters only', () => {
    const built = buildDtachOrphanCandidatesFromProcesses(
      [
        { pid: 1, cmdline: 'bash', startTimeMs: 0 },
        { pid: 2, cmdline, startTimeMs: 0 },
        {
          pid: 3,
          cmdline: 'dtach -a /tmp/kookr-dtach/1000/port-4800/kookr-abc.sock -E',
          startTimeMs: 0,
        },
      ],
      {
        now: 120_000,
        liveSessionIds: new Set(),
        socketExists: () => true,
      },
    );
    expect(built.map((c) => c.pid)).toEqual([2]);
    expect(built[0]!.socketExists).toBe(true);
  });
});

describe('planHostStaleDtachReap (issue #2356)', () => {
  it('refuses all eligible pids when host count is under the soft bound', () => {
    const plan = planHostStaleDtachReap(
      [
        buildDtachOrphanCandidate({ pid: 1 }),
        buildDtachOrphanCandidate({ pid: 2 }),
        buildDtachOrphanCandidate({ pid: 3, liveSessionPresent: true }),
      ],
      { dtachCount: DEFAULT_DTACH_PRESSURE_SOFT_BOUND - 1 },
    );
    expect(plan.underPressure).toBe(false);
    expect(plan.toReap).toEqual([]);
    expect(plan.eligibleCount).toBe(2);
    expect(plan.skippedUnderBound).toBe(2);
    expect(plan.skippedLiveAttached).toBe(1);
    expect(plan.skippedRateLimited).toBe(0);
  });

  it('selects eligible masters when count ≥ soft bound and rate-limits', () => {
    const candidates = Array.from({ length: 8 }, (_, i) =>
      buildDtachOrphanCandidate({ pid: 100 + i }),
    );
    const plan = planHostStaleDtachReap(candidates, {
      dtachCount: DEFAULT_DTACH_PRESSURE_SOFT_BOUND,
      maxReapsPerSweep: DEFAULT_HOST_STALE_DTACH_MAX_REAPS_PER_SWEEP,
    });
    expect(plan.underPressure).toBe(true);
    expect(plan.toReap.map((c) => c.pid)).toEqual([100, 101, 102, 103, 104]);
    expect(plan.skippedRateLimited).toBe(3);
    expect(plan.skippedUnderBound).toBe(0);
  });

  it('never selects live-attached or socket-present masters even under pressure', () => {
    const plan = planHostStaleDtachReap(
      [
        buildDtachOrphanCandidate({ pid: 1, liveSessionPresent: true }),
        buildDtachOrphanCandidate({ pid: 2, socketExists: true }),
        buildDtachOrphanCandidate({ pid: 3 }),
      ],
      { dtachCount: 50, maxReapsPerSweep: 10 },
    );
    expect(plan.toReap.map((c) => c.pid)).toEqual([3]);
    expect(plan.skippedLiveAttached).toBe(1);
    expect(plan.skippedSocketPresent).toBe(1);
  });

  it('softBound <= 0 disables the pressure gate', () => {
    const plan = planHostStaleDtachReap([buildDtachOrphanCandidate({ pid: 9 })], {
      dtachCount: 0,
      softBound: 0,
    });
    expect(plan.underPressure).toBe(true);
    expect(plan.toReap.map((c) => c.pid)).toEqual([9]);
    expect(plan.skippedUnderBound).toBe(0);
  });

  it('maxReapsPerSweep <= 0 selects nobody (rate-limit closed)', () => {
    const plan = planHostStaleDtachReap([buildDtachOrphanCandidate({ pid: 1 })], {
      dtachCount: 99,
      maxReapsPerSweep: 0,
    });
    expect(plan.toReap).toEqual([]);
    expect(plan.skippedRateLimited).toBe(1);
  });
});
