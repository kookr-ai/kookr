import { describe, expect, it, vi } from 'vitest';
import type { Schedule, ScheduleExecutionLedgerEntry, ScheduleExecutionOutcome } from '../core/schedule.js';
import type { ServerMessage } from '../shared/contracts/messages.js';
import {
  DEFAULT_PROVIDER_PARK_ALARM_MS,
  PROVIDER_PARK_MIN_RUN,
  ScheduleProviderParkAlarm,
  evaluateScheduleProviderParks,
} from './schedule-provider-park-alarm.js';

const NOW = Date.parse('2026-09-04T12:00:00.000Z');
const HOUR = 3_600_000;
const MIN = 60_000;

let entrySeq = 0;
function entry(
  outcome: ScheduleExecutionOutcome,
  evaluatedAtMs: number,
  scheduleId = 'sched-1',
  extra: Partial<ScheduleExecutionLedgerEntry> = {},
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
    ...extra,
  };
}

/** A run of `count` provider parks, one per minute, ending `endAgoMs` before NOW. */
function parkRun(count: number, oldestAgoMs: number, scheduleId = 'sched-1'): ScheduleExecutionLedgerEntry[] {
  const rows: ScheduleExecutionLedgerEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    rows.push(
      entry('skipped_provider_paused', NOW - oldestAgoMs + i * MIN, scheduleId, {
        reasonCode: 'provider_paused',
        message: 'no launchable substitute for unavailable pin',
      }),
    );
  }
  return rows;
}

function schedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: 'sched-1',
    name: 'Watchdog supervisor',
    enabled: true,
    cron: '* * * * *', // every minute → parks every tick
    playbook: { path: 'supervisor.md', parameters: {} },
    cwd: '/tmp',
    agentType: 'grok-build',
    executionLedger: [],
    createdAt: new Date(NOW - 30 * 24 * HOUR).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    ...overrides,
  } as Schedule;
}

function alertsOf(broadcast: ReturnType<typeof vi.fn>): Array<Extract<ServerMessage, { type: 'alert' }>> {
  return broadcast.mock.calls.map(([msg]) => msg as Extract<ServerMessage, { type: 'alert' }>);
}

describe('evaluateScheduleProviderParks (issue #3034)', () => {
  it('flags a schedule continuously parked-on-provider past the bounded age', () => {
    const parked = schedule({ executionLedger: parkRun(400, 7 * HOUR) }); // oldest 7h ago > 6h
    const result = evaluateScheduleProviderParks([parked], NOW, DEFAULT_PROVIDER_PARK_ALARM_MS);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'sched-1',
      name: 'Watchdog supervisor',
      runLength: 400,
      reasonCode: 'provider_paused',
    });
    expect(result[0].parkAgeMs).toBe(7 * HOUR);
  });

  it('is age-bounded: a park run younger than the threshold raises nothing', () => {
    // Oldest park 5h ago, still under the 6h default.
    const young = schedule({ executionLedger: parkRun(300, 5 * HOUR) });
    expect(evaluateScheduleProviderParks([young], NOW, DEFAULT_PROVIDER_PARK_ALARM_MS)).toEqual([]);
  });

  it('pins the exact boundary: age === threshold does NOT fire, age = threshold + 1ms does', () => {
    // parkAgeMs <= maxMs must not fire (the `<=` guard). Two parks so the
    // run-length gate is satisfied; the oldest is exactly at / just past the bound.
    const atBoundary = schedule({
      executionLedger: [
        entry('skipped_provider_paused', NOW - DEFAULT_PROVIDER_PARK_ALARM_MS),
        entry('skipped_provider_paused', NOW - DEFAULT_PROVIDER_PARK_ALARM_MS + MIN),
      ],
    });
    expect(evaluateScheduleProviderParks([atBoundary], NOW, DEFAULT_PROVIDER_PARK_ALARM_MS)).toEqual([]);

    const justPast = schedule({
      executionLedger: [
        entry('skipped_provider_paused', NOW - DEFAULT_PROVIDER_PARK_ALARM_MS - 1),
        entry('skipped_provider_paused', NOW - DEFAULT_PROVIDER_PARK_ALARM_MS + MIN),
      ],
    });
    const [info] = evaluateScheduleProviderParks([justPast], NOW, DEFAULT_PROVIDER_PARK_ALARM_MS);
    expect(info.parkAgeMs).toBe(DEFAULT_PROVIDER_PARK_ALARM_MS + 1);
  });

  it('the configured threshold is load-bearing: a 4h park fires under a 3h bound but not a 6h bound', () => {
    const parked = schedule({ executionLedger: parkRun(240, 4 * HOUR) });
    expect(evaluateScheduleProviderParks([parked], NOW, 3 * HOUR)).toHaveLength(1);
    expect(evaluateScheduleProviderParks([parked], NOW, 6 * HOUR)).toEqual([]);
  });

  it('an empty ledger raises nothing', () => {
    expect(
      evaluateScheduleProviderParks([schedule({ executionLedger: [] })], NOW, DEFAULT_PROVIDER_PARK_ALARM_MS),
    ).toEqual([]);
  });

  it('survives an unparseable evaluatedAt: falls through to the oldest parseable park row, never throws', () => {
    // Oldest row has a garbage timestamp; newer rows are valid. The store only
    // checks truthiness of evaluatedAt, so a garbage-but-truthy value can persist.
    const garbageOldest = schedule({
      executionLedger: [
        entry('skipped_provider_paused', NOW - 20 * HOUR, 'sched-1', { evaluatedAt: 'not-a-date' }),
        entry('skipped_provider_paused', NOW - 7 * HOUR),
        entry('skipped_provider_paused', NOW - 1 * MIN),
      ],
    });
    let result: ReturnType<typeof evaluateScheduleProviderParks> = [];
    expect(() => {
      result = evaluateScheduleProviderParks([garbageOldest], NOW, DEFAULT_PROVIDER_PARK_ALARM_MS);
    }).not.toThrow();
    // Age is measured from the oldest PARSEABLE row (7h ago), not the garbage one.
    expect(result).toHaveLength(1);
    expect(result[0].parkAgeMs).toBe(7 * HOUR);

    // A run whose every timestamp is garbage is skipped (no throw, no false-fire).
    const allGarbage = schedule({
      executionLedger: [
        entry('skipped_provider_paused', NOW - 20 * HOUR, 'sched-1', { evaluatedAt: 'nope' }),
        entry('skipped_provider_paused', NOW - 10 * HOUR, 'sched-1', { evaluatedAt: 'also-nope' }),
      ],
    });
    expect(evaluateScheduleProviderParks([allGarbage], NOW, DEFAULT_PROVIDER_PARK_ALARM_MS)).toEqual([]);
  });

  it('measures age from the OLDEST park in the continuous run (park start), not the newest', () => {
    // A schedule that has been parking for 8h; newest park is 1 minute ago.
    const parked = schedule({ executionLedger: parkRun(480, 8 * HOUR) });
    const [info] = evaluateScheduleProviderParks([parked], NOW, DEFAULT_PROVIDER_PARK_ALARM_MS);
    expect(info.parkAgeMs).toBe(8 * HOUR);
  });

  it('a SINGLE park raises no alert even when it is older than the threshold', () => {
    const lonePark = schedule({ executionLedger: [entry('skipped_provider_paused', NOW - 10 * HOUR)] });
    expect(evaluateScheduleProviderParks([lonePark], NOW, DEFAULT_PROVIDER_PARK_ALARM_MS)).toEqual([]);
    expect(PROVIDER_PARK_MIN_RUN).toBe(2);
  });

  it('a park cleared by a later successful fire raises nothing (run broken by the fire)', () => {
    const recovered = schedule({
      executionLedger: [
        ...parkRun(400, 8 * HOUR),
        entry('completed', NOW - 2 * MIN), // a real fire broke the park
      ],
    });
    expect(evaluateScheduleProviderParks([recovered], NOW, DEFAULT_PROVIDER_PARK_ALARM_MS)).toEqual([]);
  });

  it('only the TRAILING run counts: an old park run followed by fires then a fresh short park is not flagged', () => {
    const s = schedule({
      executionLedger: [
        ...parkRun(100, 20 * HOUR), // long-ago park run
        entry('completed', NOW - 9 * HOUR),
        entry('completed', NOW - 3 * HOUR),
        ...parkRun(3, 2 * MIN), // fresh short park (oldest 2m ago)
      ],
    });
    expect(evaluateScheduleProviderParks([s], NOW, DEFAULT_PROVIDER_PARK_ALARM_MS)).toEqual([]);
  });

  it('any non-park outcome in the trailing position breaks the run (no other outcome in between)', () => {
    // A drain row is the newest entry → not currently provider-parked.
    const s = schedule({
      executionLedger: [...parkRun(400, 8 * HOUR), entry('skipped_draining', NOW - 1 * MIN)],
    });
    expect(evaluateScheduleProviderParks([s], NOW, DEFAULT_PROVIDER_PARK_ALARM_MS)).toEqual([]);
  });

  it('a non-park outcome mid-run resets the age to the run that follows it', () => {
    const s = schedule({
      executionLedger: [
        ...parkRun(50, 20 * HOUR), // ancient parks
        entry('dispatch_failed', NOW - 5 * HOUR), // breaks the run
        ...parkRun(180, 3 * HOUR), // trailing run: oldest 3h ago, under 6h
      ],
    });
    expect(evaluateScheduleProviderParks([s], NOW, DEFAULT_PROVIDER_PARK_ALARM_MS)).toEqual([]);

    // Same shape but the trailing run started 7h ago → flagged, age = 7h only.
    const flagged = schedule({
      executionLedger: [
        ...parkRun(50, 30 * HOUR),
        entry('dispatch_failed', NOW - 8 * HOUR),
        ...parkRun(180, 7 * HOUR),
      ],
    });
    const [info] = evaluateScheduleProviderParks([flagged], NOW, DEFAULT_PROVIDER_PARK_ALARM_MS);
    expect(info.parkAgeMs).toBe(7 * HOUR);
    expect(info.runLength).toBe(180);
  });

  it('ignores disabled schedules', () => {
    const disabled = schedule({ enabled: false, executionLedger: parkRun(400, 8 * HOUR) });
    expect(evaluateScheduleProviderParks([disabled], NOW, DEFAULT_PROVIDER_PARK_ALARM_MS)).toEqual([]);
  });

  it('keys per schedule so multiple parked schedules are each returned', () => {
    const a = schedule({ id: 'a', name: 'Alpha', executionLedger: parkRun(400, 8 * HOUR, 'a') });
    const b = schedule({ id: 'b', name: 'Beta', executionLedger: parkRun(400, 8 * HOUR, 'b') });
    const healthy = schedule({ id: 'c', name: 'Gamma', executionLedger: [entry('completed', NOW - 5 * MIN, 'c')] });
    const result = evaluateScheduleProviderParks([a, b, healthy], NOW, DEFAULT_PROVIDER_PARK_ALARM_MS);
    expect(result.map((r) => r.id).sort()).toEqual(['a', 'b']);
  });
});

describe('ScheduleProviderParkAlarm (issue #3034)', () => {
  function makeAlarm(nowMs: () => number, maxMs = DEFAULT_PROVIDER_PARK_ALARM_MS) {
    const broadcast = vi.fn();
    const recordTransition = vi.fn();
    const alarm = new ScheduleProviderParkAlarm({
      broadcast,
      recordTransition,
      getMaxProviderParkMs: () => maxMs,
      now: () => new Date(nowMs()),
    });
    return { broadcast, recordTransition, alarm };
  }

  const parkedLedger = () => ({ executionLedger: parkRun(400, 8 * HOUR) });

  it('raises exactly ONE warning alert per park episode across repeated ticks (no per-tick storm)', () => {
    const { broadcast, alarm } = makeAlarm(() => NOW);
    const parked = schedule(parkedLedger());

    // Simulate many ticks while the schedule stays parked.
    for (let i = 0; i < 10; i += 1) alarm.check([parked]);

    const alerts = alertsOf(broadcast);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      type: 'alert',
      agentId: 'system',
      severity: 'warning',
      operationalAlert: {
        key: 'schedule:provider-park:sched-1',
        metric: 'schedule_provider_park',
        state: 'fired',
      },
    });
    expect(alerts[0].summary).toContain('provider-parked');
  });

  it('does NOT auto-pause / mutate the schedule (the #1894 guarantee holds)', () => {
    const { alarm } = makeAlarm(() => NOW);
    const parked = schedule(parkedLedger());
    const before = structuredClone(parked);
    alarm.check([parked]);
    // Alert-only: the schedule object is untouched (still enabled, ledger intact).
    expect(parked).toEqual(before);
    expect(parked.enabled).toBe(true);
  });

  it('records the transition to the durable sink before broadcasting', () => {
    const { broadcast, recordTransition, alarm } = makeAlarm(() => NOW);
    alarm.check([schedule(parkedLedger())]);
    expect(recordTransition).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(recordTransition.mock.invocationCallOrder[0]).toBeLessThan(
      broadcast.mock.invocationCallOrder[0],
    );
  });

  it('clears the episode with one recovery alert when the schedule fires again', () => {
    const { broadcast, alarm } = makeAlarm(() => NOW);
    alarm.check([schedule(parkedLedger())]);
    expect(alertsOf(broadcast)).toHaveLength(1);

    const recovered = schedule({
      executionLedger: [...parkRun(400, 8 * HOUR), entry('completed', NOW - 1 * MIN)],
    });
    alarm.check([recovered]);
    alarm.check([recovered]);

    const alerts = alertsOf(broadcast);
    expect(alerts).toHaveLength(2);
    expect(alerts[1]).toMatchObject({
      severity: 'info',
      operationalAlert: { key: 'schedule:provider-park:sched-1', state: 'recovered' },
    });
    expect(alerts[1].summary).toContain('Watchdog supervisor');
  });

  it('does not re-storm: after recovery, a new park episode fires exactly one new alert', () => {
    let now = NOW;
    const { broadcast, alarm } = makeAlarm(() => now);

    alarm.check([schedule(parkedLedger())]); // fired
    const recovered = schedule({
      executionLedger: [...parkRun(400, 8 * HOUR), entry('completed', NOW - 1 * MIN)],
    });
    alarm.check([recovered]); // recovered

    // A fresh park episode much later crosses the bound again.
    now = NOW + 20 * HOUR;
    const reParked = schedule({ executionLedger: parkRun(400, 8 * HOUR + 20 * HOUR) });
    alarm.check([reParked]);
    alarm.check([reParked]);

    const states = alertsOf(broadcast).map((a) => a.operationalAlert?.state);
    expect(states).toEqual(['fired', 'recovered', 'fired']);
  });

  it('keys alerts per schedule: two parked schedules each fire once, and one can recover while the other stays parked', () => {
    let now = NOW;
    const { broadcast, alarm } = makeAlarm(() => now);
    const a = schedule({ id: 'a', name: 'Alpha', executionLedger: parkRun(400, 8 * HOUR, 'a') });
    const b = schedule({ id: 'b', name: 'Beta', executionLedger: parkRun(400, 8 * HOUR, 'b') });

    alarm.check([a, b]);
    alarm.check([a, b]); // no re-storm

    const firedKeys = alertsOf(broadcast)
      .filter((al) => al.operationalAlert?.state === 'fired')
      .map((al) => al.operationalAlert?.key);
    expect(firedKeys.sort()).toEqual(['schedule:provider-park:a', 'schedule:provider-park:b']);

    // Alpha recovers (fires a real run); Beta stays parked → only Alpha's key recovers.
    now = NOW + HOUR;
    const aRecovered = schedule({
      id: 'a',
      name: 'Alpha',
      executionLedger: [...parkRun(400, 8 * HOUR, 'a'), entry('completed', now - 1 * MIN, 'a')],
    });
    const bStillParked = schedule({ id: 'b', name: 'Beta', executionLedger: parkRun(460, 9 * HOUR, 'b') });
    alarm.check([aRecovered, bStillParked]);

    const recovered = alertsOf(broadcast).filter((al) => al.operationalAlert?.state === 'recovered');
    expect(recovered.map((al) => al.operationalAlert?.key)).toEqual(['schedule:provider-park:a']);
    expect(alarm.stats()).toEqual({ parkedCount: 1, parkedSchedules: [{ id: 'b', name: 'Beta' }] });
  });

  it('clears the episode when the parked schedule is disabled or removed', () => {
    const { broadcast, alarm } = makeAlarm(() => NOW);
    alarm.check([schedule(parkedLedger())]);
    alarm.check([]); // schedule removed from the store
    const alerts = alertsOf(broadcast);
    expect(alerts).toHaveLength(2);
    expect(alerts[1].operationalAlert).toMatchObject({ state: 'recovered' });
  });

  it('a single park never triggers the alarm even across many ticks', () => {
    const { broadcast, alarm } = makeAlarm(() => NOW);
    const lone = schedule({ executionLedger: [entry('skipped_provider_paused', NOW - 10 * HOUR)] });
    alarm.check([lone]);
    alarm.check([lone]);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('stays silent end-to-end when the schedule is healthy', () => {
    const { broadcast, alarm } = makeAlarm(() => NOW);
    const healthy = schedule({ executionLedger: [entry('completed', NOW - 5 * MIN)] });
    alarm.check([healthy]);
    alarm.check([healthy]);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('disabling mid-episode (threshold 0) closes the open episode with a recovery so the trace never dangles', () => {
    const broadcast = vi.fn();
    let maxMs = DEFAULT_PROVIDER_PARK_ALARM_MS;
    const alarm = new ScheduleProviderParkAlarm({
      broadcast,
      getMaxProviderParkMs: () => maxMs,
      now: () => new Date(NOW),
    });

    alarm.check([schedule(parkedLedger())]);
    expect(broadcast).toHaveBeenCalledTimes(1); // fired while enabled

    maxMs = 0; // operator disables the alarm mid-episode
    alarm.check([schedule(parkedLedger())]);
    const alerts = alertsOf(broadcast);
    expect(alerts).toHaveLength(2);
    expect(alerts[1].operationalAlert).toMatchObject({ key: 'schedule:provider-park:sched-1', state: 'recovered' });

    // Stays quiet thereafter — no re-fire, no duplicate recovery.
    alarm.check([schedule(parkedLedger())]);
    expect(broadcast).toHaveBeenCalledTimes(2);
  });

  it('exposes currently parked schedules via stats() for a status/health surface', () => {
    const { alarm } = makeAlarm(() => NOW);
    expect(alarm.stats()).toEqual({ parkedCount: 0, parkedSchedules: [] });

    const a = schedule({ id: 'a', name: 'Alpha', executionLedger: parkRun(400, 8 * HOUR, 'a') });
    alarm.check([a]);
    expect(alarm.stats()).toEqual({ parkedCount: 1, parkedSchedules: [{ id: 'a', name: 'Alpha' }] });

    const recovered = schedule({
      id: 'a',
      name: 'Alpha',
      executionLedger: [...parkRun(400, 8 * HOUR, 'a'), entry('completed', NOW - 1 * MIN, 'a')],
    });
    alarm.check([recovered]);
    expect(alarm.stats()).toEqual({ parkedCount: 0, parkedSchedules: [] });
  });
});
