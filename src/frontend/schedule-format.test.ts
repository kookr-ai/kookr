import { describe, expect, test } from 'vitest';
import type { ScheduleResponse } from '../shared/protocol.js';
import {
  formatScheduleRelativeTime,
  formatScheduleRollupLine,
  pickNextOverviewSchedule,
  scheduleNextRunLabel,
  scheduleRollupTooltip,
} from './schedule-format.js';

function makeSchedule(overrides: Partial<ScheduleResponse> = {}): ScheduleResponse {
  return {
    id: overrides.id ?? 'sched-1',
    name: overrides.name ?? 'Nightly sweep',
    enabled: overrides.enabled ?? true,
    cron: '0 3 * * *',
    playbook: { path: '/p.md', parameters: {} },
    cwd: '/repo',
    agentType: 'claude-code',
    executionLedger: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    nextRunAt: '2026-01-02T03:00:00Z',
    cronDescription: 'every day at 3:00',
    ...overrides,
  };
}

const NOW = Date.parse('2026-06-20T10:00:00.000Z');

describe('formatScheduleRelativeTime', () => {
  test('formats a future timestamp as in N', () => {
    expect(formatScheduleRelativeTime('2026-06-20T10:12:00.000Z', NOW)).toBe('in 12m');
  });

  test('formats a past timestamp as N ago', () => {
    expect(formatScheduleRelativeTime('2026-06-20T09:00:00.000Z', NOW)).toBe('1h ago');
  });

  test('returns N/A when the timestamp is missing', () => {
    expect(formatScheduleRelativeTime(null, NOW)).toBe('N/A');
    expect(formatScheduleRelativeTime(undefined, NOW)).toBe('N/A');
  });
});

describe('scheduleNextRunLabel', () => {
  test('labels exhausted before paused or a leftover next-run', () => {
    expect(scheduleNextRunLabel(makeSchedule({
      enabled: false,
      stopReason: 'trigger_limit_reached',
      nextRunAt: '2026-06-20T10:12:00.000Z',
    }), NOW)).toBe('exhausted');
  });

  test('labels a disabled schedule paused instead of next fire', () => {
    expect(scheduleNextRunLabel(makeSchedule({
      enabled: false,
      nextRunAt: '2026-06-20T10:12:00.000Z',
    }), NOW)).toBe('paused');
  });

  test('uses the relative next-run for an enabled schedule', () => {
    expect(scheduleNextRunLabel(makeSchedule({
      nextRunAt: '2026-06-20T10:12:00.000Z',
    }), NOW)).toBe('in 12m');
  });
});

describe('pickNextOverviewSchedule', () => {
  test('returns null when there are no schedules', () => {
    expect(pickNextOverviewSchedule([])).toBeNull();
  });

  test('prefers the soonest fireable schedule over an earlier paused one', () => {
    const pausedSooner = makeSchedule({
      id: 'paused',
      name: 'Paused soon',
      enabled: false,
      nextRunAt: '2026-06-20T10:05:00.000Z',
    });
    const enabledLater = makeSchedule({
      id: 'live',
      name: 'Live later',
      nextRunAt: '2026-06-20T10:12:00.000Z',
    });
    expect(pickNextOverviewSchedule([pausedSooner, enabledLater])?.id).toBe('live');
  });

  test('among fireable schedules picks the earliest nextRunAt even if it is not first', () => {
    const later = makeSchedule({
      id: 'later',
      name: 'Later sweep',
      nextRunAt: '2026-06-20T11:00:00.000Z',
    });
    const sooner = makeSchedule({
      id: 'sooner',
      name: 'Sooner sweep',
      nextRunAt: '2026-06-20T10:12:00.000Z',
    });
    expect(pickNextOverviewSchedule([later, sooner])?.id).toBe('sooner');
  });

  test('falls back to a paused or exhausted schedule when nothing will fire', () => {
    const exhausted = makeSchedule({
      id: 'exhausted',
      stopReason: 'trigger_limit_reached',
      nextRunAt: '2026-06-20T10:05:00.000Z',
    });
    const paused = makeSchedule({
      id: 'paused',
      enabled: false,
      nextRunAt: '2026-06-20T10:12:00.000Z',
    });
    expect(pickNextOverviewSchedule([paused, exhausted])?.id).toBe('exhausted');
  });
});

describe('formatScheduleRollupLine', () => {
  test('joins fires, measured cost, and artifacts', () => {
    expect(formatScheduleRollupLine({
      fires: 5,
      measuredFires: 3,
      costUsd: 1.25,
      artifacts: 2,
    })).toBe('5 fires · $1.25 measured · 2 artifacts');
  });

  test('does not render unmeasured cost as $0 even if costUsd is leftover', () => {
    expect(formatScheduleRollupLine({
      fires: 4,
      measuredFires: 0,
      costUsd: 1.25,
      artifacts: 1,
    })).toBe('4 fires · unmeasured · 1 artifact');
  });

  test('renders a measured $0 as measured, not unmeasured', () => {
    expect(formatScheduleRollupLine({
      fires: 2,
      measuredFires: 2,
      costUsd: 0,
      artifacts: 0,
    })).toBe('2 fires · $0.0000 measured · 0 artifacts');
  });

  test('returns null for a never-run (zero-fire) row', () => {
    expect(formatScheduleRollupLine({
      fires: 0,
      measuredFires: 0,
      costUsd: 0,
      artifacts: 0,
    })).toBeNull();
  });

  test('tooltip names the measuredFires denominator', () => {
    expect(scheduleRollupTooltip({ fires: 5, measuredFires: 3 })).toContain('3 of 5 fires');
  });
});
