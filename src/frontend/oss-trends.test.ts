import { describe, it, expect } from 'vitest';
import {
  computeOssTrends,
  countDelta,
  mergeRateDelta,
  isSparseTrend,
  isStale,
} from './oss-trends.js';
import type {
  ContributionAttempt,
  AttemptState,
  StateObservation,
  LinkedIssueState,
} from '../core/oss-attempt-store.js';

function mkObs(state: AttemptState, at: string): StateObservation {
  return { state, at, source: 'posttool_hook', note: null, url: null };
}

function mkAttempt(
  id: string,
  state: AttemptState,
  history: StateObservation[],
  createdAt?: string,
): ContributionAttempt {
  const created = createdAt ?? history[0]?.at ?? '2026-01-01T00:00:00Z';
  return {
    id,
    repo: 'acme/widget',
    issueNumber: null,
    issueUrl: null,
    prNumber: 1,
    prUrl: null,
    prTitle: null,
    state,
    history,
    closing: null,
    createdAt: created,
    updatedAt: history[history.length - 1]?.at ?? created,
  };
}

// Fixed clock: Monday 2026-04-13 12:00 UTC — middle of a week so week math is obvious.
const NOW = Date.parse('2026-04-13T12:00:00Z');

describe('computeOssTrends', () => {
  it('handles empty input', () => {
    const r = computeOssTrends([], '30d', NOW);
    expect(r.current.opened).toBe(0);
    expect(r.current.merged).toBe(0);
    expect(r.weeklyBars.every((b) => b.opened === 0 && b.merged === 0)).toBe(true);
    expect(r.nonEmptyWeeks).toBe(0);
  });

  it('counts a single opened PR in current window and zero in prior', () => {
    const attempts = [
      mkAttempt('a#1', 'pr_open', [mkObs('pr_open', '2026-04-10T10:00:00Z')]),
    ];
    const r = computeOssTrends(attempts, '30d', NOW);
    expect(r.current.opened).toBe(1);
    expect(r.current.merged).toBe(0);
    expect(r.prior?.opened).toBe(0);
  });

  it('counts a backfilled merged PR using createdAt for opened and history for merged', () => {
    // PR was already merged when Kookr first observed it (refresh poll backfill).
    const attempts = [
      mkAttempt(
        'a#1',
        'merged',
        [mkObs('merged', '2026-04-09T12:00:00Z')],
        '2026-04-09T12:00:00Z',
      ),
    ];
    const r = computeOssTrends(attempts, '30d', NOW);
    expect(r.current.merged).toBe(1);
    // opened still counted via createdAt fallback
    expect(r.current.opened).toBe(1);
  });

  it('splits an opened-then-merged PR across prior (opened) and current (merged) windows', () => {
    // window=30d: current=[NOW-30d, NOW], prior=[NOW-60d, NOW-30d]
    // opened 2026-03-01 (prior), merged 2026-04-10 (current)
    const attempts = [
      mkAttempt('a#1', 'merged', [
        mkObs('pr_open', '2026-03-01T10:00:00Z'),
        mkObs('merged', '2026-04-10T10:00:00Z'),
      ]),
    ];
    const r = computeOssTrends(attempts, '30d', NOW);
    expect(r.current.opened).toBe(0);
    expect(r.current.merged).toBe(1);
    expect(r.prior?.opened).toBe(1);
    expect(r.prior?.merged).toBe(0);
  });

  it('buckets by UTC Monday — event at 2026-04-06T00:00:00Z belongs to that Monday week', () => {
    const attempts = [
      mkAttempt('a#1', 'pr_open', [mkObs('pr_open', '2026-04-06T00:00:00Z')]),
      mkAttempt('a#2', 'pr_open', [mkObs('pr_open', '2026-04-05T23:59:59Z')]),
    ];
    const r = computeOssTrends(attempts, '30d', NOW);
    const mondayApr6 = r.weeklyBars.find((b) => b.weekStart === '2026-04-06');
    const mondayMar30 = r.weeklyBars.find((b) => b.weekStart === '2026-03-30');
    expect(mondayApr6?.opened).toBe(1);
    expect(mondayMar30?.opened).toBe(1);
  });

  it('counts a merged state only once when re-observed', () => {
    const attempts = [
      mkAttempt('a#1', 'merged', [
        mkObs('pr_open', '2026-04-05T10:00:00Z'),
        mkObs('merged', '2026-04-08T10:00:00Z'),
        mkObs('merged', '2026-04-09T10:00:00Z'),
      ]),
    ];
    const r = computeOssTrends(attempts, '30d', NOW);
    expect(r.current.merged).toBe(1);
    expect(r.current.opened).toBe(1);
  });

  it('excludes scouted-only records from every series', () => {
    const scouted = mkAttempt('s#1', 'scouted', [
      mkObs('scouted', '2026-04-10T10:00:00Z'),
    ]);
    const r = computeOssTrends([scouted], '30d', NOW);
    expect(r.current.opened).toBe(0);
    expect(r.current.merged).toBe(0);
    expect(r.nonEmptyWeeks).toBe(0);
  });

  it('prior period with fewer than 3 decided PRs suppresses deltas via caller', () => {
    // Only 2 decided in prior window.
    const prior1 = mkAttempt('p#1', 'merged', [
      mkObs('pr_open', '2026-03-01T10:00:00Z'),
      mkObs('merged', '2026-03-02T10:00:00Z'),
    ]);
    const prior2 = mkAttempt('p#2', 'closed', [
      mkObs('pr_open', '2026-03-05T10:00:00Z'),
      mkObs('closed', '2026-03-06T10:00:00Z'),
    ]);
    const current = mkAttempt('c#1', 'merged', [
      mkObs('pr_open', '2026-04-01T10:00:00Z'),
      mkObs('merged', '2026-04-02T10:00:00Z'),
    ]);
    const r = computeOssTrends([prior1, prior2, current], '30d', NOW);
    expect(r.prior).not.toBeNull();
    // Prior totals: 1 merged + 1 closed = 2 decided → too sparse.
    const delta = countDelta(r.current.opened, r.prior, r.prior?.opened ?? 0);
    expect(delta).toBeNull();
  });

  it('reconstructs open-now snapshot at range boundaries', () => {
    // window=7d: current=[NOW-7d, NOW]=[2026-04-06 12:00, 2026-04-13 12:00],
    //            prior  =[NOW-14d, NOW-7d]=[2026-03-30 12:00, 2026-04-06 12:00]
    // PR opened 2026-04-03 (prior window), merged 2026-04-11 (current window).
    //   current.openNow at NOW = 0 (merged-out before NOW)
    //   prior.openNow at end-of-prior (2026-04-06 12:00) = 1 (not yet merged)
    const attempts = [
      mkAttempt('a#1', 'merged', [
        mkObs('pr_open', '2026-04-03T10:00:00Z'),
        mkObs('merged', '2026-04-11T10:00:00Z'),
      ]),
    ];
    const r = computeOssTrends(attempts, '7d', NOW);
    expect(r.current.openNow).toBe(0);
    expect(r.prior?.openNow).toBe(1);
  });

  it('window=all has no prior period', () => {
    const attempts = [
      mkAttempt('a#1', 'pr_open', [mkObs('pr_open', '2026-04-10T10:00:00Z')]),
    ];
    const r = computeOssTrends(attempts, 'all', NOW);
    expect(r.prior).toBeNull();
    expect(r.current.opened).toBe(1);
  });
});

// `openedAt` is internal to oss-trends.ts; its fallback behavior is
// covered indirectly through the `computeOssTrends` tests above (opened
// counters derive from openedAt, so the refresh-backfill fallback path
// is exercised there).

describe('countDelta', () => {
  const priorOk = {
    opened: 5,
    merged: 2,
    closed: 2,
    openNow: 1,
    mergeRate: 0.5,
    totalDecided: 4,
  };

  it('returns null when prior is null', () => {
    expect(countDelta(7, null, 0)).toBeNull();
  });

  it('returns null when prior.opened < 3', () => {
    const sparse = { ...priorOk, opened: 2 };
    expect(countDelta(7, sparse, sparse.opened)).toBeNull();
  });

  it('formats positive delta with ▲', () => {
    expect(countDelta(7, priorOk, 5)).toEqual({ direction: 'up', label: '▲ +2' });
  });

  it('formats negative delta with ▼', () => {
    expect(countDelta(3, priorOk, 5)).toEqual({ direction: 'down', label: '▼ -2' });
  });

  it('formats zero delta as flat with "no change" label', () => {
    expect(countDelta(5, priorOk, 5)).toEqual({ direction: 'flat', label: '─ no change' });
  });
});

describe('mergeRateDelta', () => {
  const priorOk = {
    opened: 5,
    merged: 2,
    closed: 2,
    openNow: 0,
    mergeRate: 0.5,
    totalDecided: 4,
  };

  it('returns null when prior is null', () => {
    expect(mergeRateDelta(0.6, null)).toBeNull();
  });

  it('returns null when either rate is null', () => {
    expect(mergeRateDelta(null, priorOk)).toBeNull();
    const noDecide = { ...priorOk, mergeRate: null };
    expect(mergeRateDelta(0.5, noDecide)).toBeNull();
  });

  it('formats percentage-point delta', () => {
    expect(mergeRateDelta(0.7, priorOk)).toEqual({ direction: 'up', label: '▲ +20pp' });
    expect(mergeRateDelta(0.3, priorOk)).toEqual({ direction: 'down', label: '▼ -20pp' });
  });
});

describe('isSparseTrend', () => {
  // Threshold constants are internal — behavior is what matters, and
  // the cases below pin it. If we change the thresholds we update both
  // the source and these cases together.

  it('is sparse when weeks are below threshold, regardless of event count', () => {
    expect(isSparseTrend(0, 100)).toBe(true);
    expect(isSparseTrend(2, 100)).toBe(true);
  });

  it('is sparse when events are below threshold, regardless of week count', () => {
    expect(isSparseTrend(10, 0)).toBe(true);
    expect(isSparseTrend(10, 4)).toBe(true);
  });

  it('is sparse when both are below threshold', () => {
    expect(isSparseTrend(0, 0)).toBe(true);
    expect(isSparseTrend(2, 4)).toBe(true);
  });

  it('is not sparse at or above both thresholds', () => {
    expect(isSparseTrend(3, 5)).toBe(false);
    expect(isSparseTrend(4, 10)).toBe(false);
    expect(isSparseTrend(10, 20)).toBe(false);
  });
});

// ----------------------------------------------------------------------------
// Zombie-PR detection (RFC v3.1)
// ----------------------------------------------------------------------------

function mkLinkedClosed(
  closingPrNumber: number | null = 99,
): LinkedIssueState {
  return {
    number: 42,
    state: 'closed',
    closedAt: '2026-04-12T00:00:00Z',
    closingPrNumber,
    verifiedAt: '2026-04-12T01:00:00Z',
  };
}

function mkLinkedOpen(): LinkedIssueState {
  return {
    number: 42,
    state: 'open',
    closedAt: null,
    closingPrNumber: null,
    verifiedAt: '2026-04-12T01:00:00Z',
  };
}

function mkPrOpen(
  prNumber: number,
  linked: LinkedIssueState | null | undefined,
  openedAtIso: string,
): ContributionAttempt {
  const a = mkAttempt(
    `a#${prNumber}`,
    'pr_open',
    [mkObs('pr_open', openedAtIso)],
    openedAtIso,
  );
  a.prNumber = prNumber;
  a.linkedIssue = linked;
  return a;
}

describe('isStale', () => {
  // T-T1: truth table
  it('non-open state → not stale even with closed linked issue', () => {
    const a = mkAttempt('a#1', 'merged', [mkObs('merged', '2026-04-10T00:00:00Z')]);
    a.linkedIssue = mkLinkedClosed();
    expect(isStale(a)).toBe(false);
  });

  it('missing linkedIssue → not stale', () => {
    const a = mkPrOpen(1, null, '2026-04-10T00:00:00Z');
    expect(isStale(a)).toBe(false);
  });

  it('undefined linkedIssue (legacy record) → not stale', () => {
    const a = mkPrOpen(1, undefined, '2026-04-10T00:00:00Z');
    expect(isStale(a)).toBe(false);
  });

  it('open linkedIssue → not stale', () => {
    const a = mkPrOpen(1, mkLinkedOpen(), '2026-04-10T00:00:00Z');
    expect(isStale(a)).toBe(false);
  });

  it('closed linkedIssue closed by a different PR → stale', () => {
    const a = mkPrOpen(1, mkLinkedClosed(99), '2026-04-10T00:00:00Z');
    expect(isStale(a)).toBe(true);
  });

  it('closed linkedIssue closed by THIS PR (self-close race guard) → not stale', () => {
    const a = mkPrOpen(1, mkLinkedClosed(1), '2026-04-10T00:00:00Z');
    expect(isStale(a)).toBe(false);
  });

  it('closed linkedIssue with unknown closer (manual close) → stale', () => {
    // closingPrNumber: null means the close was manual/commit-based.
    // The isStale guard only excludes when closingPrNumber EQUALS own prNumber.
    const a = mkPrOpen(1, mkLinkedClosed(null), '2026-04-10T00:00:00Z');
    expect(isStale(a)).toBe(true);
  });
});

describe('summarizePeriod: stale subtracted from openNow', () => {
  // T-T2: 1 stale + 2 healthy open + 1 merged → openNow=2, stale=1, merged=1
  it('T-T2: stale PRs count separately from openNow', () => {
    const attempts: ContributionAttempt[] = [
      mkPrOpen(1, mkLinkedClosed(99), '2026-04-10T00:00:00Z'), // stale
      mkPrOpen(2, mkLinkedOpen(), '2026-04-10T00:00:00Z'),    // healthy open
      mkPrOpen(3, null, '2026-04-10T00:00:00Z'),               // healthy open (no linked)
      (() => {
        const a = mkAttempt(
          'a#4',
          'merged',
          [
            mkObs('pr_open', '2026-04-09T00:00:00Z'),
            mkObs('merged', '2026-04-10T00:00:00Z'),
          ],
          '2026-04-09T00:00:00Z',
        );
        a.prNumber = 4;
        return a;
      })(),
    ];
    const r = computeOssTrends(attempts, '30d', NOW);
    expect(r.current.openNow).toBe(2);
    expect(r.current.stale).toBe(1);
    expect(r.current.merged).toBe(1);
    // Invariant: opened = merged + closed + openNow + stale
    expect(r.current.opened).toBe(
      r.current.merged + r.current.closed + r.current.openNow + r.current.stale,
    );
  });

  // T-T3: invariant holds across mixed fixtures
  it('T-T3: invariant holds for a mixed fixture', () => {
    const attempts: ContributionAttempt[] = [
      mkPrOpen(10, mkLinkedClosed(), '2026-04-10T00:00:00Z'),
      mkPrOpen(11, mkLinkedClosed(), '2026-04-11T00:00:00Z'),
      mkPrOpen(12, null, '2026-04-09T00:00:00Z'),
      mkPrOpen(13, mkLinkedOpen(), '2026-04-08T00:00:00Z'),
      (() => {
        const a = mkAttempt(
          'a#14',
          'closed',
          [
            mkObs('pr_open', '2026-04-07T00:00:00Z'),
            mkObs('closed', '2026-04-08T00:00:00Z'),
          ],
          '2026-04-07T00:00:00Z',
        );
        a.prNumber = 14;
        return a;
      })(),
    ];
    const r = computeOssTrends(attempts, '30d', NOW);
    expect(r.current.stale).toBe(2);
    expect(r.current.openNow).toBe(2);
    expect(r.current.closed).toBe(1);
    expect(r.current.opened).toBe(
      r.current.merged + r.current.closed + r.current.openNow + r.current.stale,
    );
  });

  // T-T4: a terminal record is never stale even with a closed linked issue
  it('T-T4: terminal merged record with linkedIssue closed is NOT stale', () => {
    const a = mkAttempt(
      'a#1',
      'merged',
      [
        mkObs('pr_open', '2026-04-09T00:00:00Z'),
        mkObs('merged', '2026-04-10T00:00:00Z'),
      ],
      '2026-04-09T00:00:00Z',
    );
    a.prNumber = 1;
    a.linkedIssue = mkLinkedClosed();
    const r = computeOssTrends([a], '30d', NOW);
    expect(r.current.stale).toBe(0);
    expect(r.current.merged).toBe(1);
  });
});
