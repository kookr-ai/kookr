import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_REFACTOR_PER_WINDOW,
  DEFAULT_MIN_DRIFT_SCORE_DELTA,
  VALUE_DENSITY_SCHEMA,
  buildDeclineRecord,
  classifyWorkClass,
  classifyWorkItem,
  compositionSnapshotPath,
  computeComposition,
  declinedIdeasPath,
  evaluateAdmission,
  formatCompositionLine,
  isCosmeticRefactor,
  isProductMetricBlocking,
  selectCandidates,
  type RankedCandidate,
} from './value-density-governor.js';

describe('classifyWorkClass', () => {
  it('maps conventional-commit prefixes', () => {
    expect(classifyWorkClass('feat: add anchors')).toBe('feat');
    expect(classifyWorkClass('fix(server): race')).toBe('fix');
    expect(classifyWorkClass('refactor: extract helper')).toBe('refactor');
    expect(classifyWorkClass('docs: clarify')).toBe('docs');
    expect(classifyWorkClass('test: cover gate')).toBe('test');
    expect(classifyWorkClass('chore: bump')).toBe('chore');
    expect(classifyWorkClass('perf: cache')).toBe('perf');
    expect(classifyWorkClass('ops: redeploy')).toBe('ops');
  });

  it('treats arch: and architecture labels as refactor', () => {
    expect(classifyWorkClass('arch: share cleanHtmlText')).toBe('refactor');
    expect(classifyWorkClass('split module', ['architecture'])).toBe('refactor');
  });

  it('falls back to title heuristics', () => {
    expect(classifyWorkClass('share isoNow across reporters')).toBe('refactor');
    expect(classifyWorkClass('fix flaky deploy probe')).toBe('fix');
  });
});

describe('isCosmeticRefactor', () => {
  it('matches the 2026-08-01 micro-consolidation titles', () => {
    expect(isCosmeticRefactor('arch: share cleanHtmlText')).toBe(true);
    expect(isCosmeticRefactor('refactor: share clip(s,n)')).toBe(true);
    expect(isCosmeticRefactor('share isoNow')).toBe(true);
    expect(isCosmeticRefactor('export one throwIfAborted')).toBe(true);
    expect(isCosmeticRefactor('consolidate hostOf')).toBe(true);
    expect(isCosmeticRefactor('extract shared sha256Hex')).toBe(true);
    expect(isCosmeticRefactor('share parseTickerArgs')).toBe(true);
    expect(isCosmeticRefactor('share wrapUntrustedFence')).toBe(true);
    expect(isCosmeticRefactor('stop dump-barrel re-exports')).toBe(true);
  });

  it('does not flag substantive refactors by default', () => {
    expect(isCosmeticRefactor('refactor: split launch-service into use-cases')).toBe(false);
    expect(isCosmeticRefactor('feat: SEC-anchor acceptance probe')).toBe(false);
  });
});

describe('isProductMetricBlocking', () => {
  it('matches labels and title keywords', () => {
    expect(isProductMetricBlocking('anything', ['product-metric'])).toBe(true);
    expect(isProductMetricBlocking('anything', ['sec-anchor'])).toBe(true);
    expect(isProductMetricBlocking('anything', ['acquisition'])).toBe(true);
    expect(isProductMetricBlocking('Umbrella: SEC-anchor acceptance truth')).toBe(true);
    expect(isProductMetricBlocking('Umbrella: acquisition redundancy & failover')).toBe(true);
    expect(isProductMetricBlocking('chore: tidy logs')).toBe(false);
  });
});

describe('evaluateAdmission', () => {
  it('admits non-refactor work unrestricted', () => {
    const v = evaluateAdmission(
      { title: 'feat: ship anchors' },
      { refactorAdmitted: 99 },
    );
    expect(v.action).toBe('admit');
    expect(v.reasonCode).toBe('admitted');
    expect(v.classification.workClass).toBe('feat');
  });

  it('declines cosmetic refactors without a drift-score-delta', () => {
    const v = evaluateAdmission(
      { title: 'arch: share cleanHtmlText' },
      { refactorAdmitted: 0 },
    );
    expect(v.action).toBe('decline');
    expect(v.reasonCode).toBe('cosmetic_subthreshold');
    expect(v.reason).toMatch(/cosmetic refactor declined/i);
  });

  it('declines cosmetic refactors below min drift-score-delta', () => {
    const v = evaluateAdmission(
      { title: 'arch: share isoNow', driftScoreDelta: 0.2 },
      { refactorAdmitted: 0 },
      { minDriftScoreDelta: DEFAULT_MIN_DRIFT_SCORE_DELTA },
    );
    expect(v.action).toBe('decline');
    expect(v.reasonCode).toBe('drift_score_below_min');
  });

  it('admits cosmetic refactors that clear the drift-score floor within budget', () => {
    const v = evaluateAdmission(
      { title: 'arch: share cleanHtmlText', driftScoreDelta: 2.5 },
      { refactorAdmitted: 1 },
    );
    expect(v.action).toBe('admit');
    expect(v.classification.cosmetic).toBe(true);
  });

  it('enforces the configurable refactor-class cap', () => {
    const v = evaluateAdmission(
      { title: 'refactor: split god-module into three', driftScoreDelta: 5 },
      { refactorAdmitted: DEFAULT_MAX_REFACTOR_PER_WINDOW },
    );
    expect(v.action).toBe('decline');
    expect(v.reasonCode).toBe('refactor_cap_reached');
    expect(v.window.remainingRefactorBudget).toBe(0);
  });

  it('always admits product-metric-blocking work', () => {
    const v = evaluateAdmission(
      {
        title: 'arch: share helper for SEC-anchor report',
        labels: ['product-metric'],
      },
      { refactorAdmitted: 99 },
    );
    expect(v.action).toBe('admit');
    expect(v.classification.productMetricBlocking).toBe(true);
  });

  it('admits non-cosmetic refactors under the cap without a score', () => {
    const v = evaluateAdmission(
      { title: 'refactor: split launch-service into use-cases' },
      { refactorAdmitted: 0 },
    );
    expect(v.action).toBe('admit');
    expect(v.classification.cosmetic).toBe(false);
  });
});

describe('selectCandidates', () => {
  it('caps cosmetic refactors and redirects surplus to product-metric work', () => {
    const candidates: RankedCandidate[] = [
      { id: 'r1', title: 'arch: share cleanHtmlText' },
      { id: 'r2', title: 'arch: share isoNow' },
      { id: 'r3', title: 'arch: consolidate hostOf' },
      { id: 'r4', title: 'arch: extract shared sha256Hex' },
      { id: 'r5', title: 'arch: share parseTickerArgs' },
      {
        id: 'p1',
        title: 'feat: SEC-anchor acceptance probe',
        labels: ['product-metric'],
        priority: 10,
      },
      {
        id: 'p2',
        title: 'fix: EDGAR latency measurement gap',
        labels: ['metric-blocking'],
        priority: 9,
      },
      { id: 'f1', title: 'feat: unrelated polish', priority: 1 },
    ];

    const result = selectCandidates(candidates, { refactorAdmitted: 0 }, {
      maxRefactorPerWindow: 4,
    });

    // All five cosmetics decline (no drift score).
    expect(result.declined.length).toBe(5);
    expect(result.declined.every((d) => d.reasonCode === 'cosmetic_subthreshold')).toBe(
      true,
    );
    // Surplus fills product-metric candidates.
    expect(result.redirected.map((r) => r.id).sort()).toEqual(['p1', 'p2']);
    // Non-metric feat still admits normally.
    expect(result.admitted.some((a) => a.id === 'f1')).toBe(true);
  });

  it('admits non-cosmetic refactors up to the cap', () => {
    const candidates: RankedCandidate[] = [
      { id: '1', title: 'refactor: split A into modules' },
      { id: '2', title: 'refactor: split B into modules' },
      { id: '3', title: 'refactor: split C into modules' },
      { id: '4', title: 'refactor: split D into modules' },
      { id: '5', title: 'refactor: split E into modules' },
    ];
    const result = selectCandidates(candidates, { refactorAdmitted: 0 }, {
      maxRefactorPerWindow: 3,
    });
    expect(result.admitted).toHaveLength(3);
    expect(result.declined).toHaveLength(2);
    expect(result.declined.every((d) => d.reasonCode === 'refactor_cap_reached')).toBe(
      true,
    );
    expect(result.finalRefactorAdmitted).toBe(3);
  });
});

describe('computeComposition', () => {
  it('reports refactor share and value-advancing counts', () => {
    const report = computeComposition(
      [
        { title: 'feat: A' },
        { title: 'feat: B' },
        { title: 'fix: C' },
        { title: 'refactor: share x' },
        { title: 'refactor: share y' },
        { title: 'docs: z' },
        { title: 'arch: share isoNow' },
        {
          title: 'feat: SEC-anchor probe',
          labels: ['product-metric'],
        },
      ],
      { windowHours: 24, valueAdvancingTargetPerDay: 3 },
    );

    expect(report.schemaVersion).toBe(VALUE_DENSITY_SCHEMA);
    expect(report.total).toBe(8);
    expect(report.refactorCount).toBe(3);
    expect(report.refactorSharePct).toBe(37.5);
    expect(report.cosmeticRefactorCount).toBe(3);
    // feat×3 + fix×1 + product-metric (already in feat) = 4 value-advancing
    expect(report.valueAdvancingCount).toBe(4);
    expect(report.productMetricBlockingCount).toBe(1);
    expect(report.valueAdvancingAttainmentPct).toBeCloseTo(133.3, 0);

    const line = formatCompositionLine(report, 'jeanibarz/lucy');
    expect(line).toMatch(/jeanibarz\/lucy/);
    expect(line).toMatch(/refactor 3\/8/);
    expect(line).toMatch(/value-advancing 4\/8/);
  });

  it('handles empty windows', () => {
    const report = computeComposition([]);
    expect(report.total).toBe(0);
    expect(report.refactorSharePct).toBeNull();
    expect(report.valueAdvancingSharePct).toBeNull();
  });
});

describe('decline ledger helpers', () => {
  it('builds a durable decline record and stable paths', () => {
    const c = classifyWorkItem({ title: 'arch: share cleanHtmlText' });
    const rec = buildDeclineRecord({
      repo: 'jeanibarz/lucy',
      title: 'arch: share cleanHtmlText',
      source: 'architecture-health-check',
      reasonCode: 'cosmetic_subthreshold',
      reason: 'cosmetic refactor declined',
      workClass: c.workClass,
      cosmetic: c.cosmetic,
      productMetricBlocking: c.productMetricBlocking,
      now: new Date('2026-08-01T12:00:00Z'),
    });
    expect(rec.schemaVersion).toBe(VALUE_DENSITY_SCHEMA);
    expect(rec.ts).toBe('2026-08-01T12:00:00.000Z');
    expect(rec.repo).toBe('jeanibarz/lucy');
    expect(rec.title).toBe('arch: share cleanHtmlText');
    expect(rec.source).toBe('architecture-health-check');
    expect(rec.reasonCode).toBe('cosmetic_subthreshold');
    expect(rec.reason).toBe('cosmetic refactor declined');
    expect(declinedIdeasPath('jeanibarz/lucy', '/tmp/kookr')).toBe(
      '/tmp/kookr/playbook-state/value-density/declined/jeanibarz--lucy.jsonl',
    );
    expect(compositionSnapshotPath('kookr-ai/kookr', '/tmp/kookr')).toBe(
      '/tmp/kookr/playbook-state/value-density/composition/kookr-ai--kookr.jsonl',
    );
  });
});
