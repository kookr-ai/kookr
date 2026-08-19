import { describe, expect, it, vi } from 'vitest';
import type { Schedule, ScheduleExecutionLedgerEntry, ScheduleExecutionOutcome } from '../core/schedule.js';
import type { ServerMessage } from '../shared/contracts/messages.js';
import {
  DEFAULT_STALE_SCHEDULE_FLOOR_MS,
  ScheduleStaleAlarm,
  STALE_MISSED_FIRE_MULTIPLIER,
  evaluateScheduleLiveness,
} from './schedule-liveness.js';

const DAY = 24 * 3_600_000;

const NOW = Date.parse('2026-08-19T12:00:00.000Z');
const HOUR = 3_600_000;

let entrySeq = 0;
function entry(
  outcome: ScheduleExecutionOutcome,
  evaluatedAtMs: number,
  scheduleId = 'sched-1',
): ScheduleExecutionLedgerEntry {
  entrySeq += 1;
  return {
    id: `entry-${entrySeq}`,
    scheduleId,
    trigger: 'cron',
    decision: 'cron_due',
    evaluatedAt: new Date(evaluatedAtMs).toISOString(),
    completedAt: new Date(evaluatedAtMs).toISOString(),
    outcome,
  };
}

function schedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: 'sched-1',
    name: 'Orchestration supervisor',
    enabled: true,
    cron: '0 * * * *', // hourly → 1h cadence, 6h threshold under the default floor
    playbook: { path: 'supervisor.md', parameters: {} },
    cwd: '/tmp',
    agentType: 'claude-code',
    executionLedger: [],
    createdAt: new Date(NOW - 30 * 24 * HOUR).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    ...overrides,
  } as Schedule;
}

function alertsOf(broadcast: ReturnType<typeof vi.fn>): Array<Extract<ServerMessage, { type: 'alert' }>> {
  return broadcast.mock.calls.map(([msg]) => msg as Extract<ServerMessage, { type: 'alert' }>);
}

describe('evaluateScheduleLiveness (issue #2694)', () => {
  it('flags a fast schedule that has left no ledger activity for two days (the incident)', () => {
    const dark = schedule({
      executionLedger: [
        entry('completed', NOW - 6 * 24 * HOUR),
        entry('completed', NOW - 48 * HOUR), // last trace 2 days ago
      ],
    });
    const stale = evaluateScheduleLiveness([dark], NOW, DEFAULT_STALE_SCHEDULE_FLOOR_MS);
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatchObject({ id: 'sched-1', name: 'Orchestration supervisor' });
    expect(stale[0].silenceMs).toBe(48 * HOUR);
    expect(stale[0].maxGapMs).toBe(HOUR);
  });

  it('does NOT flag a schedule that fired within its cadence', () => {
    const healthy = schedule({
      executionLedger: [entry('completed', NOW - 30 * 60_000)], // 30m ago
    });
    expect(evaluateScheduleLiveness([healthy], NOW, DEFAULT_STALE_SCHEDULE_FLOOR_MS)).toEqual([]);
  });

  it('is cadence-relative: a daily schedule silent 6h is not flagged, but silent 3 days is', () => {
    const dailyCron = '0 9 * * *'; // 24h cadence → 48h threshold
    const quietDaily = schedule({
      cron: dailyCron,
      executionLedger: [entry('completed', NOW - 6 * HOUR)],
    });
    expect(evaluateScheduleLiveness([quietDaily], NOW, DEFAULT_STALE_SCHEDULE_FLOOR_MS)).toEqual([]);

    const darkDaily = schedule({
      cron: dailyCron,
      executionLedger: [entry('completed', NOW - 72 * HOUR)],
    });
    const stale = evaluateScheduleLiveness([darkDaily], NOW, DEFAULT_STALE_SCHEDULE_FLOOR_MS);
    expect(stale).toHaveLength(1);
    expect(stale[0].maxGapMs).toBe(24 * HOUR);
    expect(stale[0].thresholdMs).toBe(STALE_MISSED_FIRE_MULTIPLIER * 24 * HOUR);
  });

  it('does NOT flag a clustered business-hours cron during its overnight quiet window (regression: max gap, not next-two delta)', () => {
    // 0 9-17 * * * fires hourly 09:00–17:00 → the real quiet window is the 16h
    // overnight gap 17:00→09:00, not the 1h daytime delta. Threshold must be
    // built from 16h (max 32h), so an overnight silence is not flagged dark.
    const businessHours = schedule({
      cron: '0 9-17 * * *',
      // NOW is 12:00Z; last fire was the prior day's 17:00 close = 19h ago,
      // longer than the 6h floor but well inside its 32h cadence threshold.
      executionLedger: [entry('completed', NOW - 19 * HOUR)],
    });
    const stale = evaluateScheduleLiveness([businessHours], NOW, DEFAULT_STALE_SCHEDULE_FLOOR_MS);
    expect(stale).toEqual([]);

    // But a genuinely dark business-hours schedule (silent > 32h) still fires.
    const darkBusiness = schedule({
      cron: '0 9-17 * * *',
      executionLedger: [entry('completed', NOW - 40 * HOUR)],
    });
    const staleDark = evaluateScheduleLiveness([darkBusiness], NOW, DEFAULT_STALE_SCHEDULE_FLOOR_MS);
    expect(staleDark).toHaveLength(1);
    expect(staleDark[0].maxGapMs).toBe(16 * HOUR);
  });

  it('does NOT flag a weekday-only cron across its weekend gap', () => {
    // 0 9 * * 1-5 → Fri-09:00 to Mon-09:00 is a legitimate 72h gap. Silent
    // over a weekend must not trip. maxGap 72h → threshold 144h.
    const weekday = schedule({
      cron: '0 9 * * 1-5',
      executionLedger: [entry('completed', NOW - 60 * HOUR)],
    });
    expect(evaluateScheduleLiveness([weekday], NOW, DEFAULT_STALE_SCHEDULE_FLOOR_MS)).toEqual([]);

    const darkWeekday = schedule({
      cron: '0 9 * * 1-5',
      executionLedger: [entry('completed', NOW - 7 * DAY)],
    });
    expect(evaluateScheduleLiveness([darkWeekday], NOW, DEFAULT_STALE_SCHEDULE_FLOOR_MS)).toHaveLength(1);
  });

  it('closes the dead-man blind spot: a single dark schedule is flagged even while siblings stay healthy', () => {
    const dark = schedule({
      id: 'dark',
      name: 'Dark supervisor',
      executionLedger: [entry('completed', NOW - 48 * HOUR, 'dark')],
    });
    const liveSibling = schedule({
      id: 'live',
      name: 'Live sibling',
      executionLedger: [entry('completed', NOW - 20 * 60_000, 'live')],
    });
    const stale = evaluateScheduleLiveness([dark, liveSibling], NOW, DEFAULT_STALE_SCHEDULE_FLOOR_MS);
    expect(stale.map((s) => s.id)).toEqual(['dark']);
  });

  it('ignores disabled and trigger-exhausted schedules', () => {
    const disabled = schedule({
      id: 'disabled',
      enabled: false,
      executionLedger: [entry('completed', NOW - 48 * HOUR, 'disabled')],
    });
    const exhausted = schedule({
      id: 'exhausted',
      maxTriggers: 3,
      remainingTriggers: 0,
      executionLedger: [entry('completed', NOW - 48 * HOUR, 'exhausted')],
    });
    expect(evaluateScheduleLiveness([disabled, exhausted], NOW, DEFAULT_STALE_SCHEDULE_FLOOR_MS)).toEqual([]);
  });

  it('measures silence from createdAt for a never-fired schedule (no false alarm on a young one)', () => {
    const young = schedule({
      createdAt: new Date(NOW - 10 * 60_000).toISOString(), // 10m old, never fired
      executionLedger: [],
    });
    expect(evaluateScheduleLiveness([young], NOW, DEFAULT_STALE_SCHEDULE_FLOOR_MS)).toEqual([]);
  });

  it('flags a schedule that has never fired but is long overdue since creation', () => {
    const bornDark = schedule({
      createdAt: new Date(NOW - 3 * 24 * HOUR).toISOString(), // hourly, but no fire in 3 days
      executionLedger: [],
    });
    const stale = evaluateScheduleLiveness([bornDark], NOW, DEFAULT_STALE_SCHEDULE_FLOOR_MS);
    expect(stale).toHaveLength(1);
    expect(stale[0].silenceMs).toBe(3 * 24 * HOUR);
  });

  it('uses the newest ledger entry as the heartbeat, not the oldest', () => {
    const recovered = schedule({
      executionLedger: [
        entry('completed', NOW - 48 * HOUR),
        entry('completed', NOW - 15 * 60_000), // fresh — schedule is alive
      ],
    });
    expect(evaluateScheduleLiveness([recovered], NOW, DEFAULT_STALE_SCHEDULE_FLOOR_MS)).toEqual([]);
  });
});

describe('ScheduleStaleAlarm (issue #2694)', () => {
  function makeAlarm(nowMs: () => number, floorMs = DEFAULT_STALE_SCHEDULE_FLOOR_MS) {
    const broadcast = vi.fn();
    const recordTransition = vi.fn();
    const alarm = new ScheduleStaleAlarm({
      broadcast,
      recordTransition,
      getStaleFloorMs: () => floorMs,
      now: () => new Date(nowMs()),
    });
    return { broadcast, recordTransition, alarm };
  }

  const darkLedger = () => ({ executionLedger: [entry('completed', NOW - 48 * HOUR)] });

  it('raises exactly ONE warning alert per dark episode across repeated ticks (synthetic-stale)', () => {
    const { broadcast, alarm } = makeAlarm(() => NOW);
    const dark = schedule(darkLedger());

    alarm.check([dark]);
    alarm.check([dark]);
    alarm.check([dark]);

    const alerts = alertsOf(broadcast);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      type: 'alert',
      agentId: 'system',
      severity: 'warning',
      operationalAlert: {
        key: 'schedule:stale:sched-1',
        metric: 'schedule_liveness',
        state: 'fired',
      },
    });
    expect(alerts[0].summary).toContain('gone dark');
  });

  it('records the transition to the durable sink before broadcasting', () => {
    const { broadcast, recordTransition, alarm } = makeAlarm(() => NOW);
    alarm.check([schedule(darkLedger())]);
    expect(recordTransition).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(recordTransition.mock.invocationCallOrder[0]).toBeLessThan(
      broadcast.mock.invocationCallOrder[0],
    );
  });

  it('clears the episode with one recovery alert when the schedule fires again', () => {
    const { broadcast, alarm } = makeAlarm(() => NOW);
    alarm.check([schedule(darkLedger())]);
    expect(alertsOf(broadcast)).toHaveLength(1);

    const recovered = schedule({
      executionLedger: [entry('completed', NOW - 48 * HOUR), entry('completed', NOW - 5 * 60_000)],
    });
    alarm.check([recovered]);
    alarm.check([recovered]);

    const alerts = alertsOf(broadcast);
    expect(alerts).toHaveLength(2);
    expect(alerts[1]).toMatchObject({
      severity: 'info',
      operationalAlert: { key: 'schedule:stale:sched-1', state: 'recovered' },
    });
    // Recovery names the schedule (operability): not a generic "a dark schedule".
    expect(alerts[1].summary).toContain('Orchestration supervisor');
  });

  it('clears the episode when the dark schedule is disabled or removed', () => {
    const { broadcast, alarm } = makeAlarm(() => NOW);
    alarm.check([schedule(darkLedger())]);
    alarm.check([]); // schedule removed from the store
    const alerts = alertsOf(broadcast);
    expect(alerts).toHaveLength(2);
    expect(alerts[1].operationalAlert).toMatchObject({ state: 'recovered' });
  });

  it('keys alerts per schedule so multiple dark schedules each fire once', () => {
    const { broadcast, alarm } = makeAlarm(() => NOW);
    const a = schedule({ id: 'a', name: 'Alpha', executionLedger: [entry('completed', NOW - 48 * HOUR, 'a')] });
    const b = schedule({ id: 'b', name: 'Beta', executionLedger: [entry('completed', NOW - 48 * HOUR, 'b')] });

    alarm.check([a, b]);
    alarm.check([a, b]);

    const keys = alertsOf(broadcast).map((al) => al.operationalAlert?.key);
    expect(keys.sort()).toEqual(['schedule:stale:a', 'schedule:stale:b']);
  });

  it('stays silent end-to-end when schedules are healthy', () => {
    const { broadcast, alarm } = makeAlarm(() => NOW);
    const healthy = schedule({ executionLedger: [entry('completed', NOW - 20 * 60_000)] });
    alarm.check([healthy]);
    alarm.check([healthy]);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('disabling mid-episode (floor 0) closes the open episode with a recovery so the durable trace never dangles', () => {
    const nowMs = () => NOW;
    const broadcast = vi.fn();
    let floor = DEFAULT_STALE_SCHEDULE_FLOOR_MS;
    const alarm = new ScheduleStaleAlarm({ broadcast, getStaleFloorMs: () => floor, now: () => new Date(nowMs()) });

    alarm.check([schedule(darkLedger())]);
    expect(broadcast).toHaveBeenCalledTimes(1); // fired while enabled

    floor = 0; // operator disables the alarm mid-episode
    alarm.check([schedule(darkLedger())]);
    const alerts = alertsOf(broadcast);
    // One recovery emitted so every `fired` has a matching `recovered`.
    expect(alerts).toHaveLength(2);
    expect(alerts[1].operationalAlert).toMatchObject({ key: 'schedule:stale:sched-1', state: 'recovered' });

    // Stays quiet thereafter — no re-fire, no duplicate recovery.
    alarm.check([schedule(darkLedger())]);
    expect(broadcast).toHaveBeenCalledTimes(2);
  });

  it('exposes current stale schedules via stats() for a status/health surface', () => {
    const { alarm } = makeAlarm(() => NOW);
    expect(alarm.stats()).toEqual({ staleCount: 0, staleSchedules: [] });

    const a = schedule({ id: 'a', name: 'Alpha', executionLedger: [entry('completed', NOW - 48 * HOUR, 'a')] });
    alarm.check([a]);
    expect(alarm.stats()).toEqual({ staleCount: 1, staleSchedules: [{ id: 'a', name: 'Alpha' }] });

    const recovered = schedule({ id: 'a', name: 'Alpha', executionLedger: [entry('completed', NOW - 2 * 60_000, 'a')] });
    alarm.check([recovered]);
    expect(alarm.stats()).toEqual({ staleCount: 0, staleSchedules: [] });
  });
});
