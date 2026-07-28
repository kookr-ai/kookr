import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Backlog drain order (issue #1568).
 *
 * The issue-batch selectors (`plugin/playbooks/parallel-issue-batch.md` and
 * `plugin/playbooks/implement-github-issue.md`) drain open issues in a
 * blank-shape scan. Without an encoded ordering the selector picks
 * arbitrarily and may start a *gated* issue — one whose durable-state /
 * concurrency semantics still need the invariant-spec step of #1539 — before
 * the gate workflow exists.
 *
 * This module is the executable form of the ordering the selectors follow:
 * drain the no-gate tier first (in the significance-ranked order the retro
 * fixed), then any unclassified issue, and defer gated issues to the end.
 * Gated membership is driven by the {@link DrainOrder.gateLabel} label so a
 * future issue joins the gated tier with a single label, no code change.
 *
 * The canonical data lives in `plugin/playbooks/backlog-drain-order.json`,
 * committed next to the playbooks that reference it.
 */
export interface DrainOrder {
  /** Label that marks an issue as gated. Source of truth for gated membership. */
  gateLabel: string;
  /** No-gate tier issue numbers, earliest-drained first. */
  noGateTier: number[];
  /** Seeded gated tier issue numbers (cross-check for the {@link gateLabel}). */
  gatedTier: number[];
}

/** A candidate issue as seen by the selector: its number and its labels. */
export interface DrainCandidate {
  number: number;
  labels: string[];
}

/** Absolute path to the canonical committed drain-order file. */
export function drainOrderPath(): string {
  // Mirror src/core/plugin-paths.ts: __dirname under CJS build, cwd fallback.
  const here = typeof __dirname !== 'undefined' ? __dirname : process.cwd();
  return join(here, '..', '..', 'plugin', 'playbooks', 'backlog-drain-order.json');
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/**
 * Parse and validate a raw drain-order object. Throws on a malformed file so a
 * typo (missing tier, duplicate/overlapping number, non-integer) fails loudly
 * instead of silently reordering nothing.
 */
export function parseDrainOrder(raw: unknown): DrainOrder {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('drain-order: expected a JSON object');
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.gateLabel !== 'string' || obj.gateLabel.length === 0) {
    throw new Error('drain-order: gateLabel must be a non-empty string');
  }
  if (!Array.isArray(obj.noGateTier) || !obj.noGateTier.every(isPositiveInt)) {
    throw new Error('drain-order: noGateTier must be an array of positive integers');
  }
  if (!Array.isArray(obj.gatedTier) || !obj.gatedTier.every(isPositiveInt)) {
    throw new Error('drain-order: gatedTier must be an array of positive integers');
  }
  const noGate = obj.noGateTier as number[];
  const gated = obj.gatedTier as number[];
  const all = [...noGate, ...gated];
  if (new Set(all).size !== all.length) {
    throw new Error('drain-order: a number appears more than once across the tiers');
  }
  return { gateLabel: obj.gateLabel, noGateTier: noGate, gatedTier: gated };
}

/** Load and validate the canonical committed drain-order file. */
export function loadDrainOrder(path: string = drainOrderPath()): DrainOrder {
  return parseDrainOrder(JSON.parse(readFileSync(path, 'utf-8')));
}

/**
 * True when a candidate is gated: it carries the gate label (source of truth)
 * or it is one of the seeded gated numbers. Either is sufficient so a gated
 * issue is deferred even if only one signal is present.
 */
export function isGatedCandidate(candidate: DrainCandidate, order: DrainOrder): boolean {
  return candidate.labels.includes(order.gateLabel) || order.gatedTier.includes(candidate.number);
}

/**
 * Order candidates for the selector so the no-gate tier is proposed before any
 * gated issue:
 *
 *   1. no-gate-tier issues, in {@link DrainOrder.noGateTier} order;
 *   2. unclassified issues, in their original input order (stable);
 *   3. gated issues, in their original input order (stable), last.
 *
 * The relative order within groups 2 and 3 is preserved so this only *layers*
 * the tier preference on top of whatever order the selector already produced.
 */
export function orderCandidatesByDrainTier<T extends DrainCandidate>(
  candidates: T[],
  order: DrainOrder,
): T[] {
  const rank = new Map(order.noGateTier.map((n, i) => [n, i]));
  const noGate: T[] = [];
  const rest: T[] = [];
  const gated: T[] = [];
  for (const candidate of candidates) {
    if (isGatedCandidate(candidate, order)) {
      gated.push(candidate);
    } else if (rank.has(candidate.number)) {
      noGate.push(candidate);
    } else {
      rest.push(candidate);
    }
  }
  noGate.sort((a, b) => rank.get(a.number)! - rank.get(b.number)!);
  return [...noGate, ...rest, ...gated];
}
