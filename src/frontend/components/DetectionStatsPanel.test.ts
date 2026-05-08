import { describe, expect, test } from 'vitest';
import { formatDetectionStatsSummary } from './detection-stats-format.js';

describe('formatDetectionStatsSummary', () => {
  test('does not show a per-hour rate during the initial startup window', () => {
    const summary = formatDetectionStatsSummary(
      27,
      '2026-05-08T14:54:00.000Z',
      new Date('2026-05-08T14:57:00.000Z').getTime(),
    );

    expect(summary).toBe('27 findings');
  });

  test('shows per-hour rate once uptime is long enough to be meaningful', () => {
    const summary = formatDetectionStatsSummary(
      27,
      '2026-05-08T13:54:00.000Z',
      new Date('2026-05-08T14:57:00.000Z').getTime(),
    );

    expect(summary).toBe('27 findings · 25.7/hr');
  });
});
