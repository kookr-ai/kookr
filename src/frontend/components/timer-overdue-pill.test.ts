import { describe, expect, test } from 'vitest';
import {
  formatTimerOverdueLabel,
  formatTimerOverdueTitle,
  shouldShowTimerOverduePill,
} from './timer-overdue-pill.js';

describe('timer-overdue-pill helpers (issue #2643)', () => {
  test('shouldShowTimerOverduePill is elevated-only and hides a missing block', () => {
    expect(shouldShowTimerOverduePill(null)).toBe(false);
    expect(shouldShowTimerOverduePill(undefined)).toBe(false);
    expect(shouldShowTimerOverduePill({ overdue: 0, oldestName: null })).toBe(false);
    expect(shouldShowTimerOverduePill({ overdue: 0, oldestName: 'save' })).toBe(false);
    expect(shouldShowTimerOverduePill({ overdue: 1, oldestName: 'save' })).toBe(true);
    expect(shouldShowTimerOverduePill({ overdue: 2, oldestName: null })).toBe(true);
  });

  test('formatTimerOverdueLabel includes the count and oldest name', () => {
    expect(formatTimerOverdueLabel({ overdue: 1, oldestName: 'maintenancePrune' }))
      .toBe('1 timer overdue · maintenancePrune');
    expect(formatTimerOverdueLabel({ overdue: 2, oldestName: 'deployLagDetector' }))
      .toBe('2 timers overdue · deployLagDetector');
    expect(formatTimerOverdueLabel({ overdue: 1, oldestName: null }))
      .toBe('1 timer overdue');
    expect(formatTimerOverdueLabel({ overdue: 3, oldestName: null }))
      .toBe('3 timers overdue');
  });

  test('formatTimerOverdueTitle points at health and Diagnostics when clickable', () => {
    const title = formatTimerOverdueTitle(
      { overdue: 2, oldestName: 'maintenancePrune' },
      true,
    );
    expect(title).toContain('2 lifecycle timers overdue');
    expect(title).toContain('oldest maintenancePrune');
    expect(title).toContain('Open Diagnostics');
    expect(title).toContain('GET /api/health.timerHealth');
  });

  test('formatTimerOverdueTitle omits the Diagnostics CTA when not clickable', () => {
    const title = formatTimerOverdueTitle(
      { overdue: 1, oldestName: 'save' },
      false,
    );
    expect(title).toContain('1 lifecycle timer overdue');
    expect(title).toContain('oldest save');
    expect(title).toContain('A safety-net loop stopped ticking');
    expect(title).not.toContain('Open Diagnostics');
  });
});
