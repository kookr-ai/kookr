/**
 * Starvation invent priority policy (issue #2358).
 *
 * When `consecutiveBlockedEmpty` climbs (or the implement belt is empty with
 * free slots), invent capacity must prefer dual-priority product leaves
 * (acquisition / product-surface-ux / product-metric umbrellas) over
 * micro-hardening / idea-scout ops polish. Pure classification + ranking —
 * no I/O. Queue-feeder, starvation scout prompts, and health rollups consume
 * these helpers so product runway is not spent on sideways micro invent.
 */

import {
  DEFAULT_PRODUCT_METRIC_LABELS,
  isProductMetricBlocking,
} from './value-density-governor.js';

/** Priority class for invent / secondary-emit decisions. */
export type InventPriorityClass = 'product' | 'micro' | 'other';

/**
 * Minimum consecutive product blocked-empty events that force invent
 * preference for dual-priority product leaves (issue #2358).
 */
export const DEFAULT_STARVATION_INVENT_BLOCKED_EMPTY_THRESHOLD = 3;

/**
 * Labels that mark dual-priority product invent (acquisition + control-room UX).
 * Extends product-metric labels so invent ranking agrees with value-density.
 */
export const DEFAULT_PRODUCT_INVENT_LABELS: readonly string[] = Object.freeze([
  ...DEFAULT_PRODUCT_METRIC_LABELS,
  'product-surface-ux',
  'control-room',
]);

/**
 * Labels that mark micro-hardening / pure idea-scout ops polish — demoted under
 * invent pressure while product runway remains.
 */
export const DEFAULT_MICRO_HARDENING_LABELS: readonly string[] = Object.freeze([
  'micro-hardening',
  'micro-ops',
  'ops-polish',
]);

const MICRO_TITLE_PATTERNS: readonly RegExp[] = Object.freeze([
  /\bmicro[- ]hardening\b/i,
  /\bmicro[- ]ops\b/i,
  /\bops\s+polish\b/i,
  // Live lucy idea-scout micro residual shape (workflow reflection 2026-08-12):
  // detection-rollup retention / paths / doctor — not dual-priority product.
  /\bdetection[- ]rollup\b/i,
  /\bretention\s+(path|paths|window)\b/i,
  /\bdoctor\b.*\b(path|retention|rollup)\b/i,
]);

const PRODUCT_SURFACE_TITLE_PATTERNS: readonly RegExp[] = Object.freeze([
  /\bproduct[- ]surface\b/i,
  /\bcontrol[- ]room\b/i,
  /\bux\s+density\b/i,
  /\bexperiment\s+presentation\b/i,
]);

function normalizeLabel(label: string): string {
  return label.trim().toLowerCase();
}

function hasAnyLabel(labels: readonly string[] | undefined, wanted: readonly string[]): boolean {
  if (!labels || labels.length === 0) return false;
  const set = new Set(wanted.map(normalizeLabel));
  return labels.some((l) => set.has(normalizeLabel(l)));
}

/**
 * Classify invent priority from title + labels.
 *
 * Precedence: product (dual-priority / product-metric) wins over micro, so a
 * product-surface-ux issue that also carries idea-scout is still product.
 */
export function classifyInventPriority(
  title: string,
  labels?: readonly string[],
  opts?: {
    productLabels?: readonly string[];
    microLabels?: readonly string[];
  },
): InventPriorityClass {
  const productLabels = opts?.productLabels ?? DEFAULT_PRODUCT_INVENT_LABELS;
  const microLabels = opts?.microLabels ?? DEFAULT_MICRO_HARDENING_LABELS;
  const t = title ?? '';

  if (
    isProductMetricBlocking(t, labels, productLabels)
    || hasAnyLabel(labels, productLabels)
    || PRODUCT_SURFACE_TITLE_PATTERNS.some((re) => re.test(t))
  ) {
    return 'product';
  }

  if (
    hasAnyLabel(labels, microLabels)
    || MICRO_TITLE_PATTERNS.some((re) => re.test(t))
  ) {
    return 'micro';
  }

  return 'other';
}

/** Sort key: product first, then other, micro last. Higher = preferred. */
export function inventPriorityScore(klass: InventPriorityClass): number {
  switch (klass) {
    case 'product':
      return 100;
    case 'other':
      return 10;
    case 'micro':
      return 0;
    default: {
      const _exhaustive: never = klass;
      return _exhaustive;
    }
  }
}

export interface InventPressureInput {
  /**
   * Consecutive product blocked-empty depth for the target repo (from
   * pipeline-starvation state). 0 / omitted = no drought signal.
   */
  consecutiveBlockedEmpty?: number;
  /**
   * Open product-metric leaf count on the implement belt. 0 / omitted with
   * free slots triggers empty-belt invent pressure.
   */
  openProductMetricIssues?: number;
  /** Free (or effective-free) general slots. */
  freeSlots?: number;
  freeSlotsThreshold?: number;
  /** Override drought threshold (default {@link DEFAULT_STARVATION_INVENT_BLOCKED_EMPTY_THRESHOLD}). */
  blockedEmptyThreshold?: number;
}

/**
 * True when invent must prefer dual-priority product leaves and demote
 * micro-hardening:
 *   - consecutiveBlockedEmpty ≥ K (default 3), OR
 *   - product belt empty (openProductMetricIssues === 0) with free ≥ threshold.
 */
export function isInventPressure(input: InventPressureInput): boolean {
  const threshold =
    input.blockedEmptyThreshold ?? DEFAULT_STARVATION_INVENT_BLOCKED_EMPTY_THRESHOLD;
  const consecutive = input.consecutiveBlockedEmpty ?? 0;
  if (Number.isFinite(consecutive) && consecutive >= threshold) return true;

  const freeThreshold = input.freeSlotsThreshold ?? 3;
  const free = input.freeSlots ?? 0;
  const openPm = input.openProductMetricIssues;
  if (
    openPm === 0
    && Number.isFinite(free)
    && free >= freeThreshold
  ) {
    return true;
  }
  return false;
}

/**
 * Product invent runway remains: open product-class umbrellas eligible for
 * shred/invent, or open product-class ready issues already on the board.
 * Used to suppress micro invent while product work can still refill the belt.
 */
export function hasProductInventRunway(input: {
  productUmbrellaEligible?: boolean;
  productReadyCount?: number;
}): boolean {
  if (input.productUmbrellaEligible === true) return true;
  return (input.productReadyCount ?? 0) > 0;
}

/**
 * Under invent pressure with product runway, micro-hardening invent/secondary
 * emit is suppressed. Without pressure or without product runway, micro is
 * only demoted (ranked last), never dropped.
 */
export function shouldSuppressMicroInvent(
  pressure: boolean,
  productRunway: boolean,
): boolean {
  return pressure && productRunway;
}

/** Zeroed invent-class counters for health / ledger rollups. */
export function emptyInventPriorityCounts(): Record<InventPriorityClass, number> {
  return { product: 0, micro: 0, other: 0 };
}

/**
 * Increment invent-class counters from a single invent/emit event.
 * Pure helper for ledger → health projection.
 */
export function accumulateInventPriorityCount(
  counts: Record<InventPriorityClass, number>,
  klass: InventPriorityClass,
  n = 1,
): Record<InventPriorityClass, number> {
  const next = { ...counts };
  const add = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  next[klass] = (next[klass] ?? 0) + add;
  return next;
}

/**
 * Extra instruction fragment for on-demand starvation idea-scouts under
 * invent pressure — steers publish toward dual-priority product leaves.
 */
export function starvationInventExtraInstruction(opts: {
  consecutiveBlockedEmpty: number;
  runKey?: string;
  disqualifierSummary?: string;
}): string {
  const parts = [
    `On-demand refill triggered by parallel-issue-batch blocked-empty`,
    opts.runKey ? `(runKey=${opts.runKey})` : '',
    `with consecutiveBlockedEmpty=${opts.consecutiveBlockedEmpty}.`,
    `Prefer dual-priority product leaves: acquisition / product-surface-ux /`,
    `product-metric / high-priority open umbrellas.`,
    `Suppress micro-hardening and pure idea-scout ops polish while product`,
    `leaf runway remains (issue #2358).`,
    `Prefer single-PR-safe leaves, not umbrella/tracking issues.`,
  ];
  if (opts.disqualifierSummary) {
    parts.push(`Prior open issues were all disqualified: ${opts.disqualifierSummary}.`);
  }
  return parts.filter(Boolean).join(' ');
}
