import { describe, expect, test } from 'vitest';
import {
  formatPausedSchedulesLabel,
  formatPausedSchedulesTitle,
  shouldShowPausedSchedulesPill,
} from './paused-schedules-pill.js';

describe('paused-schedules-pill helpers (issue #2432)', () => {
  test('shouldShowPausedSchedulesPill is elevated-only', () => {
    expect(shouldShowPausedSchedulesPill(null)).toBe(false);
    expect(shouldShowPausedSchedulesPill(undefined)).toBe(false);
    expect(shouldShowPausedSchedulesPill({ schedulesPausedByFailure: [] })).toBe(false);
    expect(shouldShowPausedSchedulesPill({
      schedulesPausedByFailure: [{ id: 's1', name: 'orchestrator', consecutiveFailures: 3 }],
    })).toBe(true);
  });

  test('formatPausedSchedulesLabel uses singular and plural count copy', () => {
    expect(formatPausedSchedulesLabel({
      schedulesPausedByFailure: [{ id: 's1', name: 'orchestrator', consecutiveFailures: 3 }],
    })).toBe('1 schedule paused');

    expect(formatPausedSchedulesLabel({
      schedulesPausedByFailure: [
        { id: 's1', name: 'orchestrator', consecutiveFailures: 30 },
        { id: 's2', name: 'deploy-conv', consecutiveFailures: 55 },
      ],
    })).toBe('2 schedules paused');
  });

  test('formatPausedSchedulesTitle samples names and points at health', () => {
    const title = formatPausedSchedulesTitle({
      schedulesPausedByFailure: [
        { id: 's1', name: 'orchestrator', consecutiveFailures: 30 },
        { id: 's2', name: 'deploy-conv', consecutiveFailures: 55 },
        { id: 's3', name: 'sentinel', consecutiveFailures: 29 },
        { id: 's4', name: 'idea-scout', consecutiveFailures: 12 },
      ],
    });
    expect(title).toContain('4 schedules paused after consecutive failures');
    expect(title).toContain('orchestrator (fail×30)');
    expect(title).toContain('deploy-conv (fail×55)');
    expect(title).toContain('sentinel (fail×29)');
    expect(title).toContain('+1 more');
    expect(title).not.toContain('idea-scout');
    expect(title).toContain('GET /api/health.schedules');
  });

  test('formatPausedSchedulesTitle lists every name when the set is small', () => {
    const title = formatPausedSchedulesTitle({
      schedulesPausedByFailure: [
        { id: 's1', name: 'orchestrator', consecutiveFailures: 3 },
      ],
    });
    expect(title).toContain('1 schedule paused after consecutive failures');
    expect(title).toContain('orchestrator (fail×3)');
    expect(title).not.toContain('+');
  });
});
