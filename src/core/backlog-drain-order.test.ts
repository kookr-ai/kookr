import { describe, test, expect } from 'vitest';
import {
  DrainCandidate,
  isGatedCandidate,
  loadDrainOrder,
  orderCandidatesByDrainTier,
  parseDrainOrder,
} from './backlog-drain-order.js';

/**
 * Contract + selection-simulation tests for the backlog drain order (#1568).
 *
 * The retro seeded a no-gate tier (safe to drain in any order) and a gated
 * tier (needs the invariant-gate workflow of #1539 first). These tests pin the
 * committed ordering and prove the selector proposes no-gate-tier issues
 * before gated-tier issues, however the raw candidate list was ordered.
 */
describe('backlog drain order', () => {
  const order = loadDrainOrder();

  const NO_GATE = [1400, 1373, 1386, 1397, 1372, 1391, 1393, 1367, 1385, 1399];
  const GATED = [1392, 1398, 1371, 1433];

  test('the committed file encodes the retro-fixed no-gate order', () => {
    expect(order.noGateTier).toEqual(NO_GATE);
  });

  test('every seeded gated issue is in the gated tier', () => {
    for (const n of GATED) expect(order.gatedTier).toContain(n);
  });

  test('the gate label is invariant-gate', () => {
    expect(order.gateLabel).toBe('invariant-gate');
  });

  test('no issue number appears in both tiers', () => {
    const overlap = order.noGateTier.filter((n) => order.gatedTier.includes(n));
    expect(overlap).toEqual([]);
  });

  test('parseDrainOrder rejects a number listed in both tiers', () => {
    expect(() =>
      parseDrainOrder({ gateLabel: 'invariant-gate', noGateTier: [1, 2], gatedTier: [2, 3] }),
    ).toThrow(/more than once/);
  });

  test('parseDrainOrder rejects a non-integer tier entry', () => {
    expect(() =>
      parseDrainOrder({ gateLabel: 'invariant-gate', noGateTier: [1.5], gatedTier: [] }),
    ).toThrow(/positive integers/);
  });

  test('a candidate is gated by its label even if it is not a seeded number', () => {
    // Future gated issue: joins the gated tier with the label alone, no code change.
    const future: DrainCandidate = { number: 9999, labels: ['invariant-gate'] };
    expect(isGatedCandidate(future, order)).toBe(true);
  });

  test('a seeded gated number is gated even without the label yet applied', () => {
    expect(isGatedCandidate({ number: 1392, labels: [] }, order)).toBe(true);
  });

  /**
   * Selection simulation: a realistic mixed, shuffled candidate pool — gated
   * issues carrying the label, no-gate-tier issues out of order, and unrelated
   * open issues — is ordered by the selector's rule.
   */
  test('selection simulation proposes every no-gate-tier issue before any gated issue', () => {
    const candidates: DrainCandidate[] = [
      { number: 1433, labels: ['invariant-gate', 'enhancement'] },
      { number: 1385, labels: ['documentation'] },
      { number: 1400, labels: [] },
      { number: 1392, labels: ['invariant-gate'] },
      { number: 5001, labels: ['enhancement'] }, // unrelated, unclassified
      { number: 1371, labels: ['invariant-gate'] },
      { number: 1373, labels: ['test'] },
      { number: 1398, labels: ['invariant-gate'] },
      { number: 1367, labels: [] },
      { number: 1391, labels: [] },
      { number: 1386, labels: [] },
      { number: 1397, labels: [] },
      { number: 1372, labels: [] },
      { number: 1393, labels: [] },
      { number: 1399, labels: [] },
    ];

    const ordered = orderCandidatesByDrainTier(candidates, order).map((c) => c.number);

    const lastNoGateIdx = Math.max(...NO_GATE.map((n) => ordered.indexOf(n)));
    const firstGatedIdx = Math.min(...GATED.map((n) => ordered.indexOf(n)));
    expect(lastNoGateIdx).toBeLessThan(firstGatedIdx);

    // The selector's first proposal is the highest-priority no-gate issue.
    expect(ordered[0]).toBe(1400);
  });

  test('selection simulation preserves the exact no-gate tier order', () => {
    // Feed the no-gate issues reversed; the selector must restore tier order.
    const reversed: DrainCandidate[] = [...NO_GATE]
      .reverse()
      .map((number) => ({ number, labels: [] }));
    const ordered = orderCandidatesByDrainTier(reversed, order).map((c) => c.number);
    expect(ordered).toEqual(NO_GATE);
  });

  test('unclassified issues sort after the no-gate tier and before gated issues', () => {
    const candidates: DrainCandidate[] = [
      { number: 1392, labels: ['invariant-gate'] },
      { number: 7777, labels: [] },
      { number: 1400, labels: [] },
    ];
    const ordered = orderCandidatesByDrainTier(candidates, order).map((c) => c.number);
    expect(ordered).toEqual([1400, 7777, 1392]);
  });
});
