import { describe, expect, test } from 'vitest';

import {
  DEFAULT_CONVERGENCE_THRESHOLDS,
  buildConvergenceBaseline,
  classifyDelivery,
  evaluateConvergence,
  extractServingSha,
  formatConvergenceReceipt,
  normalizeSha,
  shasEqual,
} from './deploy-convergence.js';

const NOW = Date.parse('2026-08-02T00:01:00.000Z');
const SERVING = 'bec9bdc'; // #1883: the stranded prod build
const MAIN = 'a1b2c3d';

// ---------------------------------------------------------------------------
// SHA helpers
// ---------------------------------------------------------------------------

describe('normalizeSha', () => {
  test('accepts hex short/full, rejects junk', () => {
    expect(normalizeSha('A1B2C3D')).toBe('a1b2c3d');
    expect(normalizeSha('  deadbeef  ')).toBe('deadbeef');
    expect(normalizeSha('unknown')).toBeNull();
    expect(normalizeSha('dev')).toBeNull(); // dev builds are un-checkable
    expect(normalizeSha('')).toBeNull();
    expect(normalizeSha(null)).toBeNull();
    expect(normalizeSha('zzz')).toBeNull();
  });
});

describe('shasEqual', () => {
  test('matches short vs full by shared prefix', () => {
    expect(shasEqual('a1b2c3d', 'a1b2c3d4e5f6')).toBe(true);
    expect(shasEqual('a1b2c3d4e5f6', 'a1b2c3d')).toBe(true);
    expect(shasEqual('a1b2c3d', 'a1b2c3e')).toBe(false);
    expect(shasEqual('a1b2c3d', null)).toBe(false);
  });
});

describe('extractServingSha', () => {
  test('reads kookr /api/health build block (commitShort then commitHash)', () => {
    expect(extractServingSha({ build: { commitShort: 'A1B2C3D' } })).toBe('a1b2c3d');
    expect(
      extractServingSha({ build: { commitShort: 'dev', commitHash: 'deadbeefcafe' } }),
    ).toBe('deadbeefcafe');
  });

  test('falls back to top-level sha/gitSha/commit fields', () => {
    expect(extractServingSha({ sha: 'A1B2C3D' })).toBe('a1b2c3d');
    expect(extractServingSha({ gitSha: 'deadbeef' })).toBe('deadbeef');
    expect(extractServingSha({ commit: 'cafe1234' })).toBe('cafe1234');
  });

  test('returns null for a dev build or an unrecognized shape', () => {
    expect(extractServingSha({ build: { commitShort: 'dev', commitHash: 'dev' } })).toBeNull();
    expect(extractServingSha({ sha: 'unknown' })).toBeNull();
    expect(extractServingSha(null)).toBeNull();
    expect(extractServingSha('nope')).toBeNull();
    expect(extractServingSha({ build: [] })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// merged vs delivered
// ---------------------------------------------------------------------------

describe('classifyDelivery', () => {
  test('merged until serving includes the commit, then delivered', () => {
    // Merged to main but prod still on the old SHA → merged, not delivered.
    expect(
      classifyDelivery({ commitSha: MAIN, servingSha: SERVING, servingIncludesCommit: false }),
    ).toEqual({ state: 'merged', delivered: false });
    // Serving commit includes it → delivered.
    expect(
      classifyDelivery({
        commitSha: MAIN,
        servingSha: 'a1b2c3daaaa',
        servingIncludesCommit: true,
      }),
    ).toEqual({ state: 'delivered', delivered: true });
    // No ancestry info → falls back to SHA identity.
    expect(classifyDelivery({ commitSha: MAIN, servingSha: MAIN }).state).toBe('delivered');
    expect(classifyDelivery({ commitSha: MAIN, servingSha: SERVING }).state).toBe('merged');
    expect(classifyDelivery({ commitSha: MAIN }).state).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// evaluateConvergence — the invariant
// ---------------------------------------------------------------------------

describe('evaluateConvergence', () => {
  test('converged when serving SHA equals origin/main', () => {
    const r = evaluateConvergence({ servingSha: MAIN, targetSha: MAIN, nowMs: NOW });
    expect(r.ok).toBe(true);
    expect(r.state).toBe('converged');
    expect(r.converged).toBe(true);
    expect(r.divergent).toBe(false);
    expect(r.action).toBe('none');
  });

  test('converged when serving includes target via ancestry (prod ahead of HEAD)', () => {
    const r = evaluateConvergence({
      servingSha: 'ffff000',
      targetSha: MAIN,
      servingIncludesTarget: true,
      nowMs: NOW,
    });
    expect(r.state).toBe('converged');
    expect(r.action).toBe('none');
  });

  test('diverging inside the grace window does not fire', () => {
    const committedAt = NOW - 5 * 60_000; // main advanced 5m ago
    const r = evaluateConvergence({
      servingSha: SERVING,
      targetSha: MAIN,
      servingIncludesTarget: false,
      targetCommittedAtMs: committedAt,
      nowMs: NOW,
    });
    expect(r.state).toBe('diverging');
    expect(r.diverging).toBe(true);
    expect(r.divergent).toBe(false);
    expect(r.action).toBe('none');
    expect(r.divergenceAgeMinutes).toBe(5);
  });

  test('INVARIANT FIRES: merged but prod on old SHA past grace → divergent + redeploy (#1883)', () => {
    // #1883 scenario: origin/main advanced 40 minutes ago (queue-feeder fixes
    // #1849/#1855 merged), prod still serving the pre-fix commit. Grace is 15m.
    const committedAt = NOW - 40 * 60_000;
    const r = evaluateConvergence({
      servingSha: SERVING,
      targetSha: MAIN,
      servingIncludesTarget: false,
      targetCommittedAtMs: committedAt,
      nowMs: NOW,
    });
    expect(r.ok).toBe(true);
    expect(r.state).toBe('divergent');
    expect(r.divergent).toBe(true);
    expect(r.converged).toBe(false);
    expect(r.action).toBe('redeploy');
    expect(r.divergenceAgeMinutes).toBe(40);
    expect(r.message).toMatch(/DIVERGENT/);
    expect(r.message).toMatch(new RegExp(SERVING));
  });

  test('divergence age accrues from the baseline when merge time is unknown', () => {
    const previous = {
      targetSha: MAIN,
      divergenceSince: new Date(NOW - 20 * 60_000).toISOString(),
    };
    const r = evaluateConvergence({
      servingSha: SERVING,
      targetSha: MAIN,
      servingIncludesTarget: false,
      previous,
      nowMs: NOW,
    });
    expect(r.state).toBe('divergent');
    expect(r.divergenceAgeMinutes).toBe(20);
    // A brand-new divergence with no baseline and no merge time starts the
    // clock now → within grace on the first tick.
    const first = evaluateConvergence({
      servingSha: SERVING,
      targetSha: MAIN,
      servingIncludesTarget: false,
      nowMs: NOW,
    });
    expect(first.state).toBe('diverging');
    expect(first.divergenceAgeMinutes).toBe(0);
  });

  test('baseline resets divergence clock when target changes', () => {
    const stalePrev = {
      targetSha: 'eeee111', // an older, unrelated divergence
      divergenceSince: new Date(NOW - 60 * 60_000).toISOString(),
    };
    const r = evaluateConvergence({
      servingSha: SERVING,
      targetSha: MAIN,
      servingIncludesTarget: false,
      previous: stalePrev,
      nowMs: NOW,
    });
    // Different target → prior since is ignored, clock starts now.
    expect(r.divergenceAgeMinutes).toBe(0);
    expect(r.state).toBe('diverging');
  });

  test('custom grace threshold is honored', () => {
    const committedAt = NOW - 5 * 60_000;
    const r = evaluateConvergence({
      servingSha: SERVING,
      targetSha: MAIN,
      servingIncludesTarget: false,
      targetCommittedAtMs: committedAt,
      thresholds: { divergenceGraceMinutes: 3 },
      nowMs: NOW,
    });
    expect(r.state).toBe('divergent');
    expect(r.graceMinutes).toBe(3);
  });

  test('unknown/probe-gap when a SHA is missing → ok:false, no action', () => {
    const r = evaluateConvergence({ servingSha: null, targetSha: MAIN, nowMs: NOW });
    expect(r.ok).toBe(false);
    expect(r.state).toBe('unknown');
    expect(r.action).toBe('none');
    expect(r.message).toMatch(/serving/);
  });
});

describe('buildConvergenceBaseline', () => {
  test('clears divergenceSince when converged, keeps it while diverged', () => {
    const converged = evaluateConvergence({ servingSha: MAIN, targetSha: MAIN, nowMs: NOW });
    expect(buildConvergenceBaseline(converged).divergenceSince).toBeNull();

    const diverged = evaluateConvergence({
      servingSha: SERVING,
      targetSha: MAIN,
      servingIncludesTarget: false,
      targetCommittedAtMs: NOW - 30 * 60_000,
      nowMs: NOW,
    });
    const baseline = buildConvergenceBaseline(diverged);
    expect(baseline.targetSha).toBe(MAIN);
    expect(baseline.divergenceSince).toBeTruthy();
    expect(baseline.state).toBe('divergent');
  });
});

describe('formatConvergenceReceipt', () => {
  test('summarizes each state', () => {
    const converged = evaluateConvergence({ servingSha: MAIN, targetSha: MAIN, nowMs: NOW });
    expect(formatConvergenceReceipt(converged)).toMatch(/converged/);

    const divergent = evaluateConvergence({
      servingSha: SERVING,
      targetSha: MAIN,
      servingIncludesTarget: false,
      targetCommittedAtMs: NOW - 40 * 60_000,
      nowMs: NOW,
    });
    expect(formatConvergenceReceipt(divergent)).toMatch(/DIVERGENT/);
    expect(formatConvergenceReceipt(divergent)).toMatch(/action=redeploy/);

    const unknown = evaluateConvergence({ servingSha: null, targetSha: MAIN });
    expect(formatConvergenceReceipt(unknown)).toMatch(/unknown/);
  });
});

describe('DEFAULT_CONVERGENCE_THRESHOLDS', () => {
  test('is 15 minutes and frozen', () => {
    expect(DEFAULT_CONVERGENCE_THRESHOLDS.divergenceGraceMinutes).toBe(15);
    expect(() => {
      // @ts-expect-error — asserting the frozen object rejects mutation
      DEFAULT_CONVERGENCE_THRESHOLDS.divergenceGraceMinutes = 1;
    }).toThrow();
  });
});
