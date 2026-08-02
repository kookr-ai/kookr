import { describe, expect, it, vi } from 'vitest';
import type { Schedule, ScheduleExecutionLedgerEntry, ScheduleExecutionOutcome } from '../core/schedule.js';
import type { ServerMessage } from '../shared/contracts/messages.js';
import {
  DEAD_MAN_CONSECUTIVE_FAILURES,
  DEFAULT_DEAD_MAN_SCHEDULE_MS,
  ScheduleDeadManSwitch,
  evaluateScheduleStarvation,
} from './schedule-dead-man.js';

const NOW = Date.parse('2026-07-25T12:00:00.000Z');

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
    name: 'Hourly watchdog',
    enabled: true,
    cron: '0 * * * *',
    playbook: { path: 'daily.md', parameters: {} },
    cwd: '/tmp',
    agentType: 'claude-code',
    executionLedger: [],
    createdAt: new Date(NOW - 86_400_000).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    ...overrides,
  } as Schedule;
}

function alertsOf(broadcast: ReturnType<typeof vi.fn>): Array<Extract<ServerMessage, { type: 'alert' }>> {
  return broadcast.mock.calls.map(([msg]) => msg as Extract<ServerMessage, { type: 'alert' }>);
}

describe('evaluateScheduleStarvation', () => {
  it('condition (a): last 3 consecutive capacity/dispatch failures on one enabled schedule', () => {
    const sched = schedule({
      executionLedger: [
        entry('completed', NOW - 4 * 3_600_000),
        entry('dispatch_failed', NOW - 3 * 3_600_000),
        entry('queued_capacity', NOW - 2 * 3_600_000),
        entry('skipped_coalesced', NOW - 1 * 3_600_000),
      ],
    });
    const verdict = evaluateScheduleStarvation([sched], NOW, DEFAULT_DEAD_MAN_SCHEDULE_MS);
    expect(verdict.starving).toBe(true);
    expect(verdict.reason).toContain('Hourly watchdog');
    expect(verdict.reason).toContain(`last ${DEAD_MAN_CONSECUTIVE_FAILURES}`);
  });

  it('condition (a) does not fire when a healthy outcome interrupts the tail', () => {
    const sched = schedule({
      executionLedger: [
        entry('dispatch_failed', NOW - 3 * 3_600_000),
        entry('completed', NOW - 2 * 3_600_000),
        entry('dispatch_failed', NOW - 1 * 3_600_000),
      ],
    });
    // Condition (b) is also clear: a completed execution sits in the window.
    expect(evaluateScheduleStarvation([sched], NOW, DEFAULT_DEAD_MAN_SCHEDULE_MS).starving).toBe(false);
  });

  it('condition (a) ignores disabled schedules and short ledgers', () => {
    const disabled = schedule({
      enabled: false,
      executionLedger: [
        entry('dispatch_failed', NOW - 3 * 3_600_000),
        entry('dispatch_failed', NOW - 2 * 3_600_000),
        entry('dispatch_failed', NOW - 1 * 3_600_000),
      ],
    });
    const short = schedule({
      id: 'sched-2',
      name: 'Short history',
      executionLedger: [
        // Outside the (b) window on purpose so only (a) is in play.
        entry('dispatch_failed', NOW - 26 * 3_600_000, 'sched-2'),
        entry('dispatch_failed', NOW - 25 * 3_600_000, 'sched-2'),
      ],
    });
    expect(evaluateScheduleStarvation([disabled, short], NOW, DEFAULT_DEAD_MAN_SCHEDULE_MS).starving).toBe(false);
  });

  it('condition (b): fires were due in the window and none was dispatched or completed', () => {
    const sched = schedule({
      executionLedger: [
        entry('completed', NOW - 5 * 3_600_000), // outside 2h window
        entry('skipped_active', NOW - 90 * 60_000),
        entry('skipped_active', NOW - 30 * 60_000),
      ],
    });
    const verdict = evaluateScheduleStarvation([sched], NOW, DEFAULT_DEAD_MAN_SCHEDULE_MS);
    expect(verdict.starving).toBe(true);
    expect(verdict.reason).toContain('none was dispatched or completed');
  });

  it('condition (b) treats a dispatched (running) execution in the window as healthy — slow tasks are not starvation', () => {
    const sched = schedule({
      executionLedger: [
        entry('skipped_active', NOW - 90 * 60_000),
        entry('running', NOW - 30 * 60_000),
      ],
    });
    expect(evaluateScheduleStarvation([sched], NOW, DEFAULT_DEAD_MAN_SCHEDULE_MS).starving).toBe(false);
  });

  it('condition (b) is silent when no fire was due in the window', () => {
    const sched = schedule({
      executionLedger: [entry('completed', NOW - 5 * 3_600_000)],
    });
    expect(evaluateScheduleStarvation([sched], NOW, DEFAULT_DEAD_MAN_SCHEDULE_MS).starving).toBe(false);
  });

  it('skipped_draining is operator intent and never counts as a due fire or a failure', () => {
    const sched = schedule({
      executionLedger: [
        entry('dispatch_failed', NOW - 4 * 3_600_000),
        entry('dispatch_failed', NOW - 3 * 3_600_000),
        entry('skipped_draining', NOW - 90 * 60_000),
        entry('skipped_draining', NOW - 30 * 60_000),
      ],
    });
    // (a): the non-draining tail is only 2 failures; (b): only draining
    // entries sit in the window.
    expect(evaluateScheduleStarvation([sched], NOW, DEFAULT_DEAD_MAN_SCHEDULE_MS).starving).toBe(false);
  });

  it('skipped_relaunch_locked is a lease-gated catch-up and never counts as a due fire or a failure (#1900)', () => {
    const sched = schedule({
      executionLedger: [
        entry('dispatch_failed', NOW - 4 * 3_600_000),
        entry('dispatch_failed', NOW - 3 * 3_600_000),
        entry('skipped_relaunch_locked', NOW - 90 * 60_000),
        entry('skipped_relaunch_locked', NOW - 30 * 60_000),
      ],
    });
    // Another actuator holds the relaunch lease → work is being relaunched, not
    // starving. (a): the tail is only 2 real failures; (b): only lease-locked
    // entries sit in the window, so no false starvation alert.
    expect(evaluateScheduleStarvation([sched], NOW, DEFAULT_DEAD_MAN_SCHEDULE_MS).starving).toBe(false);
  });
});

describe('ScheduleDeadManSwitch (issue #1526 Phase C)', () => {
  function makeSwitch(nowMs: () => number) {
    const broadcast = vi.fn();
    const deadMan = new ScheduleDeadManSwitch({
      broadcast,
      getDeadManMs: () => DEFAULT_DEAD_MAN_SCHEDULE_MS,
      now: () => new Date(nowMs()),
    });
    return { broadcast, deadMan };
  }

  it('raises exactly ONE warning alert per starvation episode across repeated ticks', () => {
    const { broadcast, deadMan } = makeSwitch(() => NOW);
    const starving = schedule({
      executionLedger: [
        entry('dispatch_failed', NOW - 3 * 3_600_000),
        entry('dispatch_failed', NOW - 2 * 3_600_000),
        entry('dispatch_failed', NOW - 1 * 3_600_000),
      ],
    });

    deadMan.check([starving]);
    deadMan.check([starving]);
    deadMan.check([starving]);

    const alerts = alertsOf(broadcast);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      type: 'alert',
      agentId: 'system',
      severity: 'warning',
      operationalAlert: {
        key: 'schedule:dead_man',
        metric: 'schedule_starvation',
        state: 'fired',
      },
    });
    expect(alerts[0].summary).toContain('starving');
  });

  it('a completed execution clears the episode (one recovery alert), and a NEW episode can fire again', () => {
    const { broadcast, deadMan } = makeSwitch(() => NOW);
    const failures = [
      entry('dispatch_failed', NOW - 3 * 3_600_000),
      entry('dispatch_failed', NOW - 2 * 3_600_000),
      entry('dispatch_failed', NOW - 1 * 3_600_000),
    ];
    deadMan.check([schedule({ executionLedger: failures })]);
    expect(alertsOf(broadcast)).toHaveLength(1);

    // A scheduled execution completes → ledger gains a healthy tail entry.
    const recovered = schedule({
      executionLedger: [...failures, entry('completed', NOW - 10 * 60_000)],
    });
    deadMan.check([recovered]);
    deadMan.check([recovered]);

    let alerts = alertsOf(broadcast);
    expect(alerts).toHaveLength(2);
    expect(alerts[1]).toMatchObject({
      severity: 'info',
      operationalAlert: { key: 'schedule:dead_man', state: 'recovered' },
    });

    // Fresh starvation later → a NEW episode fires once more.
    const starvedAgain = schedule({
      executionLedger: [
        ...failures,
        entry('completed', NOW - 10 * 60_000),
        entry('dispatch_failed', NOW - 9 * 60_000),
        entry('dispatch_failed', NOW - 8 * 60_000),
        entry('dispatch_failed', NOW - 7 * 60_000),
      ],
    });
    deadMan.check([starvedAgain]);
    alerts = alertsOf(broadcast);
    expect(alerts).toHaveLength(3);
    expect(alerts[2].operationalAlert).toMatchObject({ state: 'fired' });
  });

  it('stays silent end-to-end when schedules are healthy (no spurious recovery alert either)', () => {
    const { broadcast, deadMan } = makeSwitch(() => NOW);
    const healthy = schedule({
      executionLedger: [entry('completed', NOW - 30 * 60_000)],
    });
    deadMan.check([healthy]);
    deadMan.check([healthy]);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('records each fire/clear transition to the durable sink with the same alert it broadcasts (issue #1709)', () => {
    const broadcast = vi.fn();
    const recordTransition = vi.fn();
    const deadMan = new ScheduleDeadManSwitch({
      broadcast,
      recordTransition,
      getDeadManMs: () => DEFAULT_DEAD_MAN_SCHEDULE_MS,
      now: () => new Date(NOW),
    });
    const failures = [
      entry('dispatch_failed', NOW - 3 * 3_600_000),
      entry('dispatch_failed', NOW - 2 * 3_600_000),
      entry('dispatch_failed', NOW - 1 * 3_600_000),
    ];

    // Fire edge.
    deadMan.check([schedule({ executionLedger: failures })]);
    // Clear edge.
    deadMan.check([schedule({ executionLedger: [...failures, entry('completed', NOW - 10 * 60_000)] })]);

    expect(recordTransition).toHaveBeenCalledTimes(2);
    // The sink receives exactly the broadcast alert objects.
    expect(recordTransition.mock.calls[0]![0]).toBe(broadcast.mock.calls[0]![0]);
    expect(recordTransition.mock.calls[1]![0]).toBe(broadcast.mock.calls[1]![0]);
    expect(recordTransition.mock.calls[0]![0].operationalAlert).toMatchObject({
      key: 'schedule:dead_man',
      state: 'fired',
    });
    expect(recordTransition.mock.calls[1]![0].operationalAlert).toMatchObject({
      key: 'schedule:dead_man',
      state: 'recovered',
    });
  });
});
