/**
 * Status-bar chip helpers for live skip / snooze / false-positive counts
 * (issue #2596). Counts come from the existing live-friction snapshot's
 * `signals[]` — this file does not invent a second mix.
 */

export const LIVE_FRICTION_SCHEMA_VERSION = 'live-friction-calibration.v1' as const;

export const LIVE_FRICTION_CHIP_TITLE =
  'Skip, snooze, and false-positive counts from Diagnostics. Diagnostics only — does not reorder findings.';

export interface LiveFrictionSignal {
  kind: string;
  count: number;
}

export interface LiveFrictionSnapshot {
  schemaVersion: string;
  signalCount: number;
  signals: LiveFrictionSignal[];
}

export interface LiveFrictionChipCounts {
  skip: number;
  snooze: number;
  falsePositive: number;
  hasFalsePositive: boolean;
  /** Snapshot `signalCount`, including kinds the chip does not print. */
  signalCount: number;
}

export function isLiveFrictionSnapshot(value: unknown): value is LiveFrictionSnapshot {
  if (value === null || typeof value !== 'object') return false;
  const rec = value as Record<string, unknown>;
  return rec.schemaVersion === LIVE_FRICTION_SCHEMA_VERSION
    && typeof rec.signalCount === 'number'
    && Number.isFinite(rec.signalCount)
    && Array.isArray(rec.signals);
}

/**
 * Sum skip / snooze / false-positive counts from `signals[]`.
 * Visibility still uses `snapshot.signalCount` (which also includes
 * direct-intervention signals). Do not recompute visibility from this mix.
 */
export function liveFrictionChipCounts(snapshot: LiveFrictionSnapshot): LiveFrictionChipCounts {
  let skip = 0;
  let snooze = 0;
  let falsePositive = 0;
  let hasFalsePositive = false;

  for (const signal of snapshot.signals) {
    const count = typeof signal.count === 'number' && Number.isFinite(signal.count)
      ? signal.count
      : 0;
    if (signal.kind === 'skipped_finding') {
      skip += count;
    } else if (signal.kind === 'snoozed_finding') {
      snooze += count;
    } else if (signal.kind === 'false_positive_feedback') {
      falsePositive += count;
      hasFalsePositive = true;
    }
  }

  return {
    skip,
    snooze,
    falsePositive,
    hasFalsePositive,
    signalCount: snapshot.signalCount,
  };
}

/** Chip is present only when the snapshot already has live friction events. */
export function shouldShowLiveFrictionChip(snapshot: LiveFrictionSnapshot | null): boolean {
  return snapshot !== null && snapshot.signalCount > 0;
}

/** Always print skip + snooze; append false-positive only when that kind is in `signals[]`. */
export function formatLiveFrictionChipLabel(counts: LiveFrictionChipCounts): string {
  const parts = [`skip ${counts.skip}`, `snooze ${counts.snooze}`];
  if (counts.hasFalsePositive) parts.push(`false-positive ${counts.falsePositive}`);
  return parts.join(' · ');
}
