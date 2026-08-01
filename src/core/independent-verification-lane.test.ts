import { describe, expect, test } from 'vitest';
import {
  DEFAULT_SWEEP_LIMIT,
  INCIDENT_LANE_MARKER,
  LANE_CAPABILITIES,
  MAX_SWEEP_LIMIT,
  assertTighteningOnlyAction,
  boundSweepLimit,
  buildIncidentReport,
  classifySuiteExit,
  incidentDedupeKey,
  laneActionForRun,
  resolveCadence,
  selectVerificationTargets,
  shortSha,
  shouldFileIncident,
} from './independent-verification-lane.js';

describe('LANE_CAPABILITIES', () => {
  test('lane is flag/incident only — never approves, merges, or loosens', () => {
    expect(LANE_CAPABILITIES.canFileIncident).toBe(true);
    expect(LANE_CAPABILITIES.canFlag).toBe(true);
    expect(LANE_CAPABILITIES.canMerge).toBe(false);
    expect(LANE_CAPABILITIES.canApprove).toBe(false);
    expect(LANE_CAPABILITIES.canLoosenGate).toBe(false);
  });

  test('manifest is frozen', () => {
    expect(Object.isFrozen(LANE_CAPABILITIES)).toBe(true);
  });
});

describe('assertTighteningOnlyAction', () => {
  test('allows flag/incident actions', () => {
    for (const a of ['file-incident', 'flag', 'record-green', 'record-error', 'noop'] as const) {
      expect(assertTighteningOnlyAction(a)).toBe(a);
    }
  });

  test('throws on any approve/merge/close/loosen action', () => {
    for (const a of ['merge', 'approve', 'close-issue', 'loosen-gate']) {
      expect(() => assertTighteningOnlyAction(a)).toThrow(/flag\/incident only/);
    }
  });
});

describe('resolveCadence', () => {
  test('defaults to the bounded rolling sweep', () => {
    expect(resolveCadence(undefined)).toBe('rolling-sweep');
    expect(resolveCadence('')).toBe('rolling-sweep');
    expect(resolveCadence('sweep')).toBe('rolling-sweep');
    expect(resolveCadence('rolling-sweep')).toBe('rolling-sweep');
  });

  test('recognizes per-merge aliases', () => {
    expect(resolveCadence('per-merge')).toBe('per-merge');
    expect(resolveCadence('perMerge')).toBe('per-merge');
    expect(resolveCadence('MERGE')).toBe('per-merge');
  });
});

describe('boundSweepLimit', () => {
  test('defaults and clamps to [1, MAX]', () => {
    expect(boundSweepLimit(undefined)).toBe(DEFAULT_SWEEP_LIMIT);
    expect(boundSweepLimit(NaN)).toBe(DEFAULT_SWEEP_LIMIT);
    expect(boundSweepLimit(0)).toBe(1);
    expect(boundSweepLimit(-3)).toBe(1);
    expect(boundSweepLimit(3)).toBe(3);
    expect(boundSweepLimit(1000)).toBe(MAX_SWEEP_LIMIT);
    expect(boundSweepLimit(3.9)).toBe(3);
  });
});

describe('selectVerificationTargets', () => {
  const merged = [
    { sha: 'aaaaaaaaaaaa1111', prNumber: 10, subject: 'c', mergedAt: '2026-08-01T03:00:00Z' },
    { sha: 'bbbbbbbbbbbb2222', prNumber: 9, subject: 'b', mergedAt: '2026-08-01T02:00:00Z' },
    { sha: 'cccccccccccc3333', prNumber: 8, subject: 'a', mergedAt: '2026-08-01T01:00:00Z' },
  ];

  test('per-merge returns the single named target with metadata', () => {
    const out = selectVerificationTargets({
      cadence: 'per-merge',
      merged,
      targetSha: 'bbbbbbbbbbbb2222',
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ sha: 'bbbbbbbbbbbb2222', prNumber: 9 });
  });

  test('per-merge tolerates a short SHA and unknown-to-window SHA', () => {
    expect(selectVerificationTargets({ cadence: 'per-merge', merged, targetSha: 'bbbbbbbb' })[0].sha).toBe(
      'bbbbbbbbbbbb2222',
    );
    const unknown = selectVerificationTargets({
      cadence: 'per-merge',
      merged,
      targetSha: 'deadbeefdead',
    });
    expect(unknown).toEqual([{ sha: 'deadbeefdead' }]);
  });

  test('per-merge skips an already-verified SHA', () => {
    expect(
      selectVerificationTargets({
        cadence: 'per-merge',
        merged,
        targetSha: 'bbbbbbbbbbbb2222',
        alreadyVerified: ['bbbbbbbbbbbb2222'],
      }),
    ).toEqual([]);
  });

  test('rolling-sweep returns un-verified commits newest-first, deduped', () => {
    const out = selectVerificationTargets({
      cadence: 'rolling-sweep',
      merged,
      alreadyVerified: ['cccccccccccc3333'],
    });
    expect(out.map((t) => t.sha)).toEqual(['aaaaaaaaaaaa1111', 'bbbbbbbbbbbb2222']);
  });

  test('rolling-sweep honors the (clamped) sweep limit', () => {
    const out = selectVerificationTargets({ cadence: 'rolling-sweep', merged, sweepLimit: 1 });
    expect(out.map((t) => t.sha)).toEqual(['aaaaaaaaaaaa1111']);
    expect(selectVerificationTargets({ cadence: 'rolling-sweep', merged, sweepLimit: 999 })).toHaveLength(3);
  });

  test('rolling-sweep dedups short-vs-full already-verified SHAs', () => {
    const out = selectVerificationTargets({
      cadence: 'rolling-sweep',
      merged,
      alreadyVerified: ['aaaaaaaa'],
    });
    expect(out.map((t) => t.sha)).toEqual(['bbbbbbbbbbbb2222', 'cccccccccccc3333']);
  });

  test('drops malformed SHAs', () => {
    const out = selectVerificationTargets({
      cadence: 'rolling-sweep',
      merged: [{ sha: 'not-a-sha' }, { sha: 'aaaaaaaaaaaa1111' }],
    });
    expect(out.map((t) => t.sha)).toEqual(['aaaaaaaaaaaa1111']);
  });
});

describe('classifySuiteExit / decisions', () => {
  test('green on 0, red on non-zero', () => {
    expect(classifySuiteExit(0)).toBe('green');
    expect(classifySuiteExit(1)).toBe('red');
    expect(classifySuiteExit(3)).toBe('red');
  });

  test('infra error overrides exit code and does not file an incident', () => {
    expect(classifySuiteExit(1, { infraError: true })).toBe('error');
    expect(shouldFileIncident('error')).toBe(false);
  });

  test('only red files an incident', () => {
    expect(shouldFileIncident('red')).toBe(true);
    expect(shouldFileIncident('green')).toBe(false);
  });

  test('lane action maps status → tightening-only action', () => {
    expect(laneActionForRun('red')).toBe('file-incident');
    expect(laneActionForRun('green')).toBe('record-green');
    expect(laneActionForRun('error')).toBe('record-error');
    // every produced action survives the tightening-only guard
    for (const s of ['red', 'green', 'error'] as const) {
      expect(() => assertTighteningOnlyAction(laneActionForRun(s))).not.toThrow();
    }
  });
});

describe('shortSha / incidentDedupeKey', () => {
  test('normalizes and truncates', () => {
    expect(shortSha('ABCDEF0123456789abcdef')).toBe('abcdef012345');
    expect(incidentDedupeKey('ABCDEF0123456789')).toBe('iv-lane:abcdef012345');
  });
});

describe('buildIncidentReport', () => {
  const base = {
    sha: 'abcdef0123456789abcdef0123456789abcdef01',
    prNumber: 1850,
    subject: 'fix(merge): handle null rollup',
    mergedAt: '2026-08-01T12:00:00Z',
    repo: 'kookr-ai/kookr',
    suite: 'pnpm test',
    evaluatedAt: '2026-08-01T12:30:00Z',
  };

  test('title, labels, and dedup key', () => {
    const r = buildIncidentReport(base);
    expect(r.title).toBe('Independent verification: full suite RED on merged abcdef012345 (PR #1850)');
    expect(r.labels).toEqual(['incident']);
    expect(r.dedupeKey).toBe('iv-lane:abcdef012345');
  });

  test('body carries machine-readable lines and the grep-able marker', () => {
    const r = buildIncidentReport(base);
    expect(r.body).toContain(INCIDENT_LANE_MARKER);
    expect(r.body).toContain('iv-lane-verdict: red');
    expect(r.body).toContain(`iv-lane-sha: ${base.sha}`);
    expect(r.body).toContain('iv-lane-pr: 1850');
    expect(r.body).toContain('iv-lane-suite: pnpm test');
    expect(r.body).toContain('iv-lane-dedupe: iv-lane:abcdef012345');
  });

  test('body never uses a GitHub closing keyword and cites the close-out gate', () => {
    const r = buildIncidentReport(base);
    expect(r.body).not.toMatch(/\b(Closes|Fixes|Resolves)\s+#/i);
    expect(r.body).toContain('#1750/#1802');
    expect(r.body).toContain('flag/incident-only');
  });

  test('honors custom labels and omits absent metadata', () => {
    const r = buildIncidentReport({ sha: base.sha, suite: 'pnpm test', labels: ['incident', 'p0'] });
    expect(r.labels).toEqual(['incident', 'p0']);
    expect(r.body).toContain('iv-lane-pr: -');
    expect(r.body).not.toContain('- PR:');
  });

  test('clamps an oversized log excerpt', () => {
    const big = 'x'.repeat(10_000);
    const r = buildIncidentReport({ ...base, logExcerpt: big });
    expect(r.body).toContain('…(truncated)…');
    expect(r.body.length).toBeLessThan(big.length + 2_000);
  });
});
