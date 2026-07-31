import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONSTRAINED_BUDGET,
  DEFAULT_DEDUPE_SIMILARITY_THRESHOLD,
  DEFAULT_OPEN_BACKLOG_THRESHOLD,
  DEFAULT_RETRO_VERIFY_DEPTH_THRESHOLD,
  EMISSION_BUDGET_SCHEMA_VERSION,
  budgetLogicVersionStatus,
  buildDeferredIdeaRecord,
  checkDedupe,
  computeNetBacklogDelta,
  computeNetBacklogDelta7d,
  deferredIdeasPath,
  extractSchemaVersion,
  normalizeIssueTitle,
  partitionByBudget,
  resolveEmissionBudget,
  shouldBurstDrainBeforeEmission,
  titleSimilarity,
  utcDayKeyDaysAgo,
} from './emission-budget.js';

describe('resolveEmissionBudget', () => {
  it('allows the full requested budget under the open-backlog threshold', () => {
    const plan = resolveEmissionBudget({
      openBacklogCount: 40,
      requestedBudget: 10,
    });
    expect(plan).toMatchObject({
      schemaVersion: EMISSION_BUDGET_SCHEMA_VERSION,
      overThreshold: false,
      allowedBudget: 10,
      deferredCount: 0,
      action: 'allow',
    });
    expect(plan.reason).toMatch(/full requested budget 10 allowed/i);
  });

  it('constrains to the drain-coupled budget when open backlog is at/above threshold', () => {
    const plan = resolveEmissionBudget({
      openBacklogCount: DEFAULT_OPEN_BACKLOG_THRESHOLD,
      requestedBudget: 10,
    });
    expect(plan.overThreshold).toBe(true);
    expect(plan.allowedBudget).toBe(DEFAULT_CONSTRAINED_BUDGET);
    expect(plan.deferredCount).toBe(8);
    expect(plan.action).toBe('constrain');
    expect(plan.reason).toMatch(/constrained to 2/i);
  });

  it('refuses entirely when constrained budget is 0 and over threshold', () => {
    const plan = resolveEmissionBudget({
      openBacklogCount: 100,
      requestedBudget: 5,
      constrainedBudget: 0,
    });
    expect(plan.action).toBe('refuse');
    expect(plan.allowedBudget).toBe(0);
    expect(plan.deferredCount).toBe(5);
  });

  it('allows a small request even when over threshold if it fits the constrained budget', () => {
    const plan = resolveEmissionBudget({
      openBacklogCount: 80,
      requestedBudget: 2,
    });
    expect(plan.action).toBe('allow');
    expect(plan.allowedBudget).toBe(2);
    expect(plan.deferredCount).toBe(0);
  });

  it('honors normalBudgetCap under the threshold', () => {
    const plan = resolveEmissionBudget({
      openBacklogCount: 10,
      requestedBudget: 15,
      normalBudgetCap: 3,
    });
    expect(plan.action).toBe('constrain');
    expect(plan.allowedBudget).toBe(3);
    expect(plan.deferredCount).toBe(12);
  });

  it('clamps negative / non-finite inputs to zero', () => {
    const plan = resolveEmissionBudget({
      openBacklogCount: Number.NaN,
      requestedBudget: -4,
    });
    expect(plan.openBacklogCount).toBe(0);
    expect(plan.requestedBudget).toBe(0);
    expect(plan.allowedBudget).toBe(0);
    expect(plan.action).toBe('refuse');
  });

  it('floors fractional budgets', () => {
    const plan = resolveEmissionBudget({
      openBacklogCount: 10,
      requestedBudget: 3.9,
    });
    expect(plan.requestedBudget).toBe(3);
    expect(plan.allowedBudget).toBe(3);
  });
});

describe('partitionByBudget', () => {
  it('splits ordered candidates into file vs defer slices', () => {
    const items = ['a', 'b', 'c', 'd', 'e'];
    expect(partitionByBudget(items, 2)).toEqual({
      file: ['a', 'b'],
      defer: ['c', 'd', 'e'],
    });
  });

  it('defers everything when budget is 0', () => {
    expect(partitionByBudget(['a', 'b'], 0)).toEqual({
      file: [],
      defer: ['a', 'b'],
    });
  });

  it('files everything when budget ≥ length', () => {
    expect(partitionByBudget(['a', 'b'], 10)).toEqual({
      file: ['a', 'b'],
      defer: [],
    });
  });
});

describe('titleSimilarity / normalizeIssueTitle', () => {
  it('strips Repository idea: and arch: prefixes', () => {
    expect(normalizeIssueTitle('Repository idea: Add dark mode')).toBe('add dark mode');
    expect(normalizeIssueTitle('arch: god module in store')).toBe('god module in store');
  });

  it('scores identical titles as 1', () => {
    expect(titleSimilarity('Add dark mode toggle', 'Add dark mode toggle')).toBe(1);
  });

  it('scores unrelated titles near 0', () => {
    expect(titleSimilarity('Fix flaky e2e timeout', 'Document REST spawn contract')).toBeLessThan(0.3);
  });

  it('scores near-duplicates high enough to trip the default threshold', () => {
    const score = titleSimilarity(
      'Drain-coupled emission budget for reflection playbooks',
      'Drain-coupled emission budget for reflection/idea/retro playbooks (backlog inflating)',
    );
    expect(score).toBeGreaterThanOrEqual(DEFAULT_DEDUPE_SIMILARITY_THRESHOLD);
  });
});

describe('checkDedupe', () => {
  const open = [
    { number: 1607, title: 'Drain-coupled emission budget for reflection/idea/retro playbooks (backlog inflating ~4x drain)' },
    { number: 42, title: 'Add dark mode toggle' },
  ];

  it('flags an exact-title duplicate and always logs', () => {
    const result = checkDedupe('Add dark mode toggle', open);
    expect(result.isDuplicate).toBe(true);
    expect(result.match?.number).toBe(42);
    expect(result.similarity).toBe(1);
    expect(result.logLine).toMatch(/^dedupe-check: DUPLICATE/);
    expect(result.logLine).toContain('#42');
  });

  it('flags a high-similarity near-duplicate', () => {
    const result = checkDedupe(
      'Drain-coupled emission budget for reflection playbooks',
      open,
    );
    expect(result.isDuplicate).toBe(true);
    expect(result.match?.number).toBe(1607);
    expect(result.logLine).toMatch(/DUPLICATE/);
  });

  it('returns OK with a log line when no match', () => {
    const result = checkDedupe('Completely novel observability metric for X', open);
    expect(result.isDuplicate).toBe(false);
    expect(result.match).toBeNull();
    expect(result.logLine).toMatch(/^dedupe-check: OK/);
    expect(result.logLine).toMatch(/scanned=2/);
  });

  it('always produces a log line even with an empty open list', () => {
    const result = checkDedupe('Anything', []);
    expect(result.isDuplicate).toBe(false);
    expect(result.logLine).toMatch(/scanned=0/);
  });
});

describe('net backlog delta', () => {
  it('computes opened − closed', () => {
    expect(computeNetBacklogDelta(60, 14)).toBe(46);
    expect(computeNetBacklogDelta(5, 12)).toBe(-7);
  });

  it('packages the 7-day rolling metric', () => {
    expect(computeNetBacklogDelta7d(60, 14)).toEqual({
      windowDays: 7,
      opened7d: 60,
      closed7d: 14,
      netBacklogDelta7d: 46,
    });
  });

  it('utcDayKeyDaysAgo returns YYYY-MM-DD for a fixed clock', () => {
    const now = new Date('2026-07-27T12:00:00.000Z');
    expect(utcDayKeyDaysAgo(7, now)).toBe('2026-07-20');
    expect(utcDayKeyDaysAgo(0, now)).toBe('2026-07-27');
  });
});

describe('deferred idea helpers', () => {
  it('builds a JSONL-ready deferred record', () => {
    const rec = buildDeferredIdeaRecord({
      repo: 'kookr-ai/kookr',
      title: 'Repository idea: Something deferred',
      reason: 'over emission budget',
      source: 'repository-idea-scout',
      openBacklogCount: 83,
      allowedBudget: 2,
      now: new Date('2026-07-27T00:00:00.000Z'),
    });
    expect(rec).toEqual({
      deferredAt: '2026-07-27T00:00:00.000Z',
      repo: 'kookr-ai/kookr',
      title: 'Repository idea: Something deferred',
      reason: 'over emission budget',
      source: 'repository-idea-scout',
      openBacklogCount: 83,
      allowedBudget: 2,
    });
  });

  it('slugs the deferred-ideas path', () => {
    expect(deferredIdeasPath('kookr-ai/kookr', '/tmp/.kookr')).toBe(
      '/tmp/.kookr/playbook-state/deferred-ideas/kookr-ai-kookr.jsonl',
    );
  });

  it('refuses with a clear reason when requested is 0 over threshold', () => {
    const plan = resolveEmissionBudget({
      openBacklogCount: 100,
      requestedBudget: 0,
    });
    expect(plan.action).toBe('refuse');
    expect(plan.reason).toMatch(/Requested budget is 0/i);
  });
});

describe('resolveEmissionBudget drain coupling (issue #1657)', () => {
  it('leaves the plan unchanged and drainCoupled=false when drainCount is omitted', () => {
    const plan = resolveEmissionBudget({ openBacklogCount: 40, requestedBudget: 10 });
    expect(plan.drainCoupled).toBe(false);
    expect(plan.drainCount).toBeUndefined();
    expect(plan.drainCap).toBeUndefined();
    expect(plan.allowedBudget).toBe(10);
  });

  it('budgets a low-drain target by ITS drain, not the requesting actor’s home-repo drain', () => {
    // Regression for #1657: a high-drain actor (e.g. filing 56/window in kookr)
    // files into a low-drain repo (lucy, backlog 52 < threshold 60, draining 1).
    // The plan must be keyed on the *target* repo's drain (1), not the actor's.
    const plan = resolveEmissionBudget({
      openBacklogCount: 52, // under the 60 threshold → backlog logic alone would allow full
      requestedBudget: 10,
      drainCount: 1, // target repo drained only 1 issue this window
    });
    expect(plan.overThreshold).toBe(false);
    expect(plan.drainCoupled).toBe(true);
    expect(plan.drainCount).toBe(1);
    expect(plan.drainCap).toBe(1); // floor 0 + ceil(1 * 1)
    expect(plan.allowedBudget).toBe(1);
    expect(plan.deferredCount).toBe(9);
    expect(plan.action).toBe('constrain');
    expect(plan.reason).toMatch(/drain cap 1/i);
  });

  it('refuses emission into a repo draining nothing (drainCount 0, floor 0)', () => {
    const plan = resolveEmissionBudget({
      openBacklogCount: 10,
      requestedBudget: 5,
      drainCount: 0,
    });
    expect(plan.drainCap).toBe(0);
    expect(plan.allowedBudget).toBe(0);
    expect(plan.action).toBe('refuse');
    expect(plan.deferredCount).toBe(5);
  });

  it('honors a drain floor so a fresh repo can still admit a few', () => {
    const plan = resolveEmissionBudget({
      openBacklogCount: 10,
      requestedBudget: 5,
      drainCount: 0,
      drainFloorBudget: 2,
    });
    expect(plan.drainCap).toBe(2);
    expect(plan.allowedBudget).toBe(2);
    expect(plan.action).toBe('constrain');
  });

  it('scales the cap with the coupling ratio', () => {
    const plan = resolveEmissionBudget({
      openBacklogCount: 10,
      requestedBudget: 10,
      drainCount: 4,
      drainCouplingRatio: 0.5, // 4 drained * 0.5 = 2
    });
    expect(plan.drainCap).toBe(2);
    expect(plan.allowedBudget).toBe(2);
  });

  it('only tightens — a generous drain cap never loosens the backlog budget', () => {
    // Over threshold → backlog logic constrains to 2; a large drain must not lift it.
    const plan = resolveEmissionBudget({
      openBacklogCount: DEFAULT_OPEN_BACKLOG_THRESHOLD + 5,
      requestedBudget: 10,
      drainCount: 100,
    });
    expect(plan.overThreshold).toBe(true);
    expect(plan.drainCoupled).toBe(true);
    expect(plan.drainCap).toBe(100);
    expect(plan.allowedBudget).toBe(DEFAULT_CONSTRAINED_BUDGET); // stays 2, not 100
  });
});

describe('resolveEmissionBudget retro-verify / ci_blind_debt (issue #1703)', () => {
  it('leaves the plan unchanged and retroVerifyCoupled=false when depth is omitted', () => {
    const plan = resolveEmissionBudget({ openBacklogCount: 40, requestedBudget: 10 });
    expect(plan.retroVerifyCoupled).toBe(false);
    expect(plan.retroVerifyWithheld).toBe(false);
    expect(plan.retroVerifyDepth).toBeUndefined();
    expect(plan.allowedBudget).toBe(10);
    expect(plan.action).toBe('allow');
  });

  it('withholds the emission budget when retro-verify depth exceeds the threshold', () => {
    // Acceptance criterion: budget is withheld while retro-verify depth exceeds
    // a threshold. Default threshold 0 ⇒ any debt refuses new feature emissions.
    const plan = resolveEmissionBudget({
      openBacklogCount: 10,
      requestedBudget: 8,
      retroVerifyDepth: 3,
    });
    expect(plan.schemaVersion).toBe(EMISSION_BUDGET_SCHEMA_VERSION);
    expect(plan.retroVerifyCoupled).toBe(true);
    expect(plan.retroVerifyDepth).toBe(3);
    expect(plan.retroVerifyDepthThreshold).toBe(DEFAULT_RETRO_VERIFY_DEPTH_THRESHOLD);
    expect(plan.retroVerifyWithheld).toBe(true);
    expect(plan.allowedBudget).toBe(0);
    expect(plan.deferredCount).toBe(8);
    expect(plan.action).toBe('refuse');
    expect(plan.reason).toMatch(/ci_blind_debt/i);
    expect(plan.reason).toMatch(/Burst-drain/i);
  });

  it('allows emission when depth is at/under the threshold', () => {
    const plan = resolveEmissionBudget({
      openBacklogCount: 10,
      requestedBudget: 5,
      retroVerifyDepth: 2,
      retroVerifyDepthThreshold: 5,
    });
    expect(plan.retroVerifyCoupled).toBe(true);
    expect(plan.retroVerifyWithheld).toBe(false);
    expect(plan.allowedBudget).toBe(5);
    expect(plan.action).toBe('allow');
  });

  it('allows emission when depth is 0 (empty retro-verify queue)', () => {
    const plan = resolveEmissionBudget({
      openBacklogCount: 10,
      requestedBudget: 5,
      retroVerifyDepth: 0,
    });
    expect(plan.retroVerifyCoupled).toBe(true);
    expect(plan.retroVerifyWithheld).toBe(false);
    expect(plan.allowedBudget).toBe(5);
  });

  it('still withholds when depth exceeds threshold even if backlog already refused', () => {
    const plan = resolveEmissionBudget({
      openBacklogCount: 100,
      requestedBudget: 5,
      constrainedBudget: 0,
      retroVerifyDepth: 12,
    });
    expect(plan.allowedBudget).toBe(0);
    expect(plan.retroVerifyWithheld).toBe(true);
    expect(plan.reason).toMatch(/ci_blind_debt/i);
  });

  it('applies after drain coupling (debt gate is the final tightener)', () => {
    // Drain would allow 2; debt gate must still refuse.
    const plan = resolveEmissionBudget({
      openBacklogCount: 10,
      requestedBudget: 10,
      drainCount: 2,
      retroVerifyDepth: 1,
    });
    expect(plan.drainCap).toBe(2);
    expect(plan.retroVerifyWithheld).toBe(true);
    expect(plan.allowedBudget).toBe(0);
    expect(plan.action).toBe('refuse');
  });
});

describe('resolveEmissionBudget tolerance-machinery cap (issue #1702)', () => {
  it('leaves the plan unchanged and toleranceRegimeCoupled=false when the field is omitted', () => {
    const plan = resolveEmissionBudget({ openBacklogCount: 10, requestedBudget: 5 });
    expect(plan.toleranceRegimeCoupled).toBe(false);
    expect(plan.toleranceRegimeBlocked).toBe(false);
    expect(plan.allowedBudget).toBe(5);
    expect(plan.action).toBe('allow');
  });

  it('refuses tolerance machinery when a regime already exists for the blocker', () => {
    const plan = resolveEmissionBudget({
      openBacklogCount: 10,
      requestedBudget: 5,
      toleranceRegimeActive: true,
      toleranceRegimeBlockerKey: 'ci-billing:github-actions',
    });
    expect(plan.toleranceRegimeCoupled).toBe(true);
    expect(plan.toleranceRegimeBlocked).toBe(true);
    expect(plan.toleranceRegimeBlockerKey).toBe('ci-billing:github-actions');
    expect(plan.allowedBudget).toBe(0);
    expect(plan.action).toBe('refuse');
    expect(plan.reason).toMatch(/tolerance regime already exists/i);
    expect(plan.reason).toMatch(/escalate the blocker/i);
  });

  it('reports the gate but does not block when no regime is active yet', () => {
    const plan = resolveEmissionBudget({
      openBacklogCount: 10,
      requestedBudget: 5,
      toleranceRegimeActive: false,
      toleranceRegimeBlockerKey: 'ci-billing:github-actions',
    });
    expect(plan.toleranceRegimeCoupled).toBe(true);
    expect(plan.toleranceRegimeBlocked).toBe(false);
    expect(plan.allowedBudget).toBe(5);
    expect(plan.action).toBe('allow');
  });

  it('is the final tightener — applies even when other gates already allowed a budget', () => {
    // Backlog + drain would allow 2; the tolerance-regime gate must still refuse.
    const plan = resolveEmissionBudget({
      openBacklogCount: 80,
      requestedBudget: 10,
      drainCount: 5,
      toleranceRegimeActive: true,
      toleranceRegimeBlockerKey: 'ci-billing:github-actions',
    });
    expect(plan.allowedBudget).toBe(0);
    expect(plan.action).toBe('refuse');
    expect(plan.toleranceRegimeBlocked).toBe(true);
  });

  it('marks the regime as an also-binding constraint when an earlier gate already refused', () => {
    const plan = resolveEmissionBudget({
      openBacklogCount: 100,
      requestedBudget: 5,
      constrainedBudget: 0,
      toleranceRegimeActive: true,
      toleranceRegimeBlockerKey: 'ci-billing:github-actions',
    });
    expect(plan.allowedBudget).toBe(0);
    expect(plan.toleranceRegimeBlocked).toBe(true);
    expect(plan.reason).toMatch(/tolerance regime already exists/i);
  });
});

describe('shouldBurstDrainBeforeEmission (issue #1703)', () => {
  it('recommends burst-drain when depth exceeds threshold and CI recovered', () => {
    expect(
      shouldBurstDrainBeforeEmission({
        retroVerifyDepth: 4,
        ciRecovered: true,
      }),
    ).toBe(true);
  });

  it('does not recommend a full-CI burst-drain while CI is still absent', () => {
    expect(
      shouldBurstDrainBeforeEmission({
        retroVerifyDepth: 4,
        ciRecovered: false,
      }),
    ).toBe(false);
  });

  it('recommends a drain attempt when CI recovery is unknown and depth is over threshold', () => {
    expect(shouldBurstDrainBeforeEmission({ retroVerifyDepth: 1 })).toBe(true);
  });

  it('does not recommend drain when the queue is empty / under threshold', () => {
    expect(shouldBurstDrainBeforeEmission({ retroVerifyDepth: 0 })).toBe(false);
    expect(
      shouldBurstDrainBeforeEmission({
        retroVerifyDepth: 2,
        retroVerifyDepthThreshold: 5,
        ciRecovered: true,
      }),
    ).toBe(false);
  });
});

describe('budget-logic deploy-freshness (issue #1657)', () => {
  it('extracts the schema version literal from source', () => {
    const src = `export const EMISSION_BUDGET_SCHEMA_VERSION = 'emission-budget.v3' as const;`;
    expect(extractSchemaVersion(src)).toBe('emission-budget.v3');
    expect(extractSchemaVersion('no version here')).toBeNull();
  });

  it('flags a lagging running version against the origin reference', () => {
    const status = budgetLogicVersionStatus('emission-budget.v1', 'emission-budget.v2');
    expect(status.lagging).toBe(true);
    expect(status.logLine).toMatch(/ANOMALY/);
    expect(status.logLine).toMatch(/lags origin\/main/);
  });

  it('reports OK when running matches the reference', () => {
    const status = budgetLogicVersionStatus(
      EMISSION_BUDGET_SCHEMA_VERSION,
      EMISSION_BUDGET_SCHEMA_VERSION,
    );
    expect(status.lagging).toBe(false);
    expect(status.logLine).toMatch(/OK/);
  });

  it('says it cannot verify when the reference is unavailable', () => {
    const status = budgetLogicVersionStatus(EMISSION_BUDGET_SCHEMA_VERSION, null);
    expect(status.lagging).toBe(false);
    expect(status.logLine).toMatch(/cannot verify/i);
  });
});
