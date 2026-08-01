import { describe, expect, test } from 'vitest';
import {
  DEFAULT_INCIDENT_LABELS,
  DEFAULT_UNVERIFIED_ALERT_MINUTES,
  buildConvergenceReceipt,
  classifyIncidentCloseOut,
  extractServingSha,
  isIncidentLabeled,
  isStaleUnverified,
  normalizeSha,
  prClosingKeywordForIssue,
  shasEqual,
  shouldCloseIncident,
  verifyDeploySha,
  verifyGeneric,
} from './incident-close-out.js';

describe('isIncidentLabeled', () => {
  test('matches default labels case-insensitively', () => {
    expect(isIncidentLabeled(['bug', 'Incident'])).toBe(true);
    expect(isIncidentLabeled(['P0'])).toBe(true);
    expect(isIncidentLabeled(['prod-incident'])).toBe(true);
    expect(isIncidentLabeled(['bug', 'enhancement'])).toBe(false);
    expect(isIncidentLabeled([])).toBe(false);
    expect(isIncidentLabeled(null)).toBe(false);
  });

  test('honors an override label set', () => {
    expect(isIncidentLabeled(['sev1'], ['sev1'])).toBe(true);
    expect(isIncidentLabeled(['incident'], ['sev1'])).toBe(false);
  });
});

describe('prClosingKeywordForIssue', () => {
  test('uses Refs for incident-labeled issues so merge cannot auto-close', () => {
    expect(prClosingKeywordForIssue(['incident'])).toBe('Refs');
    expect(prClosingKeywordForIssue(['bug', 'p0'])).toBe('Refs');
  });

  test('uses Closes for ordinary issues', () => {
    expect(prClosingKeywordForIssue(['bug'])).toBe('Closes');
    expect(prClosingKeywordForIssue([])).toBe('Closes');
    expect(prClosingKeywordForIssue(undefined)).toBe('Closes');
  });
});

describe('shouldCloseIncident', () => {
  test('only verified-converged may close', () => {
    expect(shouldCloseIncident('verified-converged')).toBe(true);
    for (const state of [
      'open-unfixed',
      'fix-open',
      'fix-merged-unverified',
      're-escalated',
      'not-incident',
      'already-closed',
    ] as const) {
      expect(shouldCloseIncident(state)).toBe(false);
    }
  });
});

describe('SHA helpers', () => {
  test('normalizeSha rejects non-hex and short garbage', () => {
    expect(normalizeSha('  AbcDef12  ')).toBe('abcdef12');
    expect(normalizeSha('unknown')).toBe(null);
    expect(normalizeSha('')).toBe(null);
    expect(normalizeSha(12)).toBe(null);
    expect(normalizeSha('xyz')).toBe(null);
  });

  test('shasEqual tolerates short vs full form', () => {
    expect(shasEqual('abc1234', 'abc1234deadbeef')).toBe(true);
    expect(shasEqual('abc1234deadbeef', 'abc1234')).toBe(true);
    expect(shasEqual('abc1234', 'def5678')).toBe(false);
    expect(shasEqual(null, 'abc')).toBe(false);
  });

  test('extractServingSha reads kookr build.commitHash and top-level aliases', () => {
    expect(
      extractServingSha({
        status: 'ok',
        build: { commitHash: 'deadbeef01', commitShort: 'deadbeef' },
      }),
    ).toBe('deadbeef01');
    expect(extractServingSha({ gitSha: 'cafe0123' })).toBe('cafe0123');
    expect(extractServingSha({ sha: 'babe0001' })).toBe('babe0001');
    expect(extractServingSha({ commit: 'feedface' })).toBe('feedface');
    expect(extractServingSha({ status: 'ok' })).toBe(null);
    expect(extractServingSha(null)).toBe(null);
  });
});

describe('verifyDeploySha', () => {
  test('converges on matching SHAs', () => {
    const r = verifyDeploySha({
      servingSha: 'abc1234dead',
      targetSha: 'abc1234',
    });
    expect(r.ok).toBe(true);
    expect(r.kind).toBe('deploy-sha');
    expect(r.receipt).toMatch(/converged/);
  });

  test('diverges when serving misses target', () => {
    const r = verifyDeploySha({
      servingSha: '1111111',
      targetSha: '2222222',
    });
    expect(r.ok).toBe(false);
    expect(r.receipt).toMatch(/divergent/);
  });

  test('honors explicit ancestry flag over exact equality', () => {
    expect(
      verifyDeploySha({
        servingSha: 'aaaa',
        targetSha: 'bbbb',
        servingIncludesTarget: true,
      }).ok,
    ).toBe(true);
    expect(
      verifyDeploySha({
        servingSha: 'aaaa',
        targetSha: 'aaaa',
        servingIncludesTarget: false,
      }).ok,
    ).toBe(false);
  });

  test('unknown when either SHA is missing', () => {
    const r = verifyDeploySha({ servingSha: null, targetSha: 'abc' });
    expect(r.ok).toBe(false);
    expect(r.receipt).toMatch(/unknown/);
  });
});

describe('classifyIncidentCloseOut', () => {
  const nowMs = Date.parse('2026-08-01T12:00:00.000Z');

  test('not-incident when labels do not match', () => {
    const c = classifyIncidentCloseOut({
      issueState: 'open',
      labels: ['bug'],
      hasMergedFixPr: true,
      nowMs,
    });
    expect(c.state).toBe('not-incident');
    expect(c.mayClose).toBe(false);
    expect(c.staleUnverified).toBe(false);
  });

  test('already-closed is terminal even with a merged fix', () => {
    const c = classifyIncidentCloseOut({
      issueState: 'closed',
      labels: ['incident'],
      hasMergedFixPr: true,
      nowMs,
    });
    expect(c.state).toBe('already-closed');
    expect(c.mayClose).toBe(false);
  });

  test('open-unfixed when no fix PR exists', () => {
    const c = classifyIncidentCloseOut({
      issueState: 'open',
      labels: ['incident'],
      nowMs,
    });
    expect(c.state).toBe('open-unfixed');
    expect(c.mayClose).toBe(false);
  });

  test('fix-open when a fix PR is open but not merged', () => {
    const c = classifyIncidentCloseOut({
      issueState: 'open',
      labels: ['incident'],
      hasOpenFixPr: true,
      nowMs,
    });
    expect(c.state).toBe('fix-open');
    expect(c.mayClose).toBe(false);
  });

  test('fix-merged-unverified when fix merged and no verification yet', () => {
    // Motivating case shape: fix mechanism merged, incident still open, no probe.
    const c = classifyIncidentCloseOut({
      issueState: 'open',
      labels: ['incident'],
      hasMergedFixPr: true,
      fixMergedAt: '2026-08-01T11:50:00.000Z', // 10 min ago — within grace
      nowMs,
    });
    expect(c.state).toBe('fix-merged-unverified');
    expect(c.mayClose).toBe(false);
    expect(c.staleUnverified).toBe(false);
    expect(c.message).toMatch(/not yet verified/i);
  });

  test('stale standing alert when fix-merged-unverified exceeds threshold', () => {
    const mergedAt = new Date(
      nowMs - (DEFAULT_UNVERIFIED_ALERT_MINUTES + 5) * 60_000,
    ).toISOString();
    const c = classifyIncidentCloseOut({
      issueState: 'open',
      labels: ['incident'],
      hasMergedFixPr: true,
      fixMergedAt: mergedAt,
      nowMs,
    });
    expect(c.state).toBe('fix-merged-unverified');
    expect(c.staleUnverified).toBe(true);
    expect(c.message).toMatch(/STALE/);
  });

  test('stale when merged timestamp is missing (cannot hide silently)', () => {
    const c = classifyIncidentCloseOut({
      issueState: 'open',
      labels: ['incident'],
      hasMergedFixPr: true,
      fixMergedAt: null,
      nowMs,
    });
    expect(c.staleUnverified).toBe(true);
  });

  test('verified-converged when deploy-sha probe succeeds after merge', () => {
    const verification = verifyDeploySha({
      servingSha: 'bf39be2abc',
      targetSha: 'bf39be2',
      servingIncludesTarget: true,
    });
    const c = classifyIncidentCloseOut({
      issueState: 'open',
      labels: ['incident'],
      hasMergedFixPr: true,
      fixMergedAt: '2026-07-31T16:58:00.000Z',
      verification,
      nowMs,
    });
    expect(c.state).toBe('verified-converged');
    expect(c.mayClose).toBe(true);
    expect(c.staleUnverified).toBe(false);
    expect(c.message).toMatch(/safe to close/);
  });

  test('re-escalated when verification fails after merge', () => {
    const verification = verifyDeploySha({
      servingSha: '316fde4',
      targetSha: 'bf39be2',
      servingIncludesTarget: false,
    });
    const c = classifyIncidentCloseOut({
      issueState: 'open',
      labels: ['incident'],
      hasMergedFixPr: true,
      verification,
      nowMs,
    });
    expect(c.state).toBe('re-escalated');
    expect(c.mayClose).toBe(false);
    expect(c.message).toMatch(/verification failed/);
  });

  test('merged fix without verification never mayClose — AC1', () => {
    // Explicit acceptance criterion: merge alone must not authorize close.
    const c = classifyIncidentCloseOut({
      issueState: 'open',
      labels: DEFAULT_INCIDENT_LABELS,
      hasMergedFixPr: true,
      hasOpenFixPr: false,
      verification: null,
      nowMs,
    });
    expect(c.mayClose).toBe(false);
    expect(c.state).toBe('fix-merged-unverified');
  });

  test('generic verification can gate close', () => {
    const c = classifyIncidentCloseOut({
      issueState: 'open',
      labels: ['p0'],
      hasMergedFixPr: true,
      verification: verifyGeneric(true, 'generic:probe-ok endpoint=/ready'),
      nowMs,
    });
    expect(c.state).toBe('verified-converged');
    expect(c.mayClose).toBe(true);
  });
});

describe('isStaleUnverified', () => {
  test('only trips on fix-merged-unverified past threshold', () => {
    const nowMs = Date.parse('2026-08-01T12:00:00.000Z');
    expect(
      isStaleUnverified({
        state: 'fix-merged-unverified',
        fixMergedAt: '2026-08-01T11:00:00.000Z',
        nowMs,
        thresholdMinutes: 30,
      }),
    ).toBe(true);
    expect(
      isStaleUnverified({
        state: 'fix-merged-unverified',
        fixMergedAt: '2026-08-01T11:45:00.000Z',
        nowMs,
        thresholdMinutes: 30,
      }),
    ).toBe(false);
    expect(
      isStaleUnverified({
        state: 'verified-converged',
        fixMergedAt: '2026-07-01T00:00:00.000Z',
        nowMs,
      }),
    ).toBe(false);
  });
});

describe('buildConvergenceReceipt', () => {
  test('includes issue, PR list, and verification receipt', () => {
    const body = buildConvergenceReceipt({
      issueNumber: 1810,
      fixPrNumbers: [1851],
      verification: verifyDeploySha({
        servingSha: 'bf39be2',
        targetSha: 'bf39be2',
      }),
      evaluatedAt: '2026-08-01T12:00:00.000Z',
    });
    expect(body).toContain('#1810');
    expect(body).toContain('#1851');
    expect(body).toContain('deploy-sha:converged');
    expect(body).toContain('Merge alone is not resolution');
    expect(body).toContain('2026-08-01T12:00:00.000Z');
  });
});
