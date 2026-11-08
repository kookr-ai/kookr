import { describe, expect, it } from 'vitest';
import {
  DEFAULT_POLICY_CONFIG,
  MINUTE_MS,
  decide,
  nextWake,
  type PolicyConfig,
  type SupervisorView,
} from './supervision-policy.js';
import type { SupervisionState } from './supervision-files.js';

const T0 = Date.parse('2026-11-08T10:00:00.000Z');
const at = (min: number): Date => new Date(T0 + min * MINUTE_MS);
const iso = (min: number): string => at(min).toISOString();

function state(over: Partial<SupervisionState> = {}): SupervisionState {
  return {
    supervisionId: 'sup-1',
    targets: [{ taskId: 'w1', name: 'worker' }],
    goals: [],
    deadlineAt: iso(240),
    createdAt: iso(0),
    supervisorTaskId: 'sv1',
    ...over,
  };
}

const idle: SupervisorView = { taskTerminal: false, hasLiveSession: true, deliverable: true, allTargetsTerminal: false };
const busy: SupervisorView = { ...idle, deliverable: false };
const gone: SupervisorView = { ...idle, hasLiveSession: false, deliverable: false, exit: 'crashed' };
const terminal: SupervisorView = { ...gone, taskTerminal: true };
const finishedExit: SupervisorView = { ...idle, deliverable: false, taskTerminal: true, hasLiveSession: false, exit: 'finished' };
const operatorExit: SupervisorView = { ...finishedExit, exit: 'operator' };
const cfg = (over: Partial<PolicyConfig> = {}): PolicyConfig => ({ ...DEFAULT_POLICY_CONFIG, ...over });

describe('decide: heartbeat', () => {
  it('does nothing before the first heartbeat (derived from createdAt + 45 min)', () => {
    expect(decide(state(), idle, at(44), cfg())).toEqual([]);
  });

  it('delivers the heartbeat once due and the supervisor is idle', () => {
    expect(decide(state(), idle, at(45), cfg())).toEqual([{ type: 'deliverHeartbeat' }]);
  });

  it('honours an explicit nextHeartbeatAt and a configured interval', () => {
    const s = state({ nextHeartbeatAt: iso(100) });
    expect(decide(s, idle, at(99), cfg())).toEqual([]);
    expect(decide(s, idle, at(100), cfg())).toEqual([{ type: 'deliverHeartbeat' }]);
    expect(decide(state(), idle, at(10), cfg({ heartbeatMs: 10 * MINUTE_MS }))).toEqual([{ type: 'deliverHeartbeat' }]);
  });
});

describe('decide: deadline', () => {
  it('delivers the deadline wake once at deadlineAt', () => {
    expect(decide(state({ deadlineAt: iso(60) }), idle, at(60), cfg())).toEqual([{ type: 'deliverDeadline' }]);
  });

  it('ends the mandate on the next tick once the deadline wake was delivered (never a second wake)', () => {
    const s = state({ deadlineAt: iso(60), deadlineWakeDeliveredAt: iso(60) });
    expect(decide(s, idle, at(61), cfg())).toEqual([{ type: 'markEnded', reason: 'deadline' }]);
  });

  it('prefers the deadline wake over a due heartbeat', () => {
    expect(decide(state({ deadlineAt: iso(50) }), idle, at(50), cfg())).toEqual([{ type: 'deliverDeadline' }]);
  });

  it('ends without a wake when the supervisor is gone at the deadline', () => {
    expect(decide(state({ deadlineAt: iso(60) }), terminal, at(61), cfg())).toEqual([{ type: 'markEnded', reason: 'deadline' }]);
  });
});

describe('decide: all targets terminal', () => {
  const finished: SupervisorView = { ...idle, allTargetsTerminal: true };

  it('delivers the final wake once, then ends', () => {
    expect(decide(state(), finished, at(5), cfg())).toEqual([{ type: 'deliverFinal' }]);
    const s = state({ finalWakeDeliveredAt: iso(5) });
    expect(decide(s, finished, at(6), cfg())).toEqual([{ type: 'markEnded', reason: 'targets-terminal' }]);
  });

  it('ends without a wake when the supervisor is gone too', () => {
    expect(decide(state(), { ...terminal, allTargetsTerminal: true }, at(5), cfg())).toEqual([
      { type: 'markEnded', reason: 'targets-terminal' },
    ]);
  });
});

describe('decide: undeliverable / busy supervisor', () => {
  it('counts a due-but-not-deliverable tick without degrading yet', () => {
    const first = decide(state({ health: 'healthy' }), busy, at(45), cfg());
    expect(first).toEqual([{ type: 'markHealth', health: 'healthy', undeliverableTicks: 1, undeliverableSince: iso(45) }]);
  });

  it('degrades on the 3rd consecutive undeliverable tick but NEVER restarts a live supervisor', () => {
    const s = state({ undeliverableTicks: 2, undeliverableSince: iso(45), nextHeartbeatAt: iso(45) });
    expect(decide(s, busy, at(47), cfg())).toEqual([
      { type: 'markHealth', health: 'degraded:undeliverable', undeliverableTicks: 3, undeliverableSince: iso(45) },
    ]);
  });

  it('keeps retrying a busy supervisor every tick no matter how long (still no restart, no alert)', () => {
    let s = state({ nextHeartbeatAt: iso(45) });
    for (let m = 45; m < 70; m += 1) {
      const actions = decide(s, { ...busy, lastActivityAt: iso(m - 1) }, at(m), cfg());
      expect(actions.some((a) => a.type === 'restartEpisode' || a.type === 'alertOperator' || a.type === 'markEnded')).toBe(false);
      const mark = actions.find((a) => a.type === 'markHealth');
      if (mark?.type === 'markHealth') s = { ...s, health: mark.health, undeliverableTicks: mark.undeliverableTicks, undeliverableSince: mark.undeliverableSince };
    }
    expect(s.health).toBe('degraded:undeliverable');
  });

  it('heartbeat + 15 min of silence degrades on tick 1, still without a restart', () => {
    const s = state({ lastDeliveredAt: iso(0), nextHeartbeatAt: iso(45) });
    const actions = decide(s, busy, at(61), cfg());
    expect(actions.map((a) => a.type)).toEqual(['markHealth']);
    expect(actions[0]).toMatchObject({ health: 'degraded:undeliverable' });
  });

  it('does not degrade at heartbeat + 15 min exactly', () => {
    const s = state({ lastDeliveredAt: iso(0) });
    expect(decide(s, busy, at(60), cfg()).some((a) => a.type === 'markHealth' && a.health === 'degraded:undeliverable')).toBe(false);
  });

  it('busy with no new hook events for > 30 min: degraded:possibly-hung with one alert, no restart', () => {
    const s = state({ nextHeartbeatAt: iso(45) });
    const view = { ...busy, lastActivityAt: iso(10) };
    expect(decide(s, view, at(41), cfg())).toEqual([]); // no wake due yet: not judged
    expect(decide(s, view, at(45), cfg())).toEqual([
      { type: 'markHealth', health: 'degraded:possibly-hung', undeliverableTicks: 1, undeliverableSince: iso(45) },
      { type: 'alertOperator', reason: 'supervisor-possibly-hung' },
    ]);
    const again = state({ nextHeartbeatAt: iso(45), health: 'degraded:possibly-hung', lastAlertReason: 'supervisor-possibly-hung', undeliverableTicks: 1, undeliverableSince: iso(45) });
    expect(decide(again, view, at(46), cfg()).map((a) => a.type)).toEqual(['markHealth']);
  });

  it('a recent hook event means not hung', () => {
    const s = state({ nextHeartbeatAt: iso(45) });
    const actions = decide(s, { ...busy, lastActivityAt: iso(44) }, at(45), cfg());
    expect(actions.some((a) => a.type === 'alertOperator')).toBe(false);
  });

  it('a deliverable supervisor gets the wake', () => {
    const s = state({ undeliverableTicks: 2, health: 'healthy', nextHeartbeatAt: iso(45) });
    expect(decide(s, idle, at(46), cfg())).toEqual([{ type: 'deliverHeartbeat' }]);
  });

  it('a closing (deadline) wake keeps retrying while the supervisor is busy, and ends only when it looks hung', () => {
    const s = state({ deadlineAt: iso(60), undeliverableTicks: 5, undeliverableSince: iso(55) });
    expect(decide(s, { ...busy, lastActivityAt: iso(59) }, at(60), cfg()).some((a) => a.type === 'markEnded')).toBe(false);
    expect(decide(s, { ...busy, lastActivityAt: iso(20) }, at(60), cfg()).map((a) => a.type)).toEqual(['markHealth', 'alertOperator', 'markEnded']);
  });
});

describe('decide: recovering supervisor and deadline-attempted marker', () => {
  it('a recovering supervisor is never restarted, alerted about or ended: re-check next tick', () => {
    const recovering: SupervisorView = { ...gone, recovering: true };
    expect(decide(state(), recovering, at(10), cfg())).toEqual([]);
    expect(decide(state(), recovering, at(10), cfg({ actuationAllowed: false }))).toEqual([]);
  });

  it('deadlineWakeAttemptedAt alone prevents a second deadline wake and ends the mandate', () => {
    const s = state({ deadlineAt: iso(60), deadlineWakeAttemptedAt: iso(60) });
    expect(decide(s, idle, at(61), cfg())).toEqual([{ type: 'markEnded', reason: 'deadline' }]);
  });
});

describe('decide: intentional endings are never revived', () => {
  it('a supervisor that finished (completed / completion-ready) ends the mandate: no restart, no alert', () => {
    expect(decide(state(), finishedExit, at(10), cfg())).toEqual([{ type: 'markEnded', reason: 'supervisor-finished' }]);
    // a still-live supervisor that signalled completion-ready
    expect(decide(state(), { ...idle, exit: 'finished' }, at(10), cfg())).toEqual([{ type: 'markEnded', reason: 'supervisor-finished' }]);
  });

  it('an operator cancel / terminate ends the mandate as operator', () => {
    expect(decide(state(), operatorExit, at(10), cfg())).toEqual([{ type: 'markEnded', reason: 'operator' }]);
  });

  it('intentional endings are recorded even while wakes are gated', () => {
    const off = cfg({ actuationAllowed: false });
    expect(decide(state(), finishedExit, at(10), off)).toEqual([{ type: 'markEnded', reason: 'supervisor-finished' }]);
    expect(decide(state(), operatorExit, at(10), off)).toEqual([{ type: 'markEnded', reason: 'operator' }]);
  });
});

describe('decide: dead supervisor', () => {
  it('restarts when the supervisor task is terminal', () => {
    expect(decide(state(), terminal, at(10), cfg())).toEqual([
      { type: 'markHealth', health: 'dead', undeliverableTicks: 0 },
      { type: 'restartEpisode', cause: 'dead' },
    ]);
  });

  it('restarts when the session is gone while the task is still open', () => {
    expect(decide(state({ health: 'dead' }), gone, at(10), cfg())).toEqual([{ type: 'restartEpisode', cause: 'dead' }]);
  });

  it('never decides a supervision with no supervisor task id (the service adopts or ends it)', () => {
    expect(decide(state({ supervisorTaskId: null }), gone, at(4), cfg())).toEqual([]);
    expect(decide(state({ supervisorTaskId: null }), gone, at(60), cfg())).toEqual([]);
  });

  it('respects the restart cap: alerts once, never restarts', () => {
    const s = state({ restartCount: 3, lastRestartAt: iso(-200), health: 'dead' });
    expect(decide(s, terminal, at(10), cfg())).toEqual([{ type: 'alertOperator', reason: 'restart-limit-reached' }]);
    expect(decide({ ...s, lastAlertReason: 'restart-limit-reached' }, terminal, at(11), cfg())).toEqual([]);
  });

  it('respects restart spacing quietly: waits, no restart and no alert', () => {
    const s = state({ restartCount: 1, lastRestartAt: iso(0), health: 'dead' });
    expect(decide(s, terminal, at(29), cfg())).toEqual([]);
  });

  it('restarts again once 30 min have passed since the last restart', () => {
    const s = state({ restartCount: 1, lastRestartAt: iso(0), health: 'dead' });
    expect(decide(s, terminal, at(30), cfg())).toEqual([{ type: 'restartEpisode', cause: 'dead' }]);
  });

  it('a restarted supervisor that is alive again is healthy', () => {
    expect(decide(state({ health: 'dead' }), idle, at(10), cfg())).toEqual([
      { type: 'markHealth', health: 'healthy', undeliverableTicks: 0 },
    ]);
  });
});

describe('decide: ended supervisions are untouched', () => {
  it('returns nothing whatever the inputs', () => {
    const ended = state({ endedAt: iso(30), endedReason: 'deadline', health: 'ended' });
    for (const view of [idle, busy, gone, terminal, { ...idle, allTargetsTerminal: true }]) {
      expect(decide(ended, view, at(500), cfg())).toEqual([]);
    }
  });
});

describe('decide: actuation gate (kill switch, SAFE MODE, drain)', () => {
  const off = cfg({ actuationAllowed: false });

  it('delivers nothing and ends nothing, even when everything is due (only the one wakes-disabled alert)', () => {
    const only = [{ type: 'alertOperator', reason: 'wakes-disabled' }];
    expect(decide(state({ deadlineAt: iso(60) }), idle, at(100), off)).toEqual(only);
    expect(decide(state(), { ...idle, allTargetsTerminal: true }, at(100), off)).toEqual(only);
    expect(decide(state({ deadlineWakeDeliveredAt: iso(60), deadlineAt: iso(60) }), idle, at(100), off)).toEqual(only);
  });

  it('alerts once, deduped, that wakes are disabled while the mandate is active', () => {
    expect(decide(state(), idle, at(10), off)).toEqual([{ type: 'alertOperator', reason: 'wakes-disabled' }]);
    expect(decide(state({ lastAlertReason: 'wakes-disabled' }), idle, at(11), off)).toEqual([]);
    expect(decide(state({ endedAt: iso(5) }), idle, at(11), off)).toEqual([]);
  });

  it('never restarts a crashed supervisor; alerts once instead (the watchdog keeps running)', () => {
    expect(decide(state(), terminal, at(10), off)).toEqual([
      { type: 'markHealth', health: 'dead', undeliverableTicks: 0 },
      { type: 'alertOperator', reason: 'supervisor-dead-wakes-disabled' },
    ]);
    const already = state({ health: 'dead', lastAlertReason: 'supervisor-dead-wakes-disabled' });
    expect(decide(already, terminal, at(11), off)).toEqual([]);
  });

  it('counts no undeliverable ticks while disabled', () => {
    expect(decide(state({ lastAlertReason: 'wakes-disabled' }), busy, at(50), off)).toEqual([]);
  });
});

describe('nextWake', () => {
  it('is the heartbeat while it precedes the deadline, then the deadline', () => {
    expect(nextWake(state(), cfg())).toEqual({ kind: 'heartbeat', at: iso(45) });
    expect(nextWake(state({ deadlineAt: iso(30) }), cfg())).toEqual({ kind: 'deadline', at: iso(30) });
  });

  it('is undefined once ended', () => {
    expect(nextWake(state({ endedAt: iso(1) }), cfg())).toBeUndefined();
  });
});
