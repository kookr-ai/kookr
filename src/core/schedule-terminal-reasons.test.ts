import { describe, expect, it } from 'vitest';
import type { Schedule, ScheduleExecutionLedgerEntry, ScheduleTerminalReason } from './schedule.js';
import { aggregateScheduleTerminalReasons } from './schedule-terminal-reasons.js';

/**
 * Build a ledger entry carrying an optional terminal classification. Only the
 * fields the aggregator reads (timestamps + terminalReason) matter here.
 */
function entry(
  overrides: Partial<ScheduleExecutionLedgerEntry> & { terminalReason?: ScheduleTerminalReason },
): ScheduleExecutionLedgerEntry {
  return {
    id: overrides.id ?? 'e',
    scheduleId: 's',
    trigger: 'cron',
    decision: 'cron_due',
    evaluatedAt: '2026-08-28T09:00:00.000Z',
    outcome: 'cancelled',
    ...overrides,
  };
}

function scheduleWith(ledger: ScheduleExecutionLedgerEntry[]): Schedule {
  return { executionLedger: ledger } as unknown as Schedule;
}

const NOW = Date.parse('2026-08-28T10:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

describe('aggregateScheduleTerminalReasons', () => {
  it('buckets classified fires by reason with occupied slot-time', () => {
    const schedules = [
      scheduleWith([
        entry({
          id: 'a',
          evaluatedAt: '2026-08-28T09:00:00.000Z',
          completedAt: '2026-08-28T09:10:00.000Z', // 10 minutes occupied
          terminalReason: { reasonCode: 'timeout', source: 'watchdog', at: '2026-08-28T09:10:00.000Z' },
        }),
        entry({
          id: 'b',
          evaluatedAt: '2026-08-28T09:20:00.000Z',
          completedAt: '2026-08-28T09:25:00.000Z', // 5 minutes occupied
          terminalReason: { reasonCode: 'timeout', source: 'watchdog', at: '2026-08-28T09:25:00.000Z' },
        }),
      ]),
    ];

    const agg = aggregateScheduleTerminalReasons(schedules, { nowMs: NOW, windowMs: DAY });

    expect(agg.total).toBe(2);
    expect(agg.byReason.timeout).toEqual({ count: 2, occupiedMs: 15 * 60 * 1000 });
    expect(agg.occupiedMs).toBe(15 * 60 * 1000);
    expect(agg.byProvider).toEqual({});
  });

  it('buckets provider failures by resolved provider', () => {
    const schedules = [
      scheduleWith([
        entry({
          id: 'p1',
          evaluatedAt: '2026-08-28T09:00:00.000Z',
          completedAt: '2026-08-28T09:02:00.000Z',
          terminalReason: { reasonCode: 'provider_failure', source: 'task_self', provider: 'grok', at: '2026-08-28T09:02:00.000Z' },
        }),
        entry({
          id: 'p2',
          evaluatedAt: '2026-08-28T09:05:00.000Z',
          completedAt: '2026-08-28T09:06:00.000Z',
          terminalReason: { reasonCode: 'provider_failure', source: 'task_self', provider: 'grok', at: '2026-08-28T09:06:00.000Z' },
        }),
      ]),
    ];

    const agg = aggregateScheduleTerminalReasons(schedules, { nowMs: NOW, windowMs: DAY });

    expect(agg.byReason.provider_failure.count).toBe(2);
    expect(agg.byProvider.grok).toEqual({ count: 2, occupiedMs: 3 * 60 * 1000 });
  });

  it('excludes clean completions so they do not swamp the failure signal', () => {
    const schedules = [
      scheduleWith([
        entry({
          id: 'ok1',
          completedAt: '2026-08-28T09:10:00.000Z',
          terminalReason: { reasonCode: 'completed_normal', source: 'task_self', at: '2026-08-28T09:10:00.000Z' },
        }),
        entry({
          id: 'ok2',
          completedAt: '2026-08-28T09:20:00.000Z',
          terminalReason: { reasonCode: 'completed_recovery', source: 'restart_recovery', at: '2026-08-28T09:20:00.000Z' },
        }),
        entry({
          id: 'fail',
          evaluatedAt: '2026-08-28T09:25:00.000Z',
          completedAt: '2026-08-28T09:30:00.000Z',
          terminalReason: { reasonCode: 'timeout', source: 'watchdog', at: '2026-08-28T09:30:00.000Z' },
        }),
      ]),
    ];

    const agg = aggregateScheduleTerminalReasons(schedules, { nowMs: NOW, windowMs: DAY });

    expect(agg.total).toBe(1);
    expect(agg.byReason).toEqual({ timeout: { count: 1, occupiedMs: 5 * 60 * 1000 } });
    expect(agg.byReason.completed_normal).toBeUndefined();
    expect(agg.byReason.completed_recovery).toBeUndefined();
  });

  it('excludes fires whose transition falls outside the window', () => {
    const schedules = [
      scheduleWith([
        entry({
          id: 'old',
          terminalReason: { reasonCode: 'timeout', source: 'watchdog', at: '2026-08-20T09:00:00.000Z' },
        }),
        entry({
          id: 'recent',
          terminalReason: { reasonCode: 'timeout', source: 'watchdog', at: '2026-08-28T09:30:00.000Z' },
        }),
      ]),
    ];

    const agg = aggregateScheduleTerminalReasons(schedules, { nowMs: NOW, windowMs: DAY });

    expect(agg.total).toBe(1);
    expect(agg.byReason.timeout.count).toBe(1);
  });

  it('skips unclassified ledger rows and counts fires missing timestamps at 0 occupied', () => {
    const schedules = [
      scheduleWith([
        entry({ id: 'noclass', outcome: 'completed' }), // no terminalReason → skipped
        entry({
          id: 'notime',
          completedAt: undefined, // no completedAt → counted, 0 occupied
          terminalReason: { reasonCode: 'unknown', source: 'unknown', at: '2026-08-28T09:40:00.000Z' },
        }),
      ]),
    ];

    const agg = aggregateScheduleTerminalReasons(schedules, { nowMs: NOW, windowMs: DAY });

    expect(agg.total).toBe(1);
    expect(agg.byReason.unknown).toEqual({ count: 1, occupiedMs: 0 });
    expect(agg.occupiedMs).toBe(0);
  });

  it('clamps a negative (clock-skew) duration to 0 occupied rather than fabricating negative time', () => {
    const schedules = [
      scheduleWith([
        entry({
          id: 'skew',
          evaluatedAt: '2026-08-28T09:10:00.000Z',
          completedAt: '2026-08-28T09:05:00.000Z', // completed before evaluated
          terminalReason: { reasonCode: 'timeout', source: 'watchdog', at: '2026-08-28T09:10:00.000Z' },
        }),
      ]),
    ];

    const agg = aggregateScheduleTerminalReasons(schedules, { nowMs: NOW, windowMs: DAY });

    expect(agg.total).toBe(1);
    expect(agg.occupiedMs).toBe(0);
    expect(agg.byReason.timeout).toEqual({ count: 1, occupiedMs: 0 });
  });

  it('returns an empty rollup when no schedules carry classified fires', () => {
    const agg = aggregateScheduleTerminalReasons([scheduleWith([entry({ outcome: 'running' })])], {
      nowMs: NOW,
      windowMs: DAY,
    });

    expect(agg.total).toBe(0);
    expect(agg.byReason).toEqual({});
    expect(agg.byProvider).toEqual({});
    expect(agg.windowMs).toBe(DAY);
    expect(agg.generatedAt).toBe(new Date(NOW).toISOString());
  });
});
