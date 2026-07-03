import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STALE_THRESHOLD_DAYS,
  buildSweepReport,
  dispositionRemovedPath,
  isBlockedClassification,
  isProbablySafe,
  reconstructRemovedFromLedger,
  type BuildSweepReportInput,
} from './sweep-report.js';
import type {
  AttemptDisposition,
  CleanupCandidateAssessment,
  CleanupClassification,
  CleanupResultSummary,
  SweepReportRow,
  WorkspaceAttemptRecord,
} from '../shared/contracts/workspace.js';

const NOW = Date.parse('2026-07-03T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

function candidate(
  classification: CleanupClassification,
  overrides: Partial<CleanupCandidateAssessment> = {},
): CleanupCandidateAssessment {
  const branch = overrides.branch ?? `br-${classification}`;
  return {
    projectId: 'proj',
    worktreePath: overrides.worktreePath ?? `/wt/${branch}`,
    branch,
    classification,
    reasonCode: overrides.reasonCode ?? 'reason',
    source: 'cleanup_inspector',
    observedAt: new Date(NOW).toISOString(),
    recoveryGuidance: 'guidance',
    capabilities: {
      canSafeRemove: false,
      canRemovePathKeepBranch: false,
      canReviewedDiscard: false,
      requiresDirtyRecovery: false,
      defaultActionLabel: 'x',
      riskSummary: 'x',
    },
    ...overrides,
  };
}

function baseInput(overrides: Partial<BuildSweepReportInput> = {}): BuildSweepReportInput {
  return {
    runId: 'run-1',
    generatedAt: new Date(NOW).toISOString(),
    nowMs: NOW,
    summaries: [],
    safeCandidates: [],
    nonRemoved: [],
    footprints: new Map(),
    indexMtimes: new Map(),
    ignoredScans: new Map(),
    fingerprints: new Map(),
    ...overrides,
  };
}

function rowFor(rows: SweepReportRow[], path: string): SweepReportRow {
  const row = rows.find((r) => r.worktreePath === path);
  if (!row) throw new Error(`no row for ${path}`);
  return row;
}

describe('dispositionRemovedPath (canonical map)', () => {
  const removed: AttemptDisposition[] = [
    'completed',
    'path_removed_branch_retained',
    'prune_failed',
    'branch_delete_failed',
  ];
  const notRemoved: AttemptDisposition[] = ['passed', 'blocked', 'manual_intervention_required'];

  it.each(removed)('%s → path removed', (d) => {
    expect(dispositionRemovedPath(d)).toBe(true);
  });
  it.each(notRemoved)('%s → path NOT removed', (d) => {
    expect(dispositionRemovedPath(d)).toBe(false);
  });
});

describe('isBlockedClassification', () => {
  it('classifies the blocked set', () => {
    for (const c of ['busy', 'protected', 'checked_out_elsewhere', 'unknown'] as CleanupClassification[]) {
      expect(isBlockedClassification(c)).toBe(true);
    }
    for (const c of ['merged', 'patch_equivalent', 'unique_commits', 'dirty', 'generated_only', 'stale_worktree'] as CleanupClassification[]) {
      expect(isBlockedClassification(c)).toBe(false);
    }
  });
});

describe('isProbablySafe', () => {
  const stale = NOW - 30 * DAY;
  const recent = NOW - 3 * DAY;
  it('true only for stale clean unique_commits', () => {
    expect(isProbablySafe({ classification: 'unique_commits' }, stale, NOW)).toBe(true);
    expect(isProbablySafe({ classification: 'unique_commits' }, recent, NOW)).toBe(false);
    expect(isProbablySafe({ classification: 'dirty' }, stale, NOW)).toBe(false);
  });
  it('fails safe on missing / future mtime', () => {
    expect(isProbablySafe({ classification: 'unique_commits' }, null, NOW)).toBe(false);
    expect(isProbablySafe({ classification: 'unique_commits' }, NOW + DAY, NOW)).toBe(false);
  });
  it('honors the threshold boundary (strictly greater)', () => {
    const exactly = NOW - DEFAULT_STALE_THRESHOLD_DAYS * DAY;
    expect(isProbablySafe({ classification: 'unique_commits' }, exactly, NOW)).toBe(false);
    expect(isProbablySafe({ classification: 'unique_commits' }, exactly - 1, NOW)).toBe(true);
  });
});

describe('buildSweepReport — removed / removal-failed from disposition', () => {
  const safe = [candidate('merged', { branch: 'ok', worktreePath: '/wt/ok' }),
    candidate('patch_equivalent', { branch: 'kept', worktreePath: '/wt/kept' }),
    candidate('merged', { branch: 'prunefail', worktreePath: '/wt/prunefail' }),
    candidate('merged', { branch: 'branchfail', worktreePath: '/wt/branchfail' }),
    candidate('merged', { branch: 'threw', worktreePath: '/wt/threw' })];

  const summaries: CleanupResultSummary[] = [
    { branch: 'ok', disposition: 'completed', pathRemoved: true, branchRemoved: true },
    { branch: 'kept', disposition: 'path_removed_branch_retained', pathRemoved: true, branchRemoved: false, retainedReason: 'user_requested_keep_branch' },
    { branch: 'prunefail', disposition: 'prune_failed', pathRemoved: true, branchRemoved: false, errorKind: 'prune_failed' },
    { branch: 'branchfail', disposition: 'branch_delete_failed', pathRemoved: true, branchRemoved: false, errorKind: 'branch_delete_failed' },
    // 'threw' produced no summary (manual_intervention_required)
  ];

  it('buckets all four removed-dispositions as removed and the missing one as removal_failed', () => {
    const report = buildSweepReport(baseInput({ safeCandidates: safe, summaries }));
    expect(rowFor(report.rows, '/wt/ok').bucket).toBe('removed');
    expect(rowFor(report.rows, '/wt/kept').bucket).toBe('removed');
    expect(rowFor(report.rows, '/wt/prunefail').bucket).toBe('removed');
    expect(rowFor(report.rows, '/wt/branchfail').bucket).toBe('removed');
    const threw = rowFor(report.rows, '/wt/threw');
    expect(threw.bucket).toBe('removal_failed');
    expect(threw.disposition).toBe('manual_intervention_required');
    expect(report.buckets.removed.count).toBe(4);
    expect(report.buckets.removal_failed.count).toBe(1);
  });

  it('keeps counts exact when two projects share a branch name (one removed, one failed)', () => {
    const collide = [
      candidate('merged', { branch: 'shared', worktreePath: '/a/shared', projectId: 'A' }),
      candidate('merged', { branch: 'shared', worktreePath: '/b/shared', projectId: 'B' }),
    ];
    // Only one of the two same-named branches produced a removal summary.
    const oneSummary: CleanupResultSummary[] = [
      { branch: 'shared', disposition: 'completed', pathRemoved: true, branchRemoved: true },
    ];
    const report = buildSweepReport(baseInput({ safeCandidates: collide, summaries: oneSummary }));
    expect(report.buckets.removed.count).toBe(1);
    expect(report.buckets.removal_failed.count).toBe(1);
  });

  it('measures footprint for the still-on-disk removal_failed row', () => {
    const report = buildSweepReport(baseInput({
      safeCandidates: safe,
      summaries,
      footprints: new Map([['/wt/threw', 4096]]),
    }));
    expect(rowFor(report.rows, '/wt/threw').footprintBytes).toBe(4096);
  });
});

describe('buildSweepReport — non-removed bucketing over all classifications', () => {
  const stale = NOW - 30 * DAY;
  const recent = NOW - 2 * DAY;

  it('routes each classification to the right bucket', () => {
    const nonRemoved = [
      candidate('unique_commits', { branch: 'uc-stale', worktreePath: '/wt/uc-stale' }),
      candidate('unique_commits', { branch: 'uc-recent', worktreePath: '/wt/uc-recent' }),
      candidate('unique_commits', { branch: 'uc-unknown', worktreePath: '/wt/uc-unknown' }),
      candidate('dirty', { worktreePath: '/wt/dirty' }),
      candidate('generated_only', { worktreePath: '/wt/generated' }),
      candidate('stale_worktree', { worktreePath: '/wt/stale-wt' }),
      candidate('busy', { worktreePath: '/wt/busy' }),
      candidate('protected', { worktreePath: '/wt/protected' }),
      candidate('checked_out_elsewhere', { worktreePath: '/wt/checked-out' }),
      candidate('unknown', { worktreePath: '/wt/unknown' }),
    ];
    const indexMtimes = new Map<string, number | null>([
      ['/wt/uc-stale', stale],
      ['/wt/uc-recent', recent],
      ['/wt/uc-unknown', null],
    ]);
    const report = buildSweepReport(baseInput({ nonRemoved, indexMtimes }));

    expect(rowFor(report.rows, '/wt/uc-stale').bucket).toBe('probably_safe');
    expect(rowFor(report.rows, '/wt/uc-recent').bucket).toBe('needs_call');
    expect(rowFor(report.rows, '/wt/uc-unknown').bucket).toBe('needs_call');
    expect(rowFor(report.rows, '/wt/dirty').bucket).toBe('needs_call');
    expect(rowFor(report.rows, '/wt/generated').bucket).toBe('needs_call');
    expect(rowFor(report.rows, '/wt/stale-wt').bucket).toBe('needs_call');
    for (const p of ['/wt/busy', '/wt/protected', '/wt/checked-out', '/wt/unknown']) {
      expect(rowFor(report.rows, p).bucket).toBe('blocked');
    }
  });

  it('does not measure footprint for blocked rows', () => {
    const nonRemoved = [candidate('busy', { worktreePath: '/wt/busy' })];
    const report = buildSweepReport(baseInput({
      nonRemoved,
      footprints: new Map([['/wt/busy', 9999]]),
    }));
    expect(rowFor(report.rows, '/wt/busy').footprintBytes).toBeNull();
  });

  it('carries hasSensitiveIgnored + fingerprint onto probably-safe rows', () => {
    const nonRemoved = [candidate('unique_commits', { branch: 'uc', worktreePath: '/wt/uc' })];
    const report = buildSweepReport(baseInput({
      nonRemoved,
      indexMtimes: new Map([['/wt/uc', stale]]),
      ignoredScans: new Map([['/wt/uc', { hasSensitiveIgnored: true, sample: ['.env'] }]]),
      fingerprints: new Map([['/wt/uc', 'fp-123']]),
    }));
    const row = rowFor(report.rows, '/wt/uc');
    expect(row.hasSensitiveIgnored).toBe(true);
    expect(row.ignoredSample).toEqual(['.env']);
    expect(row.fingerprint).toBe('fp-123');
  });
});

describe('buildSweepReport — bucket summaries (footprint upper bound)', () => {
  it('sums known footprints and counts unknown ones separately', () => {
    const stale = NOW - 30 * DAY;
    const nonRemoved = [
      candidate('unique_commits', { branch: 'a', worktreePath: '/wt/a' }),
      candidate('unique_commits', { branch: 'b', worktreePath: '/wt/b' }),
    ];
    const report = buildSweepReport(baseInput({
      nonRemoved,
      indexMtimes: new Map([['/wt/a', stale], ['/wt/b', stale]]),
      footprints: new Map([['/wt/a', 1000], ['/wt/b', null]]),
    }));
    expect(report.buckets.probably_safe.count).toBe(2);
    expect(report.buckets.probably_safe.footprintBytesUpperBound).toBe(1000);
    expect(report.buckets.probably_safe.unknownFootprintCount).toBe(1);
  });
});

describe('buildSweepReport — not-analyzed banner passthrough', () => {
  it('carries the pre-classification worktree count', () => {
    const report = buildSweepReport(baseInput({
      notAnalyzed: [{ projectId: 'big', code: 'timeout', notAnalyzedCount: 42 }],
    }));
    expect(report.notAnalyzed).toEqual([{ projectId: 'big', code: 'timeout', notAnalyzedCount: 42 }]);
  });
});

describe('reconstructRemovedFromLedger', () => {
  function attempt(overrides: Partial<WorkspaceAttemptRecord>): WorkspaceAttemptRecord {
    return {
      attemptId: overrides.attemptId ?? Math.random().toString(36),
      type: 'cleanup',
      projectId: 'proj',
      reasonCode: 'cleanup_requested',
      source: 'cross_project_sweep',
      observedAt: new Date(NOW).toISOString(),
      startedAt: new Date(NOW).toISOString(),
      status: 'completed',
      disposition: 'completed',
      evidenceSummary: 'x',
      sweepRunId: 'run-1',
      worktreePath: '/wt/x',
      branch: 'x',
      ...overrides,
    };
  }

  it('reconstructs Removed + removal_failed using the same disposition map, excluding blocked/passed/umbrella', () => {
    const attempts: WorkspaceAttemptRecord[] = [
      attempt({ worktreePath: '/wt/done', branch: 'done', disposition: 'completed' }),
      attempt({ worktreePath: '/wt/kept', branch: 'kept', disposition: 'path_removed_branch_retained' }),
      attempt({ worktreePath: '/wt/prune', branch: 'prune', disposition: 'prune_failed' }),
      attempt({ worktreePath: '/wt/bd', branch: 'bd', disposition: 'branch_delete_failed' }),
      attempt({ worktreePath: '/wt/fail', branch: 'fail', disposition: 'manual_intervention_required' }),
      attempt({ worktreePath: '/wt/crash', branch: 'crash', disposition: 'blocked' }),
      attempt({ worktreePath: undefined, branch: undefined, disposition: 'passed', reasonCode: 'cross_project_sweep' }),
      attempt({ worktreePath: '/wt/other', branch: 'other', disposition: 'completed', sweepRunId: 'run-2' }),
    ];
    const report = reconstructRemovedFromLedger(attempts, 'run-1', new Date(NOW).toISOString());
    expect(report.reconstructedFromLedger).toBe(true);
    expect(report.buckets.removed.count).toBe(4);
    expect(report.buckets.removal_failed.count).toBe(1);
    expect(rowFor(report.rows, '/wt/fail').bucket).toBe('removal_failed');
    // crashed (blocked), umbrella (passed/no path), and other-run rows excluded
    expect(report.rows.find((r) => r.worktreePath === '/wt/crash')).toBeUndefined();
    expect(report.rows.find((r) => r.worktreePath === '/wt/other')).toBeUndefined();
    expect(report.rows.length).toBe(5);
  });
});
