import { describe, expect, test } from 'vitest';
import {
  formatLiveFrictionChipLabel,
  isLiveFrictionSnapshot,
  liveFrictionChipCounts,
  shouldShowLiveFrictionChip,
  type LiveFrictionSnapshot,
} from './live-friction-chip.js';

function snapshot(overrides: Partial<LiveFrictionSnapshot> = {}): LiveFrictionSnapshot {
  return {
    schemaVersion: 'live-friction-calibration.v1',
    signalCount: 0,
    signals: [],
    ...overrides,
  };
}

describe('live friction chip metric semantics (issue #2596)', () => {
  test('rejects bodies that are not the live-friction snapshot', () => {
    expect(isLiveFrictionSnapshot(null)).toBe(false);
    expect(isLiveFrictionSnapshot({
      schemaVersion: 'time-to-unblock.v1',
      medianMs: 12_000,
      sampleCount: 5,
    })).toBe(false);
    expect(isLiveFrictionSnapshot({
      schemaVersion: 'live-friction-calibration.v1',
      signalCount: 2,
    })).toBe(false);
  });

  test('accepts a v1 snapshot and hides the chip at signalCount 0', () => {
    const empty = snapshot();
    expect(isLiveFrictionSnapshot(empty)).toBe(true);
    expect(shouldShowLiveFrictionChip(empty)).toBe(false);
    expect(shouldShowLiveFrictionChip(null)).toBe(false);
  });

  test('sums skip and snooze from signals[] and keeps snapshot signalCount', () => {
    const body = snapshot({
      signalCount: 5,
      signals: [
        { kind: 'skipped_finding', count: 2 },
        { kind: 'snoozed_finding', count: 1 },
        { kind: 'skipped_finding', count: 1 },
        { kind: 'direct_intervention_without_finding', count: 1 },
      ],
    });

    const counts = liveFrictionChipCounts(body);
    expect(counts).toEqual({
      skip: 3,
      snooze: 1,
      falsePositive: 0,
      hasFalsePositive: false,
      signalCount: 5,
    });
    expect(shouldShowLiveFrictionChip(body)).toBe(true);
    expect(formatLiveFrictionChipLabel(counts)).toBe('skip 3 · snooze 1');
  });

  test('includes false-positive only when that kind is present in signals[]', () => {
    const withFp = snapshot({
      signalCount: 4,
      signals: [
        { kind: 'skipped_finding', count: 2 },
        { kind: 'snoozed_finding', count: 1 },
        { kind: 'false_positive_feedback', count: 1 },
      ],
    });
    expect(formatLiveFrictionChipLabel(liveFrictionChipCounts(withFp)))
      .toBe('skip 2 · snooze 1 · false-positive 1');

    const withoutFp = snapshot({
      signalCount: 3,
      signals: [
        { kind: 'skipped_finding', count: 2 },
        { kind: 'snoozed_finding', count: 1 },
      ],
    });
    expect(formatLiveFrictionChipLabel(liveFrictionChipCounts(withoutFp)))
      .toBe('skip 2 · snooze 1');
  });

  test('does not invent skip/snooze/fp from direct-intervention-only snapshots', () => {
    const body = snapshot({
      signalCount: 2,
      signals: [
        { kind: 'direct_intervention_without_finding', count: 2 },
      ],
    });
    const counts = liveFrictionChipCounts(body);
    expect(counts.skip).toBe(0);
    expect(counts.snooze).toBe(0);
    expect(counts.hasFalsePositive).toBe(false);
    expect(counts.signalCount).toBe(2);
    expect(shouldShowLiveFrictionChip(body)).toBe(true);
    expect(formatLiveFrictionChipLabel(counts)).toBe('skip 0 · snooze 0');
  });
});
