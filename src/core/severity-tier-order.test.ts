import { describe, test, expect } from 'vitest';
import {
  SeverityCandidate,
  fastLaneRank,
  isDeferredCandidate,
  isFastLaneCandidate,
  loadSeverityTierOrder,
  orderCandidatesBySeverityTier,
  parseSeverityTierOrder,
} from './severity-tier-order.js';

/**
 * Contract + selection-simulation tests for the severity tier order (#1658).
 *
 * Real production bugs must not sit as peers of cosmetic idea issues in daily
 * selection. These tests pin the committed label vocabulary and prove the
 * selector proposes prod-bug/outage issues before any idea issue, however the
 * raw candidate list was ordered.
 */
describe('severity tier order', () => {
  const order = loadSeverityTierOrder();

  test('the committed file encodes the fast-lane vocabulary, most-severe first', () => {
    expect(order.fastLaneLabels).toEqual(['outage', 'prod-bug', 'auto-triage']);
  });

  test('the committed file defers idea-scout issues', () => {
    expect(order.deferLabels).toContain('idea-scout');
  });

  test('no label appears in both the fast-lane and defer vocabularies', () => {
    const overlap = order.fastLaneLabels.filter((l) => order.deferLabels.includes(l));
    expect(overlap).toEqual([]);
  });

  test('parseSeverityTierOrder rejects a non-object / null', () => {
    expect(() => parseSeverityTierOrder(null)).toThrow(/expected a JSON object/);
    expect(() => parseSeverityTierOrder('not an object')).toThrow(/expected a JSON object/);
  });

  test('parseSeverityTierOrder rejects a label listed as both fast-lane and defer', () => {
    expect(() =>
      parseSeverityTierOrder({ fastLaneLabels: ['prod-bug', 'x'], deferLabels: ['x'] }),
    ).toThrow(/both fast-lane and defer/);
  });

  test('parseSeverityTierOrder rejects a non-string label entry', () => {
    expect(() =>
      parseSeverityTierOrder({ fastLaneLabels: ['prod-bug', 3], deferLabels: [] }),
    ).toThrow(/non-empty strings/);
  });

  test('parseSeverityTierOrder rejects an empty-string label entry', () => {
    expect(() =>
      parseSeverityTierOrder({ fastLaneLabels: ['prod-bug', ''], deferLabels: [] }),
    ).toThrow(/non-empty strings/);
  });

  test('parseSeverityTierOrder rejects a missing deferLabels tier', () => {
    expect(() => parseSeverityTierOrder({ fastLaneLabels: ['prod-bug'] })).toThrow(
      /deferLabels must be an array/,
    );
  });

  test('parseSeverityTierOrder rejects a missing or empty fastLaneLabels tier', () => {
    // An empty fast lane silently disables prod-bug promotion — reject it.
    expect(() => parseSeverityTierOrder({ deferLabels: ['idea-scout'] })).toThrow(
      /fastLaneLabels must be a non-empty array/,
    );
    expect(() =>
      parseSeverityTierOrder({ fastLaneLabels: [], deferLabels: ['idea-scout'] }),
    ).toThrow(/fastLaneLabels must be a non-empty array/);
  });

  test('parseSeverityTierOrder accepts an empty deferLabels tier (promote-only config)', () => {
    expect(() => parseSeverityTierOrder({ fastLaneLabels: ['prod-bug'], deferLabels: [] })).not.toThrow();
  });

  test('a candidate is fast-lane by any fast-lane label', () => {
    expect(isFastLaneCandidate({ number: 1, labels: ['prod-bug', 'bug'] }, order)).toBe(true);
    expect(isFastLaneCandidate({ number: 2, labels: ['documentation'] }, order)).toBe(false);
  });

  test('a fast-lane label wins over a defer label — a prod bug tagged idea is not buried', () => {
    const both: SeverityCandidate = { number: 3, labels: ['idea-scout', 'prod-bug'] };
    expect(isFastLaneCandidate(both, order)).toBe(true);
    expect(isDeferredCandidate(both, order)).toBe(false);
  });

  test('an idea-scout issue with no fast-lane label is deferred', () => {
    expect(isDeferredCandidate({ number: 4, labels: ['idea-scout'] }, order)).toBe(true);
  });

  test('fastLaneRank reflects severity — outage outranks a plain prod-bug', () => {
    expect(fastLaneRank({ number: 5, labels: ['outage'] }, order)).toBeLessThan(
      fastLaneRank({ number: 6, labels: ['prod-bug'] }, order),
    );
    expect(fastLaneRank({ number: 7, labels: ['documentation'] }, order)).toBe(Infinity);
  });

  /**
   * Selection simulation: a realistic mixed, shuffled backlog — prod bugs and a
   * live outage carrying fast-lane labels, idea-scout issues, and unrelated
   * open issues — is ordered by the selector's rule.
   */
  test('selection simulation proposes every fast-lane issue before any idea issue', () => {
    const candidates: SeverityCandidate[] = [
      { number: 1701, labels: ['idea-scout'] },
      { number: 1714, labels: ['outage', 'auto-triage'] }, // live capability outage
      { number: 5001, labels: ['enhancement'] }, // unrelated, unclassified
      { number: 1702, labels: ['idea-scout'] },
      { number: 1726, labels: ['prod-bug', 'auto-triage'] },
      { number: 5002, labels: ['documentation'] }, // unrelated, unclassified
      { number: 1703, labels: ['idea-scout'] },
      { number: 1713, labels: ['auto-triage'] },
    ];

    const ordered = orderCandidatesBySeverityTier(candidates, order).map((c) => c.number);

    const fastLane = [1714, 1726, 1713];
    const ideas = [1701, 1702, 1703];
    const lastFastLaneIdx = Math.max(...fastLane.map((n) => ordered.indexOf(n)));
    const firstIdeaIdx = Math.min(...ideas.map((n) => ordered.indexOf(n)));
    expect(lastFastLaneIdx).toBeLessThan(firstIdeaIdx);

    // The selector's first proposal is the live outage.
    expect(ordered[0]).toBe(1714);
    // Every idea sinks below every unclassified issue.
    expect(ordered.indexOf(5001)).toBeLessThan(firstIdeaIdx);
    expect(ordered.indexOf(5002)).toBeLessThan(firstIdeaIdx);
  });

  test('within the fast lane, outages sort ahead of plain prod-bugs regardless of input order', () => {
    const candidates: SeverityCandidate[] = [
      { number: 20, labels: ['prod-bug'] },
      { number: 21, labels: ['auto-triage'] },
      { number: 22, labels: ['outage'] },
    ];
    const ordered = orderCandidatesBySeverityTier(candidates, order).map((c) => c.number);
    expect(ordered).toEqual([22, 20, 21]);
  });

  test('ties within a fast-lane rank keep their input order (stable)', () => {
    const candidates: SeverityCandidate[] = [
      { number: 31, labels: ['prod-bug'] },
      { number: 30, labels: ['prod-bug'] },
    ];
    const ordered = orderCandidatesBySeverityTier(candidates, order).map((c) => c.number);
    expect(ordered).toEqual([31, 30]);
  });

  test('unclassified issues sort after the fast lane and before deferred issues', () => {
    const candidates: SeverityCandidate[] = [
      { number: 40, labels: ['idea-scout'] },
      { number: 41, labels: [] },
      { number: 42, labels: ['prod-bug'] },
    ];
    const ordered = orderCandidatesBySeverityTier(candidates, order).map((c) => c.number);
    expect(ordered).toEqual([42, 41, 40]);
  });

  test('a prod bug also tagged an idea is ordered into the fast lane, not buried', () => {
    // End-to-end (through orderCandidatesBySeverityTier, not just the predicates):
    // the both-labeled issue must land ahead of the plain idea issue.
    const candidates: SeverityCandidate[] = [
      { number: 60, labels: ['idea-scout'] },
      { number: 61, labels: ['idea-scout', 'prod-bug'] },
      { number: 62, labels: [] },
    ];
    const ordered = orderCandidatesBySeverityTier(candidates, order).map((c) => c.number);
    expect(ordered).toEqual([61, 62, 60]);
  });

  test('ordering an empty candidate list returns an empty list', () => {
    expect(orderCandidatesBySeverityTier([], order)).toEqual([]);
  });

  test('ordering is pure — no candidate is dropped and the input array is not mutated', () => {
    const candidates: SeverityCandidate[] = [
      { number: 50, labels: ['idea-scout'] },
      { number: 51, labels: ['prod-bug'] },
      { number: 52, labels: [] },
    ];
    const byNumber = (a: number, b: number) => a - b;
    const snapshot = candidates.map((c) => c.number);
    const ordered = orderCandidatesBySeverityTier(candidates, order);
    expect(ordered).toHaveLength(candidates.length);
    expect(ordered.map((c) => c.number).sort(byNumber)).toEqual([...snapshot].sort(byNumber));
    expect(candidates.map((c) => c.number)).toEqual(snapshot); // input untouched
  });
});
