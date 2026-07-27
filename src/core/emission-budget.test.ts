import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONSTRAINED_BUDGET,
  DEFAULT_DEDUPE_SIMILARITY_THRESHOLD,
  DEFAULT_OPEN_BACKLOG_THRESHOLD,
  EMISSION_BUDGET_SCHEMA_VERSION,
  buildDeferredIdeaRecord,
  checkDedupe,
  computeNetBacklogDelta,
  computeNetBacklogDelta7d,
  deferredIdeasPath,
  normalizeIssueTitle,
  partitionByBudget,
  resolveEmissionBudget,
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
});
