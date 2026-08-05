import { describe, expect, test } from 'vitest';
import {
  FAA_RESIDUAL_AGE_MS_THRESHOLD,
  FAA_RESIDUAL_COUNT_THRESHOLD,
  formatFaaResidualAge,
  formatFaaResidualLabel,
  shouldShowFaaResidualPill,
} from './faa-residual-pill.js';

describe('shouldShowFaaResidualPill (issue #2082 threshold logic)', () => {
  test('hides when residual is clear (count 0)', () => {
    expect(shouldShowFaaResidualPill(0, null)).toBe(false);
    expect(shouldShowFaaResidualPill(0, FAA_RESIDUAL_AGE_MS_THRESHOLD * 2)).toBe(false);
  });

  test('hides when count is below threshold and age is young', () => {
    expect(shouldShowFaaResidualPill(1, 5 * 60_000)).toBe(false);
    expect(shouldShowFaaResidualPill(2, 29 * 60_000)).toBe(false);
    expect(shouldShowFaaResidualPill(2, null)).toBe(false);
  });

  test(`shows when count >= ${FAA_RESIDUAL_COUNT_THRESHOLD} regardless of age`, () => {
    expect(shouldShowFaaResidualPill(3, null)).toBe(true);
    expect(shouldShowFaaResidualPill(3, 0)).toBe(true);
    expect(shouldShowFaaResidualPill(7, 9e6)).toBe(true);
  });

  test(`shows when oldest age >= ${FAA_RESIDUAL_AGE_MS_THRESHOLD / 60_000}m even with small count`, () => {
    expect(shouldShowFaaResidualPill(1, FAA_RESIDUAL_AGE_MS_THRESHOLD)).toBe(true);
    expect(shouldShowFaaResidualPill(2, 45 * 60_000)).toBe(true);
  });

  test('rejects non-finite / negative counts', () => {
    expect(shouldShowFaaResidualPill(Number.NaN, FAA_RESIDUAL_AGE_MS_THRESHOLD)).toBe(false);
    expect(shouldShowFaaResidualPill(-3, FAA_RESIDUAL_AGE_MS_THRESHOLD)).toBe(false);
  });
});

describe('formatFaaResidualAge / formatFaaResidualLabel', () => {
  test('formats compact age labels', () => {
    expect(formatFaaResidualAge(null)).toBeNull();
    expect(formatFaaResidualAge(-1)).toBeNull();
    expect(formatFaaResidualAge(30_000)).toBe('<1m');
    expect(formatFaaResidualAge(5 * 60_000)).toBe('5m');
    expect(formatFaaResidualAge(2.5 * 3_600_000)).toBe('2.5h');
    expect(formatFaaResidualAge(2 * 3_600_000)).toBe('2h');
    expect(formatFaaResidualAge(9e6)).toBe('2.5h');
    expect(formatFaaResidualAge(3 * 24 * 3_600_000)).toBe('3d');
  });

  test('builds pill label with optional age', () => {
    expect(formatFaaResidualLabel(7, 9e6)).toBe('FAA residual 7 · 2.5h');
    expect(formatFaaResidualLabel(3, null)).toBe('FAA residual 3');
  });
});
