import { describe, expect, it, vi } from 'vitest';
import type { Schedule, ScheduleExecutionLedgerEntry, ScheduleExecutionOutcome } from '../core/schedule.js';
import type { ServerMessage } from '../shared/contracts/messages.js';
import {
  DEAD_MAN_CONSECUTIVE_FAILURES,
  DEAD_MAN_SELF_HEAL_MAX_ATTEMPTS,
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

describe('ScheduleDeadManSwitch bounded self-heal (issue #1903)', () => {
  const FAILURE_TAIL = () => [
    entry('dispatch_failed', NOW - 3 * 3_600_000),
    entry('dispatch_failed', NOW - 2 * 3_600_000),
    entry('dispatch_failed', NOW - 1 * 3_600_000),
  ];

  function makeSwitch(opts: { cap?: number; withSelfHeal?: boolean } = {}) {
    const broadcast = vi.fn();
    const selfHeal = vi.fn();
    const deadMan = new ScheduleDeadManSwitch({
      broadcast,
      getDeadManMs: () => DEFAULT_DEAD_MAN_SCHEDULE_MS,
      now: () => new Date(NOW),
      ...(opts.withSelfHeal === false ? {} : { selfHeal }),
      ...(opts.cap !== undefined ? { getSelfHealMaxAttempts: () => opts.cap! } : {}),
    });
    return { broadcast, selfHeal, deadMan };
  }

  it('re-fires the starving schedule on the edge and every still-starving tick up to the cap', () => {
    const { selfHeal, deadMan } = makeSwitch({ cap: 3 });
    const starving = schedule({ executionLedger: FAILURE_TAIL() });

    // 5 still-starving ticks, but the cap is 3.
    for (let i = 0; i < 5; i += 1) deadMan.check([starving]);

    expect(selfHeal).toHaveBeenCalledTimes(3);
    // The self-heal targets the starving schedule's id (condition (a)).
    expect(selfHeal).toHaveBeenNthCalledWith(1, ['sched-1']);
    expect(deadMan.stats()).toMatchObject({ attempts: 3, successes: 0, escalated: true, episodeAttempts: 3 });
  });

  it('self-heals EVERY consecutive-failure schedule, not just the first (issue #1903)', () => {
    // Regression: condition (a) used to `return` on the first starving schedule,
    // so with several schedules in the consecutive-failure state only the first
    // was ever re-fired and the episode cap was spent on it while the others
    // stayed starved. The verdict must now carry every starving schedule's id.
    const { selfHeal, deadMan } = makeSwitch({ cap: 3 });
    const starvingA = schedule({ id: 'sched-a', name: 'A', executionLedger: FAILURE_TAIL() });
    const starvingB = schedule({ id: 'sched-b', name: 'B', executionLedger: FAILURE_TAIL() });

    deadMan.check([starvingA, starvingB]);

    expect(selfHeal).toHaveBeenCalledTimes(1);
    expect(selfHeal).toHaveBeenNthCalledWith(1, ['sched-a', 'sched-b']);
  });

  it('escalates immediately with no re-fire when the cap is 0 (documented edge)', () => {
    const { broadcast, selfHeal, deadMan } = makeSwitch({ cap: 0 });
    const starving = schedule({ executionLedger: FAILURE_TAIL() });

    deadMan.check([starving]); // edge: warning, but 0 < cap is false → no re-fire
    deadMan.check([starving]); // episodeAttempts(0) >= cap(0) → escalate

    expect(selfHeal).not.toHaveBeenCalled();
    const alerts = alertsOf(broadcast);
    expect(alerts).toHaveLength(2);
    expect(alerts[0]).toMatchObject({ severity: 'warning', operationalAlert: { state: 'fired' } });
    expect(alerts[1]).toMatchObject({ severity: 'critical', operationalAlert: { state: 'fired' } });
    expect(deadMan.stats()).toMatchObject({ attempts: 0, escalated: true });
  });

  it('heal-within-cap: recovery before the cap counts a self-heal success and clears counters', () => {
    const { broadcast, selfHeal, deadMan } = makeSwitch({ cap: 3 });

    // Edge tick: fired alert + first kick.
    deadMan.check([schedule({ executionLedger: FAILURE_TAIL() })]);
    expect(selfHeal).toHaveBeenCalledTimes(1);
    expect(deadMan.stats()).toMatchObject({ episodeAttempts: 1, firing: true, escalated: false });

    // The kick worked: the next tick sees a completed execution → recovery.
    const recovered = schedule({
      executionLedger: [...FAILURE_TAIL(), entry('completed', NOW - 10 * 60_000)],
    });
    deadMan.check([recovered]);

    const alerts = alertsOf(broadcast);
    expect(alerts).toHaveLength(2);
    expect(alerts[0]).toMatchObject({ severity: 'warning', operationalAlert: { state: 'fired' } });
    expect(alerts[1]).toMatchObject({ severity: 'info', operationalAlert: { state: 'recovered' } });
    expect(alerts[1].details).toContain('self-heal attempt');
    // One kick was made, it healed within the cap, counters reset for the episode.
    expect(deadMan.stats()).toMatchObject({
      attempts: 1,
      successes: 1,
      episodeAttempts: 0,
      escalated: false,
      firing: false,
    });
  });

  it('escalate-at-cap: exhausting the cap emits one standing error alert and stops kicking (no infinite loop)', () => {
    const { broadcast, selfHeal, deadMan } = makeSwitch({ cap: 2 });
    const starving = schedule({ executionLedger: FAILURE_TAIL() });

    deadMan.check([starving]); // edge: fired + kick #1
    deadMan.check([starving]); // kick #2 (== cap)
    deadMan.check([starving]); // cap exhausted → escalate (no kick)
    deadMan.check([starving]); // already escalated → nothing
    deadMan.check([starving]); // still nothing — bounded

    expect(selfHeal).toHaveBeenCalledTimes(2); // hard cap honoured

    const alerts = alertsOf(broadcast);
    // Exactly two alerts: the initial warning and the single escalation.
    expect(alerts).toHaveLength(2);
    expect(alerts[0]).toMatchObject({ severity: 'warning', operationalAlert: { state: 'fired' } });
    expect(alerts[1]).toMatchObject({
      severity: 'critical',
      operationalAlert: { key: 'schedule:dead_man', metric: 'schedule_starvation', state: 'fired' },
    });
    expect(alerts[1].summary).toContain('manual intervention required');
    expect(alerts[1].details).toContain('unbounded');
    expect(deadMan.stats()).toMatchObject({ attempts: 2, successes: 0, escalated: true });
  });

  it('the escalation reaches the durable sink as a standing critical fired transition', () => {
    const broadcast = vi.fn();
    const recordTransition = vi.fn();
    const deadMan = new ScheduleDeadManSwitch({
      broadcast,
      recordTransition,
      selfHeal: vi.fn(),
      getSelfHealMaxAttempts: () => 1,
      getDeadManMs: () => DEFAULT_DEAD_MAN_SCHEDULE_MS,
      now: () => new Date(NOW),
    });
    const starving = schedule({ executionLedger: FAILURE_TAIL() });

    deadMan.check([starving]); // edge: warning fired + re-fire #1 (== cap)
    deadMan.check([starving]); // escalate

    // Both the warning and the escalation are recorded durably (not just the WS
    // broadcast) — AC2 requires a standing DURABLE alert.
    expect(recordTransition).toHaveBeenCalledTimes(2);
    const escalation = recordTransition.mock.calls[1]![0];
    expect(escalation).toBe(broadcast.mock.calls[1]![0]); // same object as broadcast
    expect(escalation).toMatchObject({
      severity: 'critical',
      operationalAlert: { key: 'schedule:dead_man', state: 'fired' },
    });
  });

  it('recovery after escalation is NOT attributed to self-heal (operator fixed it)', () => {
    const { broadcast, deadMan } = makeSwitch({ cap: 1 });
    const starving = schedule({ executionLedger: FAILURE_TAIL() });

    deadMan.check([starving]); // edge + re-fire #1 (== cap)
    deadMan.check([starving]); // escalate
    expect(deadMan.stats()).toMatchObject({ escalated: true, successes: 0 });

    deadMan.check([schedule({ executionLedger: [...FAILURE_TAIL(), entry('completed', NOW - 5 * 60_000)] })]);
    // Recovered, but the success counter is unchanged: it escalated first.
    expect(deadMan.stats()).toMatchObject({ successes: 0, escalated: false, firing: false });
    // And the recovery-alert copy must agree — no "recovered after N self-heal
    // attempt(s)" note, since self-heal did NOT heal this episode.
    const recovery = alertsOf(broadcast).find((a) => a.operationalAlert?.state === 'recovered');
    expect(recovery?.details).not.toContain('self-heal attempt');
  });

  it('a NEW episode after a healed one kicks again and accumulates counters', () => {
    const { selfHeal, deadMan } = makeSwitch({ cap: 3 });

    // Episode 1 heals within cap.
    deadMan.check([schedule({ executionLedger: FAILURE_TAIL() })]); // kick #1
    deadMan.check([schedule({ executionLedger: [...FAILURE_TAIL(), entry('completed', NOW - 10 * 60_000)] })]);
    expect(deadMan.stats()).toMatchObject({ attempts: 1, successes: 1, firing: false });

    // Episode 2 starts fresh.
    const starvedAgain = schedule({
      executionLedger: [
        ...FAILURE_TAIL(),
        entry('completed', NOW - 10 * 60_000),
        entry('dispatch_failed', NOW - 9 * 60_000),
        entry('dispatch_failed', NOW - 8 * 60_000),
        entry('dispatch_failed', NOW - 7 * 60_000),
      ],
    });
    deadMan.check([starvedAgain]); // kick #2 (episodeAttempts resets to 1)
    expect(selfHeal).toHaveBeenCalledTimes(2);
    expect(deadMan.stats()).toMatchObject({ attempts: 2, successes: 1, episodeAttempts: 1, firing: true });
  });

  it('is alert-only with no escalation when no self-heal action is wired (back-compat)', () => {
    const { broadcast, deadMan } = makeSwitch({ withSelfHeal: false });
    const starving = schedule({ executionLedger: FAILURE_TAIL() });

    for (let i = 0; i < 5; i += 1) deadMan.check([starving]);

    const alerts = alertsOf(broadcast);
    expect(alerts).toHaveLength(1); // just the warning, never an escalation
    expect(alerts[0].severity).toBe('warning');
    expect(deadMan.stats()).toMatchObject({ attempts: 0, successes: 0, escalated: false });
  });

  it('cap defaults to DEAD_MAN_SELF_HEAL_MAX_ATTEMPTS when no getter is supplied', () => {
    const { selfHeal, deadMan } = makeSwitch({}); // no cap getter
    const starving = schedule({ executionLedger: FAILURE_TAIL() });

    for (let i = 0; i < DEAD_MAN_SELF_HEAL_MAX_ATTEMPTS + 3; i += 1) deadMan.check([starving]);

    expect(selfHeal).toHaveBeenCalledTimes(DEAD_MAN_SELF_HEAL_MAX_ATTEMPTS);
    expect(deadMan.stats().escalated).toBe(true);
  });

  it('a selfHeal that throws is swallowed and does not abort the switch', () => {
    const broadcast = vi.fn();
    const selfHeal = vi.fn(() => {
      throw new Error('kick boom');
    });
    const deadMan = new ScheduleDeadManSwitch({
      broadcast,
      selfHeal,
      getSelfHealMaxAttempts: () => 2,
      getDeadManMs: () => DEFAULT_DEAD_MAN_SCHEDULE_MS,
      now: () => new Date(NOW),
    });
    const starving = schedule({ executionLedger: FAILURE_TAIL() });

    expect(() => {
      deadMan.check([starving]);
      deadMan.check([starving]);
      deadMan.check([starving]);
    }).not.toThrow();
    expect(selfHeal).toHaveBeenCalledTimes(2);
    expect(deadMan.stats().escalated).toBe(true); // still escalates despite throwing kicks
  });
});
