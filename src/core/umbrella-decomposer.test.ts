import { describe, expect, it } from 'vitest';
import {
  CURATED_LEAF_PLANS,
  DEFAULT_FREE_SLOTS_THRESHOLD,
  DEFAULT_MAX_INVENT_LEAVES,
  DEFAULT_MAX_LEAVES,
  DEFAULT_MAX_SECONDARY_PER_FIRE,
  LUCY_1586_LEAF_PLAN,
  LUCY_1587_LEAF_PLAN,
  LUCY_1588_LEAF_PLAN,
  LUCY_1589_LEAF_PLAN,
  LUCY_1590_LEAF_PLAN,
  LUCY_1593_LEAF_PLAN,
  LUCY_1594_LEAF_PLAN,
  QUEUE_FEEDER_SCHEMA,
  buildLeafIssueBody,
  buildQueueFeederRecord,
  classifyUmbrella,
  curatedLeafPlan,
  evaluateQueueFeeder,
  formatQueueFeederLine,
  effectiveFreeForSpawnBudget,
  isFeederTriggered,
  isHarnessUmbrella,
  normalizeLeafPlan,
  queueFeederLedgerPath,
  rankUmbrellas,
  readyIssueSkipReason,
  selectReadyIssues,
  umbrellaRef,
  umbrellaSkipReason,
  validateLeafSpec,
  type LeafSpec,
  type ReadyIssue,
  type UmbrellaCandidate,
} from './umbrella-decomposer.js';

function umbrella(overrides: Partial<UmbrellaCandidate> = {}): UmbrellaCandidate {
  return {
    repo: 'jeanibarz/lucy',
    number: 2000,
    title: 'Some umbrella',
    openChildrenCount: 0,
    ...overrides,
  };
}

const GOOD_LEAF: LeafSpec = {
  title: 'feat: do the thing',
  goal: 'Deliver the thing so the metric moves.',
  acceptanceCriteria: ['thing exists', 'metric moves'],
};

function nLeaves(n: number): LeafSpec[] {
  return Array.from({ length: n }, (_, i) => ({
    ...GOOD_LEAF,
    title: `${GOOD_LEAF.title} ${i + 1}`,
  }));
}

describe('umbrellaRef', () => {
  it('repo-qualifies the issue number', () => {
    expect(umbrellaRef({ repo: 'jeanibarz/lucy', number: 1588 })).toBe('jeanibarz/lucy#1588');
  });
});

describe('isFeederTriggered', () => {
  it('fires only when free ≥ threshold AND queue is empty', () => {
    expect(isFeederTriggered({ free: 5, pendingQueueDepth: 0 })).toBe(true);
    expect(isFeederTriggered({ free: DEFAULT_FREE_SLOTS_THRESHOLD, pendingQueueDepth: 0 })).toBe(true);
  });

  it('does not fire when the queue is non-empty', () => {
    expect(isFeederTriggered({ free: 5, pendingQueueDepth: 1 })).toBe(false);
  });

  it('does not fire when free slots are below threshold', () => {
    expect(isFeederTriggered({ free: 2, pendingQueueDepth: 0 })).toBe(false);
  });

  it('honours a custom threshold', () => {
    expect(isFeederTriggered({ free: 2, pendingQueueDepth: 0 }, { freeSlotsThreshold: 2 })).toBe(true);
  });

  it('issue #2357: keys on freeForGeneralSources so free=0 with effective free still refills', () => {
    // Residual shape: nominal full (free=0) while idleEffectiveSlots / freeForGeneral=4.
    expect(
      isFeederTriggered({
        free: 0,
        freeForGeneralSources: 4,
        pendingQueueDepth: 0,
      }),
    ).toBe(true);
    expect(
      effectiveFreeForSpawnBudget({
        free: 0,
        freeForGeneralSources: 4,
        pendingQueueDepth: 0,
      }),
    ).toBe(4);
    // Nominal free alone still blocks without effective free.
    expect(isFeederTriggered({ free: 0, pendingQueueDepth: 0 })).toBe(false);
  });
});

describe('isHarnessUmbrella / classifyUmbrella', () => {
  it('detects harness umbrellas from labels and title', () => {
    expect(isHarnessUmbrella({ title: 'Refactor the launch service', labels: [] })).toBe(true);
    expect(isHarnessUmbrella({ title: 'Improve X', labels: ['orchestration'] })).toBe(true);
    expect(isHarnessUmbrella({ title: 'anchor truth', labels: ['product'] })).toBe(false);
  });

  it('respects an explicit harness override', () => {
    expect(isHarnessUmbrella({ title: 'refactor stuff', labels: [], harness: false })).toBe(false);
  });

  it('classifies product-metric-blocking via reused value-density detection', () => {
    const c = classifyUmbrella(umbrella({ title: 'anchor truth — SEC acceptance anchors' }));
    expect(c.productMetricBlocking).toBe(true);
    expect(c.harness).toBe(false);
  });

  it('lets product-metric signal dominate even when harness tokens are present', () => {
    // Title has both "refactor" (harness) and a product-metric label.
    const c = classifyUmbrella(
      umbrella({ title: 'refactor SEC anchors', labels: ['sec-anchor'] }),
    );
    expect(c.productMetricBlocking).toBe(true);
    expect(c.harness).toBe(false);
  });
});

describe('umbrellaSkipReason', () => {
  it('skips umbrellas that already have open children (idempotent)', () => {
    expect(umbrellaSkipReason(umbrella({ openChildrenCount: 3 }))).toMatch(/already/i);
  });

  it('accepts an umbrella with zero open children', () => {
    expect(umbrellaSkipReason(umbrella({ openChildrenCount: 0 }))).toBeNull();
  });

  it('rejects malformed refs', () => {
    expect(umbrellaSkipReason(umbrella({ repo: 'nope' }))).toMatch(/owner\/repo/);
    expect(umbrellaSkipReason(umbrella({ number: 0 }))).toMatch(/issue number/);
  });
});

describe('rankUmbrellas', () => {
  it('ranks product-metric-blocking above harness above neutral', () => {
    const candidates = [
      umbrella({ number: 1, title: 'refactor internals', labels: ['refactor'] }), // harness
      umbrella({ number: 2, title: 'plain feature work' }), // neutral
      umbrella({ number: 3, title: 'SEC acceptance anchors', labels: ['sec-anchor'] }), // product
    ];
    const { eligible } = rankUmbrellas(candidates);
    expect(eligible.map((e) => e.candidate.number)).toEqual([3, 2, 1]);
  });

  it('separates skipped (already-decomposed) from eligible', () => {
    const candidates = [
      umbrella({ number: 10, openChildrenCount: 2 }),
      umbrella({ number: 11, openChildrenCount: 0 }),
    ];
    const { eligible, skipped } = rankUmbrellas(candidates);
    expect(eligible.map((e) => e.candidate.number)).toEqual([11]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.ref).toBe('jeanibarz/lucy#10');
  });

  it('breaks equal-tier ties by input order when no priority is set', () => {
    const candidates = [
      umbrella({ number: 1, title: 'neutral a' }),
      umbrella({ number: 2, title: 'neutral b' }),
    ];
    const { eligible } = rankUmbrellas(candidates);
    expect(eligible.map((e) => e.candidate.number)).toEqual([1, 2]); // stable input order
  });

  it('uses priority only as an intra-tier tie-break', () => {
    const candidates = [
      umbrella({ number: 1, title: 'neutral a' }),
      umbrella({ number: 2, title: 'neutral b', priority: 5 }),
    ];
    const { eligible } = rankUmbrellas(candidates);
    expect(eligible[0]!.candidate.number).toBe(2); // priority wins the tie within the tier
  });

  it('never lets priority lift a harness umbrella above a product-metric one', () => {
    const candidates = [
      umbrella({ number: 1, title: 'refactor harness', labels: ['refactor'], priority: 999 }),
      umbrella({ number: 2, title: 'SEC acceptance anchors', labels: ['sec-anchor'] }),
    ];
    const { eligible } = rankUmbrellas(candidates);
    // Product-metric (tier 100) must beat harness even with priority 999.
    expect(eligible[0]!.candidate.number).toBe(2);
  });
});

describe('validateLeafSpec / normalizeLeafPlan', () => {
  it('flags missing goal / title / acceptance criteria', () => {
    expect(validateLeafSpec(GOOD_LEAF)).toEqual([]);
    expect(validateLeafSpec({ title: '', goal: 'g', acceptanceCriteria: ['a'] })).toContain(
      'missing title',
    );
    expect(validateLeafSpec({ title: 't', goal: '', acceptanceCriteria: ['a'] })).toContain(
      'missing goal',
    );
    expect(validateLeafSpec({ title: 't', goal: 'g', acceptanceCriteria: [] })).toContain(
      'no acceptance criteria',
    );
  });

  it('rejects a plan below the minimum leaf count', () => {
    const plan = normalizeLeafPlan(nLeaves(2));
    expect(plan.ok).toBe(false);
    expect(plan.error).toMatch(/min 3/);
  });

  it('accepts a 3-leaf plan and caps at the maximum', () => {
    const ok = normalizeLeafPlan(nLeaves(3));
    expect(ok.ok).toBe(true);
    expect(ok.leaves).toHaveLength(3);

    const capped = normalizeLeafPlan(nLeaves(8));
    expect(capped.ok).toBe(true);
    expect(capped.leaves).toHaveLength(DEFAULT_MAX_LEAVES);
  });

  it('drops malformed leaves before counting', () => {
    const mixed = [...nLeaves(3), { title: 'bad', goal: '', acceptanceCriteria: [] }];
    const plan = normalizeLeafPlan(mixed);
    expect(plan.ok).toBe(true);
    expect(plan.leaves).toHaveLength(3);
  });
});

describe('evaluateQueueFeeder — gating', () => {
  it('does not trigger when the queue is non-empty', () => {
    const decision = evaluateQueueFeeder({
      capacity: { free: 5, pendingQueueDepth: 4 },
      candidates: [umbrella({ title: 'SEC anchors', labels: ['sec-anchor'] })],
    });
    expect(decision.triggered).toBe(false);
    expect(decision.selected).toBeNull();
    expect(decision.action).toBe('not-triggered');
    expect(decision.triggerReason).toMatch(/queue not empty/);
  });

  it('does not trigger below the free-slot threshold', () => {
    const decision = evaluateQueueFeeder({
      capacity: { free: 1, pendingQueueDepth: 0 },
      candidates: [umbrella()],
    });
    expect(decision.triggered).toBe(false);
    expect(decision.action).toBe('not-triggered');
  });
});

describe('evaluateQueueFeeder — selection + emission (AC1)', () => {
  it('selects the top product umbrella and emits ≥3 well-formed leaves', () => {
    const decision = evaluateQueueFeeder({
      capacity: { free: 5, pendingQueueDepth: 0 },
      candidates: [
        umbrella({ number: 42, title: 'anchor truth — SEC acceptance anchors' }),
      ],
      resolveLeaves: () => nLeaves(4),
    });
    expect(decision.triggered).toBe(true);
    expect(decision.action).toBe('shred');
    expect(decision.actionSource).toBe('umbrella-shred');
    expect(decision.selected?.number).toBe(42);
    expect(decision.selected?.productMetricBlocking).toBe(true);
    expect(decision.selected?.needsAuthoring).toBe(false);
    expect(decision.leafCount).toBe(4);
    expect(decision.leafCount).toBeGreaterThanOrEqual(3);
    for (const leaf of decision.selected!.leaves) {
      expect(validateLeafSpec(leaf)).toEqual([]);
    }
  });

  it('prefers product-metric-blocking umbrellas over harness ones (AC3)', () => {
    const decision = evaluateQueueFeeder({
      capacity: { free: 4, pendingQueueDepth: 0 },
      candidates: [
        umbrella({ number: 1, title: 'refactor orchestration harness', labels: ['refactor'] }),
        umbrella({ number: 2, title: 'SEC acceptance anchors', labels: ['sec-anchor'] }),
      ],
      resolveLeaves: () => nLeaves(3),
    });
    expect(decision.selected?.number).toBe(2);
    // The harness umbrella is recorded as skipped-this-run, not lost silently.
    expect(decision.skipped.some((s) => s.ref === 'jeanibarz/lucy#1')).toBe(true);
  });

  it('flags needs-authoring and invent-product-wave when product belt empty (#2069)', () => {
    const decision = evaluateQueueFeeder({
      capacity: { free: 4, pendingQueueDepth: 0 },
      candidates: [umbrella({ number: 99, title: 'SEC anchors', labels: ['sec-anchor'] })],
      openProductMetricIssues: 0,
      resolveLeaves: () => undefined,
    });
    expect(decision.selected?.needsAuthoring).toBe(true);
    expect(decision.selected?.leafError).toMatch(/no leaf plan/);
    expect(decision.leafCount).toBe(0);
    expect(decision.action).toBe('invent-product-wave');
    expect(decision.actionSource).toBe('product-wave');
    expect(decision.inventLeafCap).toBe(DEFAULT_MAX_INVENT_LEAVES);
  });

  it('reports no eligible umbrella when all are already decomposed (AC2)', () => {
    const decision = evaluateQueueFeeder({
      capacity: { free: 6, pendingQueueDepth: 0 },
      candidates: [
        umbrella({ number: 1, openChildrenCount: 3 }),
        umbrella({ number: 2, openChildrenCount: 1 }),
      ],
    });
    expect(decision.triggered).toBe(true);
    expect(decision.selected).toBeNull();
    expect(decision.action).toBe('skip-invent');
    expect(decision.skipped).toHaveLength(2);
    expect(decision.skipped.every((s) => /already/.test(s.reason))).toBe(true);
  });

  it('prefers a plan-ready lower-ranked umbrella over a needsAuthoring top pick', () => {
    const decision = evaluateQueueFeeder({
      capacity: { free: 5, pendingQueueDepth: 0 },
      candidates: [
        umbrella({ number: 1, title: 'SEC anchors v2', labels: ['sec-anchor'], priority: 10 }),
        umbrella({ number: 2, title: 'refactor harness', labels: ['refactor'], priority: 0 }),
      ],
      resolveLeaves: (c) => (c.number === 2 ? nLeaves(3) : undefined),
    });
    expect(decision.action).toBe('shred');
    expect(decision.selected?.number).toBe(2);
    expect(decision.selected?.needsAuthoring).toBe(false);
  });
});

describe('selectReadyIssues / readyIssueSkipReason (#2044)', () => {
  it('skips assigned issues (never auto-claim)', () => {
    expect(
      readyIssueSkipReason({
        repo: 'kookr-ai/kookr',
        number: 2032,
        title: 'feat: x',
        assignees: ['alice'],
      }),
    ).toMatch(/assigned to alice/);
  });

  it('skips alreadyEmitted (idempotent re-fire)', () => {
    expect(
      readyIssueSkipReason({
        repo: 'kookr-ai/kookr',
        number: 2032,
        title: 'feat: x',
        alreadyEmitted: true,
      }),
    ).toMatch(/already emitted/);
  });

  it('caps at maxSecondaryPerFire and prefers idea-scout labels', () => {
    const issues: ReadyIssue[] = [
      { repo: 'kookr-ai/kookr', number: 1, title: 'plain', labels: [] },
      { repo: 'kookr-ai/kookr', number: 2, title: 'scout-a', labels: ['idea-scout'] },
      { repo: 'kookr-ai/kookr', number: 3, title: 'scout-b', labels: ['idea-scout'] },
      { repo: 'kookr-ai/kookr', number: 4, title: 'scout-c', labels: ['idea-scout'] },
      { repo: 'kookr-ai/kookr', number: 5, title: 'scout-d', labels: ['idea-scout'] },
    ];
    const { selected, skipped } = selectReadyIssues(issues, { maxSecondaryPerFire: 3 });
    expect(selected).toHaveLength(3);
    expect(selected.map((s) => s.number)).toEqual([2, 3, 4]);
    expect(skipped.some((s) => s.ref === 'kookr-ai/kookr#5')).toBe(true);
    expect(DEFAULT_MAX_SECONDARY_PER_FIRE).toBe(3);
  });
});

describe('evaluateQueueFeeder — secondary emit (#2044)', () => {
  const residualUmbrella = umbrella({
    number: 2047,
    title: 'Umbrella: idea-scout residual — docs index',
    labels: ['docs'],
    openChildrenCount: 0,
  });
  const shreddedProduct = umbrella({
    number: 1588,
    title: 'anchor truth — SEC acceptance anchors',
    labels: ['sec-anchor'],
    openChildrenCount: 5,
  });

  it('emits open unassigned idea-scout issues when product leaves are empty', () => {
    const decision = evaluateQueueFeeder({
      capacity: { free: 7, pendingQueueDepth: 0 },
      candidates: [shreddedProduct, residualUmbrella],
      openProductMetricIssues: 0,
      readyIssues: [
        {
          repo: 'kookr-ai/kookr',
          number: 2032,
          title: 'feat: secondary path A',
          labels: ['idea-scout'],
          assignees: [],
        },
        {
          repo: 'kookr-ai/kookr',
          number: 2033,
          title: 'feat: secondary path B',
          labels: ['idea-scout'],
        },
      ],
      resolveLeaves: () => undefined,
    });
    expect(decision.triggered).toBe(true);
    expect(decision.action).toBe('emit-secondary');
    expect(decision.actionSource).toBe('idea-scout');
    expect(decision.secondaryEmitted).toHaveLength(2);
    expect(decision.secondaryEmitted.map((i) => i.ref)).toEqual([
      'kookr-ai/kookr#2032',
      'kookr-ai/kookr#2033',
    ]);
    expect(decision.leafCount).toBe(2);
  });

  it('does not auto-claim issues assigned to someone else', () => {
    const decision = evaluateQueueFeeder({
      capacity: { free: 5, pendingQueueDepth: 0 },
      candidates: [residualUmbrella],
      openProductMetricIssues: 0,
      readyIssues: [
        {
          repo: 'kookr-ai/kookr',
          number: 2032,
          title: 'claimed',
          labels: ['idea-scout'],
          assignees: ['other-dev'],
        },
        {
          repo: 'kookr-ai/kookr',
          number: 2033,
          title: 'free',
          labels: ['idea-scout'],
          assignees: [],
        },
      ],
      resolveLeaves: () => undefined,
    });
    expect(decision.action).toBe('emit-secondary');
    expect(decision.secondaryEmitted.map((i) => i.number)).toEqual([2033]);
    expect(decision.skipped.some((s) => /assigned to other-dev/.test(s.reason))).toBe(true);
  });

  it('is idempotent: alreadyEmitted ready issues are not re-selected', () => {
    const decision = evaluateQueueFeeder({
      capacity: { free: 5, pendingQueueDepth: 0 },
      candidates: [residualUmbrella],
      openProductMetricIssues: 0,
      readyIssues: [
        {
          repo: 'kookr-ai/kookr',
          number: 2032,
          title: 'already out',
          labels: ['idea-scout'],
          alreadyEmitted: true,
        },
      ],
      resolveLeaves: () => undefined,
    });
    expect(decision.action).toBe('skip-invent');
    expect(decision.secondaryEmitted).toHaveLength(0);
  });

  it('caps secondary emit per fire (≤3 by default)', () => {
    const readyIssues: ReadyIssue[] = Array.from({ length: 6 }, (_, i) => ({
      repo: 'kookr-ai/kookr',
      number: 2030 + i,
      title: `idea ${i}`,
      labels: ['idea-scout'],
    }));
    const decision = evaluateQueueFeeder({
      capacity: { free: 8, pendingQueueDepth: 0 },
      candidates: [residualUmbrella],
      openProductMetricIssues: 0,
      readyIssues,
      resolveLeaves: () => undefined,
    });
    expect(decision.action).toBe('emit-secondary');
    expect(decision.secondaryEmitted).toHaveLength(DEFAULT_MAX_SECONDARY_PER_FIRE);
  });

  it('keeps skip-invent when free < threshold even if ready issues exist', () => {
    const decision = evaluateQueueFeeder({
      capacity: { free: 1, pendingQueueDepth: 0 },
      candidates: [residualUmbrella],
      openProductMetricIssues: 0,
      readyIssues: [
        { repo: 'kookr-ai/kookr', number: 2032, title: 'idea', labels: ['idea-scout'] },
      ],
      resolveLeaves: () => undefined,
    });
    expect(decision.action).toBe('not-triggered');
    expect(decision.secondaryEmitted).toHaveLength(0);
  });

  it('keeps skip-invent when queue already has work', () => {
    const decision = evaluateQueueFeeder({
      capacity: { free: 7, pendingQueueDepth: 3 },
      candidates: [residualUmbrella],
      openProductMetricIssues: 0,
      readyIssues: [
        { repo: 'kookr-ai/kookr', number: 2032, title: 'idea', labels: ['idea-scout'] },
      ],
      resolveLeaves: () => undefined,
    });
    expect(decision.action).toBe('not-triggered');
    expect(decision.secondaryEmitted).toHaveLength(0);
  });

  it('does not secondary-emit when open product-metric leaves already exist', () => {
    const decision = evaluateQueueFeeder({
      capacity: { free: 7, pendingQueueDepth: 0 },
      candidates: [residualUmbrella],
      openProductMetricIssues: 4,
      readyIssues: [
        { repo: 'kookr-ai/kookr', number: 2032, title: 'idea', labels: ['idea-scout'] },
      ],
      resolveLeaves: () => undefined,
    });
    expect(decision.action).toBe('skip-invent');
    expect(decision.secondaryEmitted).toHaveLength(0);
  });

  it('characterization: fixture ledger shape + mock idea-scout list → emit-secondary', () => {
    // Mirrors the 2026-08-04 production deadlock: free≥3, queue empty,
    // product umbrellas already shredded, residual needsAuthoring, open
    // idea-scout issues present — must not skip-invent.
    const decision = evaluateQueueFeeder({
      capacity: { free: 7, pendingQueueDepth: 0 },
      candidates: [
        umbrella({
          repo: 'jeanibarz/lucy',
          number: 1588,
          title: 'SEC anchors',
          labels: ['sec-anchor'],
          openChildrenCount: 5,
        }),
        umbrella({
          repo: 'jeanibarz/lucy',
          number: 2047,
          title: 'Umbrella: idea-scout residual — docs',
          openChildrenCount: 0,
        }),
      ],
      openProductMetricIssues: 0,
      readyIssues: [
        {
          repo: 'kookr-ai/kookr',
          number: 2032,
          title: 'queue-feeder: secondary emit path',
          labels: ['idea-scout'],
          assignees: [],
        },
      ],
      resolveLeaves: () => undefined,
    });
    const record = buildQueueFeederRecord(decision, {
      now: new Date('2026-08-04T01:15:00Z'),
      dryRun: true,
    });
    expect(record.action).toBe('emit-secondary');
    expect(record.source).toBe('idea-scout');
    expect(record.secondaryEmitted).toEqual(['kookr-ai/kookr#2032']);
    expect(record.free).toBe(7);
    expect(record.pendingQueueDepth).toBe(0);
    expect(record.leafCount).toBe(1);
    const line = formatQueueFeederLine(record);
    expect(line).toMatch(/action=emit-secondary/);
    expect(line).toContain('idea-scout');
    expect(line).toContain('kookr-ai/kookr#2032');
  });
});

describe('evaluateQueueFeeder — invent-product-wave (#2069)', () => {
  it('closed children do not count: openChildrenCount=0 → invent allowed when openPM=0', () => {
    // Live deadlock shape: umbrella children all CLOSED (must not be counted as
    // openChildrenCount), free≥3, openPM=0, no curated residual plan → invent
    // next product-metric leaf wave instead of permanent skip-invent.
    const decision = evaluateQueueFeeder({
      capacity: { free: 8, pendingQueueDepth: 0 },
      candidates: [
        umbrella({
          number: 1587,
          title: 'acquisition failover — product metric belt',
          labels: ['acquisition', 'product-metric'],
          // Closed leaves were wrongly counted as open; correct count is 0.
          openChildrenCount: 0,
        }),
      ],
      openProductMetricIssues: 0,
      resolveLeaves: () => undefined,
    });
    expect(decision.triggered).toBe(true);
    expect(decision.action).toBe('invent-product-wave');
    expect(decision.actionSource).toBe('product-wave');
    expect(decision.selected?.ref).toBe('jeanibarz/lucy#1587');
    expect(decision.selected?.productMetricBlocking).toBe(true);
    expect(decision.selected?.needsAuthoring).toBe(true);
    expect(decision.inventLeafCap).toBe(DEFAULT_MAX_INVENT_LEAVES);
    expect(decision.inventLeafCap).toBeLessThanOrEqual(3);
    expect(decision.inventLeafCap).toBeGreaterThanOrEqual(1);
    expect(decision.secondaryEmitted).toHaveLength(0);

    const record = buildQueueFeederRecord(decision, {
      now: new Date('2026-08-04T22:00:00Z'),
      dryRun: true,
    });
    expect(record.action).toBe('invent-product-wave');
    expect(record.source).toBe('product-wave');
    expect(record.selectedRef).toBe('jeanibarz/lucy#1587');
    expect(record.inventLeafCap).toBe(DEFAULT_MAX_INVENT_LEAVES);
    expect(formatQueueFeederLine(record)).toMatch(/action=invent-product-wave/);
  });

  it('open unassigned children → skip invent (use existing open leaves)', () => {
    const decision = evaluateQueueFeeder({
      capacity: { free: 8, pendingQueueDepth: 0 },
      candidates: [
        umbrella({
          number: 1588,
          title: 'SEC acceptance anchors',
          labels: ['sec-anchor'],
          openChildrenCount: 3, // open leaves still on the board
        }),
      ],
      openProductMetricIssues: 0,
      resolveLeaves: () => undefined,
    });
    expect(decision.action).not.toBe('invent-product-wave');
    expect(decision.selected).toBeNull();
    expect(decision.skipped.some((s) => /already has 3 open child/.test(s.reason))).toBe(true);
    // No product umbrella eligible → invent blocked; secondary empty → skip-invent.
    expect(decision.action).toBe('skip-invent');
  });

  it('non-PM residual still blocked when product umbrellas have open work', () => {
    // Product umbrella still has open children (do not invent under it).
    // Non-PM residual must not get invent-product-wave either — only skip or
    // secondary idea-scout when present.
    const decision = evaluateQueueFeeder({
      capacity: { free: 9, pendingQueueDepth: 0 },
      candidates: [
        umbrella({
          number: 1588,
          title: 'SEC acceptance anchors',
          labels: ['sec-anchor'],
          openChildrenCount: 4,
        }),
        umbrella({
          number: 2047,
          title: 'Umbrella: idea-scout residual — docs index',
          labels: ['docs'],
          openChildrenCount: 0,
        }),
      ],
      openProductMetricIssues: 0,
      resolveLeaves: () => undefined,
    });
    expect(decision.action).not.toBe('invent-product-wave');
    expect(decision.selected?.number).not.toBe(1588);
    // Residual docs may surface as skip-invent selected for observability.
    expect(['skip-invent', 'emit-secondary']).toContain(decision.action);
    if (decision.action === 'skip-invent') {
      expect(decision.selected?.productMetricBlocking ?? false).toBe(false);
    }
  });

  it('prefers invent-product-wave over idea-scout secondary when product residual needs authoring', () => {
    const decision = evaluateQueueFeeder({
      capacity: { free: 7, pendingQueueDepth: 0 },
      candidates: [
        umbrella({
          number: 1590,
          title: 'headline metrics product belt',
          labels: ['product-metric'],
          openChildrenCount: 0,
        }),
        umbrella({
          number: 2047,
          title: 'Umbrella: idea-scout residual — docs',
          openChildrenCount: 0,
        }),
      ],
      openProductMetricIssues: 0,
      readyIssues: [
        {
          repo: 'kookr-ai/kookr',
          number: 2032,
          title: 'feat: discord slash polish',
          labels: ['idea-scout'],
          assignees: [],
        },
      ],
      resolveLeaves: () => undefined,
    });
    expect(decision.action).toBe('invent-product-wave');
    expect(decision.selected?.number).toBe(1590);
    expect(decision.secondaryEmitted).toHaveLength(0);
  });

  it('does not invent when open product-metric leaves already exist on the belt', () => {
    const decision = evaluateQueueFeeder({
      capacity: { free: 7, pendingQueueDepth: 0 },
      candidates: [
        umbrella({
          number: 99,
          title: 'SEC anchors next wave',
          labels: ['sec-anchor'],
          openChildrenCount: 0,
        }),
      ],
      openProductMetricIssues: 4,
      resolveLeaves: () => undefined,
    });
    expect(decision.action).toBe('skip-invent');
    expect(decision.inventLeafCap).toBeNull();
  });

  it('still shreds a plan-ready product umbrella before invent', () => {
    const decision = evaluateQueueFeeder({
      capacity: { free: 5, pendingQueueDepth: 0 },
      candidates: [
        umbrella({
          number: 1588,
          title: 'SEC acceptance anchors',
          labels: ['sec-anchor'],
          openChildrenCount: 0,
        }),
      ],
      openProductMetricIssues: 0,
      // curated plan resolves via default registry
    });
    expect(decision.action).toBe('shred');
    expect(decision.leafCount).toBeGreaterThanOrEqual(3);
    expect(decision.inventLeafCap).toBeNull();
  });
});

describe('evaluateQueueFeeder — starvation invent priority (#2358)', () => {
  it('under high consecutiveBlockedEmpty + open product umbrella, invents product before micro secondary', () => {
    // Live residual shape from workflow reflection 2026-08-12: drought depth
    // elevated, dual-priority umbrella open with no curated plan, idea-scout
    // micro leaves available — must invent product, not emit micro.
    const decision = evaluateQueueFeeder({
      capacity: { free: 8, pendingQueueDepth: 0 },
      candidates: [
        umbrella({
          repo: 'jeanibarz/lucy',
          number: 1587,
          title: 'Umbrella: acquisition redundancy & failover',
          labels: ['acquisition', 'umbrella'],
          openChildrenCount: 0,
        }),
        umbrella({
          repo: 'jeanibarz/lucy',
          number: 2713,
          title: 'Umbrella: control-room UX density',
          labels: ['product-surface-ux', 'umbrella'],
          openChildrenCount: 0,
        }),
      ],
      openProductMetricIssues: 0,
      consecutiveBlockedEmpty: 10,
      readyIssues: [
        {
          repo: 'jeanibarz/lucy',
          number: 2718,
          title: 'chore: detection-rollup retention path',
          labels: ['idea-scout', 'micro-hardening'],
          assignees: [],
        },
        {
          repo: 'jeanibarz/lucy',
          number: 2719,
          title: 'chore: detection-rollup doctor path',
          labels: ['idea-scout'],
          assignees: [],
        },
      ],
      resolveLeaves: () => undefined,
    });
    expect(decision.action).toBe('invent-product-wave');
    expect(decision.inventPriorityClass).toBe('product');
    expect(decision.selected?.number).toBe(1587);
    expect(decision.secondaryEmitted).toHaveLength(0);
    expect(
      decision.skipped.some((s) => /micro-hardening demoted under invent pressure/.test(s.reason)),
    ).toBe(true);
  });

  it('invents under product-surface-ux umbrella when curated plan exhausted', () => {
    const decision = evaluateQueueFeeder({
      capacity: { free: 6, pendingQueueDepth: 0 },
      candidates: [
        umbrella({
          repo: 'jeanibarz/lucy',
          number: 2713,
          title: 'control-room UX density residual',
          labels: ['product-surface-ux'],
          openChildrenCount: 0,
        }),
      ],
      openProductMetricIssues: 0,
      consecutiveBlockedEmpty: 3,
      readyIssues: [
        {
          repo: 'jeanibarz/lucy',
          number: 2720,
          title: 'micro-hardening ops polish',
          labels: ['micro-hardening', 'idea-scout'],
        },
      ],
      resolveLeaves: () => undefined,
    });
    expect(decision.action).toBe('invent-product-wave');
    expect(decision.selected?.productMetricBlocking).toBe(true);
    expect(decision.inventPriorityClass).toBe('product');
    expect(decision.secondaryEmitted).toHaveLength(0);
  });

  it('ranks product ready issues before micro when secondary emit is the only path', () => {
    const decision = evaluateQueueFeeder({
      capacity: { free: 7, pendingQueueDepth: 0 },
      candidates: [
        umbrella({
          number: 2047,
          title: 'Umbrella: idea-scout residual — docs',
          labels: ['docs'],
          openChildrenCount: 0,
        }),
      ],
      openProductMetricIssues: 0,
      consecutiveBlockedEmpty: 0,
      readyIssues: [
        {
          repo: 'jeanibarz/lucy',
          number: 10,
          title: 'chore: detection-rollup retention path',
          labels: ['idea-scout', 'micro-hardening'],
        },
        {
          repo: 'jeanibarz/lucy',
          number: 11,
          title: 'feat(acquisition): probe fails closed',
          labels: ['idea-scout', 'acquisition'],
        },
      ],
      resolveLeaves: () => undefined,
    });
    expect(decision.action).toBe('emit-secondary');
    expect(decision.secondaryEmitted[0]?.number).toBe(11);
    expect(decision.inventPriorityClass).toBe('product');
  });

  it('suppresses pure micro secondary under pressure when product ready exists', () => {
    const decision = evaluateQueueFeeder({
      capacity: { free: 7, pendingQueueDepth: 0 },
      candidates: [],
      openProductMetricIssues: 0,
      consecutiveBlockedEmpty: 5,
      readyIssues: [
        {
          repo: 'jeanibarz/lucy',
          number: 20,
          title: 'micro-hardening doctor path',
          labels: ['micro-hardening', 'idea-scout'],
        },
        {
          repo: 'jeanibarz/lucy',
          number: 21,
          title: 'feat: acquisition failover residual',
          labels: ['acquisition', 'idea-scout'],
        },
      ],
    });
    expect(decision.action).toBe('emit-secondary');
    expect(decision.secondaryEmitted.map((i) => i.number)).toEqual([21]);
    expect(
      decision.skipped.some((s) => /micro-hardening demoted under invent pressure/.test(s.reason)),
    ).toBe(true);
    expect(decision.inventPriorityClass).toBe('product');
  });
});

describe('lucy#1588 canonical decomposition (AC5) + idempotency (AC2)', () => {
  it('has a vetted 3-leaf plan registered, each leaf well-formed', () => {
    const plan = curatedLeafPlan('jeanibarz/lucy#1588');
    expect(plan).toBe(LUCY_1588_LEAF_PLAN);
    expect(plan).toHaveLength(3);
    const normalized = normalizeLeafPlan(plan);
    expect(normalized.ok).toBe(true);
    for (const leaf of plan!) {
      expect(validateLeafSpec(leaf)).toEqual([]);
      expect(leaf.acceptanceCriteria.length).toBeGreaterThanOrEqual(2);
    }
    expect(Object.keys(CURATED_LEAF_PLANS)).toContain('jeanibarz/lucy#1588');
  });

  it('emits lucy#1588 leaves when it has no open children yet', () => {
    const decision = evaluateQueueFeeder({
      capacity: { free: 5, pendingQueueDepth: 0 },
      candidates: [
        umbrella({
          repo: 'jeanibarz/lucy',
          number: 1588,
          title: 'anchor truth — SEC acceptance anchors',
          openChildrenCount: 0,
        }),
      ],
    });
    expect(decision.selected?.ref).toBe('jeanibarz/lucy#1588');
    expect(decision.leafCount).toBe(3);
    expect(decision.selected?.needsAuthoring).toBe(false);
  });

  it('SKIPS lucy#1588 once it already has open children #1963–#1965 (idempotent)', () => {
    const decision = evaluateQueueFeeder({
      capacity: { free: 5, pendingQueueDepth: 0 },
      candidates: [
        umbrella({
          repo: 'jeanibarz/lucy',
          number: 1588,
          title: 'anchor truth — SEC acceptance anchors',
          openChildrenCount: 3, // #1963, #1964, #1965 already open
        }),
      ],
    });
    expect(decision.selected).toBeNull();
    expect(decision.skipped[0]!.ref).toBe('jeanibarz/lucy#1588');
    expect(decision.skipped[0]!.reason).toMatch(/already has 3 open child/);
  });
});

describe('lucy#1587 acquisition failover curated plan', () => {
  it('has a vetted 3-leaf invent-wave residual plan registered, each leaf well-formed', () => {
    const plan = curatedLeafPlan('jeanibarz/lucy#1587');
    expect(plan).toBe(LUCY_1587_LEAF_PLAN);
    expect(plan).toHaveLength(3);
    const normalized = normalizeLeafPlan(plan);
    expect(normalized.ok).toBe(true);
    expect(normalized.leaves).toHaveLength(3);
    for (const leaf of plan!) {
      expect(validateLeafSpec(leaf)).toEqual([]);
      expect(leaf.acceptanceCriteria.length).toBeGreaterThanOrEqual(2);
      expect(leaf.labels).toContain('acquisition');
      expect(leaf.labels).toContain('product-metric');
    }
    expect(Object.keys(CURATED_LEAF_PLANS)).toContain('jeanibarz/lucy#1587');
    expect(plan!.map((l) => l.title)).toEqual([
      'feat(acquisition): still collect the issuer page when q4-json items fail earnings validation',
      'feat(acquisition): stamp event_seen_no_content on advisory-only issuer pages and keep the watch live',
      'feat(acquisition): persist a press-releases child URL when ir_url is an overview hub',
    ]);
  });

  it('emits lucy#1587 leaves when it has no open children yet', () => {
    const decision = evaluateQueueFeeder({
      capacity: { free: 5, pendingQueueDepth: 0 },
      candidates: [
        umbrella({
          repo: 'jeanibarz/lucy',
          number: 1587,
          title: 'Umbrella: acquisition redundancy & failover',
          openChildrenCount: 0,
        }),
      ],
    });
    expect(decision.selected?.ref).toBe('jeanibarz/lucy#1587');
    expect(decision.selected?.productMetricBlocking).toBe(true);
    expect(decision.leafCount).toBe(3);
    expect(decision.selected?.needsAuthoring).toBe(false);
  });

  it('SKIPS lucy#1587 once residual leaves already exist (idempotent)', () => {
    const decision = evaluateQueueFeeder({
      capacity: { free: 5, pendingQueueDepth: 0 },
      candidates: [
        umbrella({
          repo: 'jeanibarz/lucy',
          number: 1587,
          title: 'Umbrella: acquisition redundancy & failover',
          openChildrenCount: 3, // invent-wave titles live; open cap still skips
        }),
      ],
    });
    expect(decision.selected).toBeNull();
    expect(decision.skipped[0]!.ref).toBe('jeanibarz/lucy#1587');
    expect(decision.skipped[0]!.reason).toMatch(/already has 3 open child/);
  });
});

describe('lucy#1590 headline metrics residual curated plan', () => {
  it('has a vetted 3-leaf invent-wave residual plan registered, each leaf well-formed', () => {
    const plan = curatedLeafPlan('jeanibarz/lucy#1590');
    expect(plan).toBe(LUCY_1590_LEAF_PLAN);
    expect(plan).toHaveLength(3);
    const normalized = normalizeLeafPlan(plan);
    expect(normalized.ok).toBe(true);
    expect(normalized.leaves).toHaveLength(3);
    for (const leaf of plan!) {
      expect(validateLeafSpec(leaf)).toEqual([]);
      expect(leaf.acceptanceCriteria.length).toBeGreaterThanOrEqual(2);
    }
    expect(Object.keys(CURATED_LEAF_PLANS)).toContain('jeanibarz/lucy#1590');
    // invent wave 3 titles (live leaves #2743–#2745)
    expect(plan!.map((l) => l.title)).toEqual([
      'feat(metrics): wire product-metric-trend into detection-rollup nightly so weekly triad grows in prod',
      'feat(metrics): control-room surfaces weekly triad trend from product-metric-trend.jsonl',
      'feat(metrics): canary fails when status secLead fields diverge from latest detection-rollup row',
    ]);
  });

  it('emits lucy#1590 leaves when it has no open children yet', () => {
    const decision = evaluateQueueFeeder({
      capacity: { free: 5, pendingQueueDepth: 0 },
      candidates: [
        umbrella({
          repo: 'jeanibarz/lucy',
          number: 1590,
          title:
            'Umbrella: headline metrics in tested code — detection-lead rollup, wired reliability metrics, degraded-health surfaces',
          openChildrenCount: 0,
        }),
      ],
    });
    expect(decision.selected?.ref).toBe('jeanibarz/lucy#1590');
    expect(decision.selected?.productMetricBlocking).toBe(true);
    expect(decision.leafCount).toBe(3);
    expect(decision.selected?.needsAuthoring).toBe(false);
  });

  it('SKIPS lucy#1590 once residual leaves already exist (idempotent)', () => {
    const decision = evaluateQueueFeeder({
      capacity: { free: 5, pendingQueueDepth: 0 },
      candidates: [
        umbrella({
          repo: 'jeanibarz/lucy',
          number: 1590,
          title:
            'Umbrella: headline metrics in tested code — detection-lead rollup, wired reliability metrics, degraded-health surfaces',
          openChildrenCount: 3,
        }),
      ],
    });
    expect(decision.selected).toBeNull();
    expect(decision.skipped[0]!.ref).toBe('jeanibarz/lucy#1590');
    expect(decision.skipped[0]!.reason).toMatch(/already has 3 open child/);
  });
});

describe('lucy#1586 publish-window-safe issuer acquisition residual curated plan', () => {
  it('has a vetted 4-leaf residual plan registered, each leaf well-formed', () => {
    const plan = curatedLeafPlan('jeanibarz/lucy#1586');
    expect(plan).toBe(LUCY_1586_LEAF_PLAN);
    expect(plan).toHaveLength(4);
    const normalized = normalizeLeafPlan(plan);
    expect(normalized.ok).toBe(true);
    expect(normalized.leaves).toHaveLength(4);
    for (const leaf of plan!) {
      expect(validateLeafSpec(leaf)).toEqual([]);
      expect(leaf.acceptanceCriteria.length).toBeGreaterThanOrEqual(2);
    }
    expect(Object.keys(CURATED_LEAF_PLANS)).toContain('jeanibarz/lucy#1586');
  });

  it('emits lucy#1586 leaves when it has no open children yet', () => {
    const decision = evaluateQueueFeeder({
      capacity: { free: 5, pendingQueueDepth: 0 },
      candidates: [
        umbrella({
          repo: 'jeanibarz/lucy',
          number: 1586,
          title:
            'Umbrella: publish-window-safe issuer acquisition (deadline: Jul 27 AMC wave)',
          openChildrenCount: 0,
        }),
      ],
    });
    expect(decision.selected?.ref).toBe('jeanibarz/lucy#1586');
    expect(decision.selected?.productMetricBlocking).toBe(true);
    expect(decision.leafCount).toBe(4);
    expect(decision.selected?.needsAuthoring).toBe(false);
  });

  it('SKIPS lucy#1586 once residual leaves already exist (idempotent)', () => {
    const decision = evaluateQueueFeeder({
      capacity: { free: 5, pendingQueueDepth: 0 },
      candidates: [
        umbrella({
          repo: 'jeanibarz/lucy',
          number: 1586,
          title:
            'Umbrella: publish-window-safe issuer acquisition (deadline: Jul 27 AMC wave)',
          openChildrenCount: 4,
        }),
      ],
    });
    expect(decision.selected).toBeNull();
    expect(decision.skipped[0]!.ref).toBe('jeanibarz/lucy#1586');
    expect(decision.skipped[0]!.reason).toMatch(/already has 4 open child/);
  });
});


describe('lucy#1593 replay-corpus validity residual curated plan', () => {
  it('has a vetted 4-leaf residual plan registered, each leaf well-formed', () => {
    const plan = curatedLeafPlan('jeanibarz/lucy#1593');
    expect(plan).toBe(LUCY_1593_LEAF_PLAN);
    expect(plan).toHaveLength(4);
    const normalized = normalizeLeafPlan(plan);
    expect(normalized.ok).toBe(true);
    expect(normalized.leaves).toHaveLength(4);
    for (const leaf of plan!) {
      expect(validateLeafSpec(leaf)).toEqual([]);
      expect(leaf.acceptanceCriteria.length).toBeGreaterThanOrEqual(2);
    }
    expect(Object.keys(CURATED_LEAF_PLANS)).toContain('jeanibarz/lucy#1593');
  });

  it('emits lucy#1593 leaves when it has no open children yet', () => {
    const decision = evaluateQueueFeeder({
      capacity: { free: 5, pendingQueueDepth: 0 },
      candidates: [
        umbrella({
          repo: 'jeanibarz/lucy',
          number: 1593,
          title:
            'Umbrella: replay-corpus validity — backtesting-audit P0.3/P1 roadmap',
          openChildrenCount: 0,
        }),
      ],
    });
    expect(decision.selected?.ref).toBe('jeanibarz/lucy#1593');
    expect(decision.selected?.needsAuthoring).toBe(false);
    expect(decision.leafCount).toBe(4);
  });

  it('SKIPS lucy#1593 once residual leaves already exist (idempotent)', () => {
    const decision = evaluateQueueFeeder({
      capacity: { free: 5, pendingQueueDepth: 0 },
      candidates: [
        umbrella({
          repo: 'jeanibarz/lucy',
          number: 1593,
          title:
            'Umbrella: replay-corpus validity — backtesting-audit P0.3/P1 roadmap',
          openChildrenCount: 4,
        }),
      ],
    });
    expect(decision.selected).toBeNull();
    expect(decision.skipped[0]!.ref).toBe('jeanibarz/lucy#1593');
    expect(decision.skipped[0]!.reason).toMatch(/already has 4 open child/);
  });
});

describe('lucy#1589 forward-corpus denominator hygiene residual curated plan', () => {
  it('has a vetted 5-leaf residual plan registered, each leaf well-formed', () => {
    const plan = curatedLeafPlan('jeanibarz/lucy#1589');
    expect(plan).toBe(LUCY_1589_LEAF_PLAN);
    expect(plan).toHaveLength(5);
    const normalized = normalizeLeafPlan(plan);
    expect(normalized.ok).toBe(true);
    expect(normalized.leaves).toHaveLength(5);
    for (const leaf of plan!) {
      expect(validateLeafSpec(leaf)).toEqual([]);
      expect(leaf.acceptanceCriteria.length).toBeGreaterThanOrEqual(2);
    }
    expect(Object.keys(CURATED_LEAF_PLANS)).toContain('jeanibarz/lucy#1589');
  });

  it('emits lucy#1589 leaves when it has no open children yet', () => {
    const decision = evaluateQueueFeeder({
      capacity: { free: 5, pendingQueueDepth: 0 },
      candidates: [
        umbrella({
          repo: 'jeanibarz/lucy',
          number: 1589,
          title:
            'Umbrella: forward-corpus denominator hygiene — exclude replays, measure the BMO lane, name the sparse-tape regime',
          openChildrenCount: 0,
        }),
      ],
    });
    expect(decision.selected?.ref).toBe('jeanibarz/lucy#1589');
    expect(decision.selected?.needsAuthoring).toBe(false);
    expect(decision.leafCount).toBe(5);
  });

  it('SKIPS lucy#1589 once residual leaves already exist (idempotent)', () => {
    const decision = evaluateQueueFeeder({
      capacity: { free: 5, pendingQueueDepth: 0 },
      candidates: [
        umbrella({
          repo: 'jeanibarz/lucy',
          number: 1589,
          title:
            'Umbrella: forward-corpus denominator hygiene — exclude replays, measure the BMO lane, name the sparse-tape regime',
          openChildrenCount: 5,
        }),
      ],
    });
    expect(decision.selected).toBeNull();
    expect(decision.skipped[0]!.ref).toBe('jeanibarz/lucy#1589');
    expect(decision.skipped[0]!.reason).toMatch(/already has 5 open child/);
  });
});

describe('lucy#1594 pre-registered forward contracts + frozen holdout residual curated plan', () => {
  it('has a vetted 5-leaf residual plan registered, each leaf well-formed', () => {
    const plan = curatedLeafPlan('jeanibarz/lucy#1594');
    expect(plan).toBe(LUCY_1594_LEAF_PLAN);
    expect(plan).toHaveLength(5);
    const normalized = normalizeLeafPlan(plan);
    expect(normalized.ok).toBe(true);
    expect(normalized.leaves).toHaveLength(5);
    for (const leaf of plan!) {
      expect(validateLeafSpec(leaf)).toEqual([]);
      expect(leaf.acceptanceCriteria.length).toBeGreaterThanOrEqual(2);
    }
    expect(Object.keys(CURATED_LEAF_PLANS)).toContain('jeanibarz/lucy#1594');
  });

  it('emits lucy#1594 leaves when it has no open children yet', () => {
    const decision = evaluateQueueFeeder({
      capacity: { free: 5, pendingQueueDepth: 0 },
      candidates: [
        umbrella({
          repo: 'jeanibarz/lucy',
          number: 1594,
          title:
            'Umbrella: pre-registered forward contracts + frozen holdout — backtesting-audit P2',
          openChildrenCount: 0,
        }),
      ],
    });
    expect(decision.selected?.ref).toBe('jeanibarz/lucy#1594');
    expect(decision.selected?.needsAuthoring).toBe(false);
    expect(decision.leafCount).toBe(5);
  });

  it('SKIPS lucy#1594 once residual leaves already exist (idempotent)', () => {
    const decision = evaluateQueueFeeder({
      capacity: { free: 5, pendingQueueDepth: 0 },
      candidates: [
        umbrella({
          repo: 'jeanibarz/lucy',
          number: 1594,
          title:
            'Umbrella: pre-registered forward contracts + frozen holdout — backtesting-audit P2',
          openChildrenCount: 5,
        }),
      ],
    });
    expect(decision.selected).toBeNull();
    expect(decision.skipped[0]!.ref).toBe('jeanibarz/lucy#1594');
    expect(decision.skipped[0]!.reason).toMatch(/already has 5 open child/);
  });
});

describe('buildLeafIssueBody', () => {
  it('renders goal, checkbox ACs, both hint sections and a repo-qualified backref', () => {
    const body = buildLeafIssueBody(LUCY_1588_LEAF_PLAN[0]!, 'jeanibarz/lucy#1588');
    expect(body).toContain('## Goal');
    expect(body).toContain('## Acceptance criteria');
    expect(body).toContain('- [ ] ');
    expect(body).toContain('## File hints');
    expect(body).toContain('## Test hints');
    expect(body).toContain('Leaf of umbrella jeanibarz/lucy#1588');
  });

  it('omits hint sections when a leaf has none', () => {
    const body = buildLeafIssueBody(GOOD_LEAF, 'jeanibarz/lucy#42');
    expect(body).toContain('## Goal');
    expect(body).not.toContain('## File hints');
    expect(body).not.toContain('## Test hints');
    expect(body).toContain('Leaf of umbrella jeanibarz/lucy#42');
  });
});

describe('observability (AC4)', () => {
  it('builds a dry-run record naming the shredded umbrella and leaf count', () => {
    const decision = evaluateQueueFeeder({
      capacity: { free: 5, pendingQueueDepth: 0 },
      candidates: [umbrella({ number: 1588, title: 'SEC anchors', labels: ['sec-anchor'] })],
      resolveLeaves: () => nLeaves(3),
    });
    const record = buildQueueFeederRecord(decision, { now: new Date('2026-08-01T18:00:00Z') });
    expect(record.schemaVersion).toBe(QUEUE_FEEDER_SCHEMA);
    expect(record.action).toBe('shred');
    expect(record.source).toBe('umbrella-shred');
    expect(record.selectedRef).toBe('jeanibarz/lucy#1588');
    expect(record.leafCount).toBe(3);
    expect(record.leafTitles).toHaveLength(3);
    expect(record.dryRun).toBe(true);
    expect(record.ts).toBe('2026-08-01T18:00:00.000Z');

    const line = formatQueueFeederLine(record);
    expect(line).toContain('DRY-RUN');
    expect(line).toContain('jeanibarz/lucy#1588');
    expect(line).toContain('3 leaf');
    expect(line).toMatch(/action=shred/);
  });

  it('formats a not-triggered line', () => {
    const decision = evaluateQueueFeeder({
      capacity: { free: 5, pendingQueueDepth: 2 },
      candidates: [],
    });
    const line = formatQueueFeederLine(buildQueueFeederRecord(decision));
    expect(line).toMatch(/not triggered/);
  });

  it('formats a skip-invent line when residual needs authoring and no ready issues', () => {
    const decision = evaluateQueueFeeder({
      capacity: { free: 5, pendingQueueDepth: 0 },
      candidates: [umbrella({ number: 99, title: 'docs residual' })],
      resolveLeaves: () => undefined,
    });
    const record = buildQueueFeederRecord(decision);
    expect(record.action).toBe('skip-invent');
    expect(formatQueueFeederLine(record)).toMatch(/action=skip-invent/);
  });

  it('ledger path lives under playbook-state and trims trailing slashes', () => {
    expect(queueFeederLedgerPath('/root/.kookr/')).toBe(
      '/root/.kookr/playbook-state/queue-feeder/decisions.jsonl',
    );
  });
});
