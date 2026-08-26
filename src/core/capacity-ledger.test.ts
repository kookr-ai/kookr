import { describe, expect, test } from 'vitest';
import {
  buildCapacityLedger,
  buildVettedIdeaRunwayReport,
  capacityHasResidualPhantomPressure,
  classifyTaskCapacity,
  computeVettedIdeaRunwayDays,
  evaluateCapacityThroughputVerdict,
  evaluateHungSuspectCapacityFinding,
  evaluateIdleCapacityFinding,
  isReservedSlotLaunch,
  resolveIdleCapacitySignalInputs,
  DEFAULT_RESIDUAL_PHANTOM_PRESSURE_BOUND,
  DEFAULT_VETTED_IDEA_RUNWAY_FLOOR_DAYS,
  HUNG_SUSPECT_CAPACITY_FINDING_CODE,
  IDLE_CAPACITY_FINDING_CODE,
  type TaskCapacityClass,
} from './capacity-ledger.js';
import type { Task } from './task-read-model.js';

const NOW = Date.parse('2026-07-24T12:00:00.000Z');

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    prompt: 'do the thing',
    cwd: '/repo',
    agentType: 'claude-code',
    status: 'inProgress',
    sessions: [],
    createdAt: new Date(NOW - 60_000),
    updatedAt: new Date(NOW),
    ...overrides,
  };
}

describe('classifyTaskCapacity', () => {
  test('inProgress, no pendingSignal, not hung → working', () => {
    const cls = classifyTaskCapacity(task({ status: 'inProgress' }), { isHungSuspect: false, isLaunching: false });
    expect(cls).toBe('working');
  });

  test('inProgress with pendingSignal completion_ready → finishedAwaitingAck', () => {
    const cls = classifyTaskCapacity(
      task({ status: 'inProgress', pendingSignal: { kind: 'completion_ready', raisedAt: '2026-07-24T11:00:00.000Z' } }),
      { isHungSuspect: false, isLaunching: false },
    );
    expect(cls).toBe('finishedAwaitingAck');
  });

  test('inProgress, hung suspect (and no pendingSignal) → hungSuspect', () => {
    const cls = classifyTaskCapacity(task({ status: 'inProgress' }), { isHungSuspect: true, isLaunching: false });
    expect(cls).toBe('hungSuspect');
  });

  test('finishedAwaitingAck takes priority over hungSuspect when both signals are present', () => {
    const cls = classifyTaskCapacity(
      task({ status: 'inProgress', pendingSignal: { kind: 'completion_ready', raisedAt: '2026-07-24T11:00:00.000Z' } }),
      { isHungSuspect: true, isLaunching: false },
    );
    expect(cls).toBe('finishedAwaitingAck');
  });

  test('open task with a fresh launch reservation → launching', () => {
    const cls = classifyTaskCapacity(task({ status: 'open' }), { isHungSuspect: false, isLaunching: true });
    expect(cls).toBe('launching');
  });

  test('pending task with a fresh launch reservation → launching', () => {
    const cls = classifyTaskCapacity(task({ status: 'pending' }), { isHungSuspect: false, isLaunching: true });
    expect(cls).toBe('launching');
  });

  test('boundary: pendingSignal present but task is NOT inProgress → not counted (null)', () => {
    const cls = classifyTaskCapacity(
      task({ status: 'pending', pendingSignal: { kind: 'completion_ready', raisedAt: '2026-07-24T11:00:00.000Z' } }),
      { isHungSuspect: false, isLaunching: false },
    );
    expect(cls).toBeNull();
  });

  test('boundary: watchdog state absent (isHungSuspect: false, the caller-side default) → working, not hungSuspect', () => {
    const cls = classifyTaskCapacity(task({ status: 'inProgress' }), { isHungSuspect: false, isLaunching: false });
    expect(cls).toBe('working');
  });

  test('pending task with no launch reservation → not counted (null) — this is the backlog, not active capacity', () => {
    const cls = classifyTaskCapacity(task({ status: 'pending' }), { isHungSuspect: false, isLaunching: false });
    expect(cls).toBeNull();
  });

  test('terminal statuses are never counted', () => {
    for (const status of ['completed', 'terminated', 'cancelled'] as const) {
      const cls = classifyTaskCapacity(task({ status }), { isHungSuspect: true, isLaunching: true });
      expect(cls).toBeNull();
    }
  });
});

describe('buildCapacityLedger', () => {
  function byClassOf(tasks: Task[], hungIds: Set<string> = new Set(), launchingIds: Set<string> = new Set()) {
    return buildCapacityLedger(tasks, {
      now: NOW,
      maxActiveTasks: 10,
      isHungSuspect: (t) => hungIds.has(t.id),
      isLaunching: (t) => launchingIds.has(t.id),
    });
  }

  test('a mix of classes produces exact byClass counts and active/free', () => {
    const tasks: Task[] = [
      task({ id: 'w1', status: 'inProgress' }),
      task({ id: 'w2', status: 'inProgress' }),
      task({
        id: 'a1',
        status: 'inProgress',
        pendingSignal: { kind: 'completion_ready', raisedAt: '2026-07-24T11:00:00.000Z' },
      }),
      task({ id: 'h1', status: 'inProgress' }),
      task({ id: 'l1', status: 'open' }),
      task({ id: 'p1', status: 'pending' }), // backlog, not launching
      task({ id: 'p2', status: 'pending' }), // backlog, not launching
      task({ id: 'done1', status: 'completed' }),
    ];
    const ledger = byClassOf(tasks, new Set(['h1']), new Set(['l1']));

    expect(ledger.byClass).toEqual({
      working: 2,
      finishedAwaitingAck: 1,
      hungSuspect: 1,
      launching: 1,
    } satisfies Record<TaskCapacityClass, number>);
    expect(ledger.active).toBe(5); // 2 + 1 + 1 + 1
    expect(ledger.effectiveWorking).toBe(3); // working 2 + launching 1
    expect(ledger.phantomActive).toBe(2); // FAA 1 + hungSuspect 1
    expect(ledger.maxActiveTasks).toBe(10);
    expect(ledger.free).toBe(5);
    expect(ledger.pendingQueueDepth).toBe(2);
  });

  test('reports dependency-parked pending work separately from active capacity', () => {
    const ledger = byClassOf([
      task({
        id: 'parked-1',
        status: 'pending',
        launchAdmission: {
          status: 'parked',
          reason: 'dependency_degraded',
          dependencies: [{ dependency: 'kb', state: 'degraded' }],
          parkedAt: '2026-07-24T11:00:00.000Z',
        },
      }),
    ]);

    expect(ledger.active).toBe(0);
    expect(ledger.free).toBe(10);
    expect(ledger.pendingQueueDepth).toBe(0);
    expect(ledger.parked).toEqual({
      taskCount: 1,
      taskIds: ['parked-1'],
      byDependency: [{ dependency: 'kb', taskCount: 1, taskIds: ['parked-1'] }],
    });
  });

  test('counts a half-open probe waiting for capacity as queued, not dependency-parked', () => {
    const ledger = byClassOf([task({
      id: 'capacity-probe',
      status: 'pending',
      launchAdmission: {
        status: 'parked',
        reason: 'half_open_waiting_for_capacity',
        dependencies: [{ dependency: 'kb', state: 'half_open' }],
        parkedAt: '2026-07-24T11:00:00.000Z',
      },
    })]);

    expect(ledger.pendingQueueDepth).toBe(1);
    expect(ledger.parked).toBeUndefined();
  });

  test('faaStaleThresholdMs / faaTtlMs deps flow into FAA classification (issue #2142)', () => {
    // A 45-min-old opted-in FAA task: with the default 60-min stale threshold it
    // reads as awaiting_poll, but with the live 30-min auto-close delay wired in
    // it is correctly ack_sweep_backlog (the sweep already considers it eligible).
    const tasks: Task[] = [
      task({
        id: 'opted-in-45m',
        status: 'inProgress',
        autoCloseOnSignal: true,
        pendingSignal: { kind: 'completion_ready', raisedAt: new Date(NOW - 45 * 60_000).toISOString() },
      }),
    ];
    const deps = {
      now: NOW,
      maxActiveTasks: 10,
      isHungSuspect: () => false,
      isLaunching: () => false,
    };

    const withDefault = buildCapacityLedger(tasks, deps);
    expect(withDefault.finishedAwaitingAckByCause.awaiting_poll).toBe(1);
    expect(withDefault.finishedAwaitingAckByCause.ack_sweep_backlog).toBe(0);

    const withLiveThreshold = buildCapacityLedger(tasks, { ...deps, faaStaleThresholdMs: 30 * 60_000 });
    expect(withLiveThreshold.finishedAwaitingAckByCause.awaiting_poll).toBe(0);
    expect(withLiveThreshold.finishedAwaitingAckByCause.ack_sweep_backlog).toBe(1);
  });

  test('free never goes negative when active exceeds maxActiveTasks', () => {
    const tasks = [task({ id: 'w1' }), task({ id: 'w2' }), task({ id: 'w3' })];
    const ledger = buildCapacityLedger(tasks, {
      now: NOW,
      maxActiveTasks: 2,
      isHungSuspect: () => false,
      isLaunching: () => false,
    });
    expect(ledger.active).toBe(3);
    expect(ledger.free).toBe(0);
  });

  test('oldestPendingAgeMs is null with no pending tasks, and reflects the oldest createdAt otherwise', () => {
    const empty = byClassOf([]);
    expect(empty.oldestPendingAgeMs).toBeNull();
    expect(empty.pendingQueueDepth).toBe(0);

    const tasks = [
      task({ id: 'p-newer', status: 'pending', createdAt: new Date(NOW - 5_000) }),
      task({ id: 'p-older', status: 'pending', createdAt: new Date(NOW - 90_000) }),
    ];
    const ledger = byClassOf(tasks);
    expect(ledger.oldestPendingAgeMs).toBe(90_000);
    expect(ledger.pendingQueueDepth).toBe(2);
  });

  test('oldestFinishedAwaitingAckAgeMs is null with none, and reflects the oldest raisedAt otherwise', () => {
    const empty = byClassOf([]);
    expect(empty.oldestFinishedAwaitingAckAgeMs).toBeNull();

    const tasks = [
      task({
        id: 'ack-newer',
        status: 'inProgress',
        pendingSignal: { kind: 'completion_ready', raisedAt: new Date(NOW - 10_000).toISOString() },
      }),
      task({
        id: 'ack-older',
        status: 'inProgress',
        pendingSignal: { kind: 'completion_ready', raisedAt: new Date(NOW - 120_000).toISOString() },
      }),
    ];
    const ledger = byClassOf(tasks);
    expect(ledger.oldestFinishedAwaitingAckAgeMs).toBe(120_000);
  });

  test('an empty task list produces all-zero counts and free === maxActiveTasks', () => {
    const ledger = byClassOf([]);
    expect(ledger.byClass).toEqual({ working: 0, finishedAwaitingAck: 0, hungSuspect: 0, launching: 0 });
    expect(ledger.finishedAwaitingAckByCause).toEqual({
      awaiting_poll: 0,
      ack_sweep_backlog: 0,
      manual_review_gate: 0,
      auto_close_disabled: 0,
    });
    expect(ledger.active).toBe(0);
    expect(ledger.effectiveWorking).toBe(0);
    expect(ledger.phantomActive).toBe(0);
    expect(ledger.free).toBe(10);
  });

  test('finishedAwaitingAckByCause tallies each FAA task by root cause (issue #2142)', () => {
    const tasks: Task[] = [
      // Fresh signal (10s old) → normal poll latency.
      task({
        id: 'fresh',
        status: 'inProgress',
        pendingSignal: { kind: 'completion_ready', raisedAt: new Date(NOW - 10_000).toISOString() },
      }),
      // Aged (2h) + opted into auto-close → the sweep is behind.
      task({
        id: 'backlog',
        status: 'inProgress',
        autoCloseOnSignal: true,
        pendingSignal: { kind: 'completion_ready', raisedAt: new Date(NOW - 2 * 60 * 60_000).toISOString() },
      }),
      // Aged (2h) + ask-first → waiting on a human by design.
      task({
        id: 'human',
        status: 'inProgress',
        deliveryAuthorization: 'ask-first',
        pendingSignal: { kind: 'completion_ready', raisedAt: new Date(NOW - 2 * 60 * 60_000).toISOString() },
      }),
      // Aged (2h) + no opt-in, no TTL → configuration gap.
      task({
        id: 'config',
        status: 'inProgress',
        pendingSignal: { kind: 'completion_ready', raisedAt: new Date(NOW - 2 * 60 * 60_000).toISOString() },
      }),
      // FAA but un-ageable raisedAt (malformed) — still classifies (as awaiting_poll)
      // so the sum invariant below holds; it must not silently vanish.
      task({
        id: 'malformed',
        status: 'inProgress',
        pendingSignal: { kind: 'completion_ready', raisedAt: 'not-a-date' },
      }),
      // Not FAA — must not be tallied.
      task({ id: 'working', status: 'inProgress' }),
    ];
    const ledger = byClassOf(tasks);

    expect(ledger.byClass.finishedAwaitingAck).toBe(5);
    expect(ledger.finishedAwaitingAckByCause).toEqual({
      awaiting_poll: 2, // fresh + un-ageable malformed
      ack_sweep_backlog: 1,
      manual_review_gate: 1,
      auto_close_disabled: 1,
    });
    // The per-cause tally sums to the FAA class count — every FAA task classifies,
    // including one with an un-ageable timestamp.
    const total = Object.values(ledger.finishedAwaitingAckByCause).reduce((a, b) => a + b, 0);
    expect(total).toBe(ledger.byClass.finishedAwaitingAck);
  });

  test('issue #1935: 7 hung / 6 working grid reports phantomActive and freeForGeneralSources from non-phantom', () => {
    // Live incident shape: utilization looks high (13/16) but half is phantom.
    const tasks: Task[] = [
      ...Array.from({ length: 6 }, (_, i) => task({ id: `w${i}`, status: 'inProgress' })),
      ...Array.from({ length: 7 }, (_, i) => task({ id: `h${i}`, status: 'inProgress' })),
      task({
        id: 'faa',
        status: 'inProgress',
        pendingSignal: { kind: 'completion_ready', raisedAt: '2026-07-24T11:00:00.000Z' },
      }),
    ];
    const hungIds = new Set(Array.from({ length: 7 }, (_, i) => `h${i}`));
    const ledger = buildCapacityLedger(tasks, {
      now: NOW,
      maxActiveTasks: 16,
      isHungSuspect: (t) => hungIds.has(t.id),
      isLaunching: () => false,
      reservedActiveSlots: 2,
      reservedSlotSources: ['kookr'],
    });

    expect(ledger.byClass).toEqual({
      working: 6,
      finishedAwaitingAck: 1,
      hungSuspect: 7,
      launching: 0,
    });
    expect(ledger.active).toBe(14);
    expect(ledger.effectiveWorking).toBe(6);
    expect(ledger.phantomActive).toBe(8); // 7 hung + 1 FAA
    expect(ledger.free).toBe(2); // real free slots only
    // freeForGeneralSources excludes phantoms: 16 - 2 reserved - 6 working = 8
    expect(ledger.freeForGeneralSources).toBe(8);
    // Privileged free still sees real occupancy.
    expect(ledger.freeForReservedSources).toBe(2);
  });

  describe('reserved self-maintenance capacity (issue #1564)', () => {
    test('omits the reservation block entirely when no reservation is configured', () => {
      const ledger = byClassOf([task({ id: 'w1' })]);
      expect(ledger.reservedActiveSlots).toBeUndefined();
      expect(ledger.reservedSlotSources).toBeUndefined();
      expect(ledger.freeForReservedSources).toBeUndefined();
      expect(ledger.freeForGeneralSources).toBeUndefined();
    });

    test('reports the reservation and the general-vs-reserved free split', () => {
      // 2 active of 3, with 1 slot reserved for kookr.
      const tasks = [task({ id: 'w1' }), task({ id: 'w2' })];
      const ledger = buildCapacityLedger(tasks, {
        now: NOW,
        maxActiveTasks: 3,
        isHungSuspect: () => false,
        isLaunching: () => false,
        reservedActiveSlots: 1,
        reservedSlotSources: ['kookr'],
      });
      expect(ledger.active).toBe(2);
      expect(ledger.free).toBe(1);
      expect(ledger.reservedActiveSlots).toBe(1);
      expect(ledger.reservedSlotSources).toEqual(['kookr']);
      // A privileged source can still use the whole pool → 1 free slot.
      expect(ledger.freeForReservedSources).toBe(1);
      // A general source is capped at maxActive - reserved = 2, already full → 0.
      expect(ledger.freeForGeneralSources).toBe(0);
    });

    test('clamps a reservation larger than the pool to maxActiveTasks', () => {
      const ledger = buildCapacityLedger([], {
        now: NOW,
        maxActiveTasks: 3,
        isHungSuspect: () => false,
        isLaunching: () => false,
        reservedActiveSlots: 99,
      });
      expect(ledger.reservedActiveSlots).toBe(3);
      // Whole pool reserved: a general source has 0 headroom even when idle.
      expect(ledger.freeForGeneralSources).toBe(0);
      expect(ledger.freeForReservedSources).toBe(3);
    });

    test('a zero reservation still reports the (empty) block without holding slots back', () => {
      const ledger = buildCapacityLedger([task({ id: 'w1' })], {
        now: NOW,
        maxActiveTasks: 3,
        isHungSuspect: () => false,
        isLaunching: () => false,
        reservedActiveSlots: 0,
        reservedSlotSources: [],
      });
      expect(ledger.reservedActiveSlots).toBe(0);
      expect(ledger.freeForGeneralSources).toBe(ledger.freeForReservedSources);
      expect(ledger.freeForGeneralSources).toBe(2);
    });
  });

  describe('evaluateHungSuspectCapacityFinding (issue #1935)', () => {
    function ledgerOf(hungSuspect: number, working: number) {
      return buildCapacityLedger(
        [
          ...Array.from({ length: working }, (_, i) => task({ id: `w${i}` })),
          ...Array.from({ length: hungSuspect }, (_, i) => task({ id: `h${i}` })),
        ],
        {
          now: NOW,
          maxActiveTasks: 16,
          isHungSuspect: (t) => t.id.startsWith('h'),
          isLaunching: () => false,
        },
      );
    }

    test('fires on absolute count bound (≥3) even when ratio is low', () => {
      // 3 hung of 16 active-ish (3 hung + 13 working) → ratio 0.1875 < 0.3, count hits
      const finding = evaluateHungSuspectCapacityFinding(ledgerOf(3, 13));
      expect(finding).toMatchObject({
        code: HUNG_SUSPECT_CAPACITY_FINDING_CODE,
        hungSuspect: 3,
        active: 16,
      });
    });

    test('fires on ratio bound (≥0.3) even when absolute count is below 3', () => {
      // 2 hung of 6 active = 0.333 ≥ 0.3
      const finding = evaluateHungSuspectCapacityFinding(ledgerOf(2, 4));
      expect(finding?.code).toBe(HUNG_SUSPECT_CAPACITY_FINDING_CODE);
      expect(finding?.ratio).toBeCloseTo(2 / 6, 5);
    });

    test('does not fire for a healthy grid (1 hung / 10 working)', () => {
      expect(evaluateHungSuspectCapacityFinding(ledgerOf(1, 10))).toBeNull();
    });

    test('7-hung/6-working grid is never purely healthy', () => {
      const finding = evaluateHungSuspectCapacityFinding(ledgerOf(7, 6));
      expect(finding).not.toBeNull();
      expect(finding!.hungSuspect).toBe(7);
      expect(finding!.effectiveWorking).toBe(6);
      expect(finding!.phantomActive).toBe(7);
    });
  });
});

describe('isReservedSlotLaunch (issue #1564)', () => {
  test('privileged by launch source', () => {
    expect(isReservedSlotLaunch('kookr', undefined, ['kookr'])).toBe(true);
  });

  test('privileged by attributed actor id', () => {
    expect(isReservedSlotLaunch('api', 'kookr', ['kookr'])).toBe(true);
    // Actor id is trimmed before matching.
    expect(isReservedSlotLaunch('api', '  kookr  ', ['kookr'])).toBe(true);
  });

  test('a non-privileged source/actor (e.g. lucy) is not reserved', () => {
    expect(isReservedSlotLaunch('api', 'lucy', ['kookr'])).toBe(false);
    expect(isReservedSlotLaunch('cli', undefined, ['kookr'])).toBe(false);
  });

  test('an empty reserved-source list privileges no one', () => {
    expect(isReservedSlotLaunch('kookr', 'kookr', [])).toBe(false);
  });

  test('blank actor id is ignored', () => {
    expect(isReservedSlotLaunch('api', '   ', ['kookr'])).toBe(false);
  });
});

describe('computeVettedIdeaRunwayDays (issue #2143)', () => {
  test('runway = backlog ÷ consumption', () => {
    expect(computeVettedIdeaRunwayDays({ backlogDepth: 12, consumptionPerDay: 4 })).toBe(3);
  });

  test('zero backlog with active consumption is 0 days of runway', () => {
    expect(computeVettedIdeaRunwayDays({ backlogDepth: 0, consumptionPerDay: 4 })).toBe(0);
  });

  test('null when supply is absent', () => {
    expect(computeVettedIdeaRunwayDays(null)).toBeNull();
    expect(computeVettedIdeaRunwayDays(undefined)).toBeNull();
  });

  test('null (unbounded, not a shortfall) when consumption is non-positive', () => {
    expect(computeVettedIdeaRunwayDays({ backlogDepth: 10, consumptionPerDay: 0 })).toBeNull();
    expect(computeVettedIdeaRunwayDays({ backlogDepth: 10, consumptionPerDay: -1 })).toBeNull();
  });

  test('null on non-finite / negative operands', () => {
    expect(computeVettedIdeaRunwayDays({ backlogDepth: -1, consumptionPerDay: 4 })).toBeNull();
    expect(computeVettedIdeaRunwayDays({ backlogDepth: Number.NaN, consumptionPerDay: 4 })).toBeNull();
  });
});

describe('buildVettedIdeaRunwayReport (issue #2143)', () => {
  test('reports runway, floor, and shortfall together', () => {
    expect(buildVettedIdeaRunwayReport({ backlogDepth: 1, consumptionPerDay: 4 }, 2)).toEqual({
      runwayDays: 0.25,
      floorDays: 2,
      shortfall: true,
      backlogDepth: 1,
      consumptionPerDay: 4,
    });
  });

  test('no shortfall when runway meets the floor; default floor applies', () => {
    const report = buildVettedIdeaRunwayReport({ backlogDepth: 20, consumptionPerDay: 4 });
    expect(report).toEqual({
      runwayDays: 5,
      floorDays: DEFAULT_VETTED_IDEA_RUNWAY_FLOOR_DAYS,
      shortfall: false,
      backlogDepth: 20,
      consumptionPerDay: 4,
    });
  });

  test('no shortfall at exactly the floor (strict < boundary)', () => {
    // 4 ÷ 2 = 2.0 days == floor ⇒ NOT a shortfall. Guards against `<` → `<=` drift.
    expect(buildVettedIdeaRunwayReport({ backlogDepth: 4, consumptionPerDay: 2 }, 2)).toMatchObject({
      runwayDays: 2,
      shortfall: false,
    });
  });

  test('null when supply operands are unavailable', () => {
    expect(buildVettedIdeaRunwayReport(null)).toBeNull();
  });

  test('unbounded runway (no consumption) is reported as null runwayDays, no shortfall', () => {
    const report = buildVettedIdeaRunwayReport({ backlogDepth: 10, consumptionPerDay: 0 }, 2);
    expect(report).toMatchObject({ runwayDays: null, shortfall: false });
  });
});

describe('evaluateIdleCapacityFinding (issue #2143)', () => {
  const idleLedger = (over: Partial<{ free: number; freeForGeneralSources: number; pendingQueueDepth: number }> = {}) => ({
    free: 7,
    pendingQueueDepth: 0,
    ...over,
  });

  test('returns null when there is no idle capacity to fill', () => {
    expect(evaluateIdleCapacityFinding({ free: 0, pendingQueueDepth: 0 })).toBeNull();
  });

  test('a fully-reserved pool (freeForGeneralSources 0) has no idle capacity even when free > 0', () => {
    // Nullish-coalescing, not truthiness: 0 general slots ⇒ null, never a fall back to `free`.
    expect(
      evaluateIdleCapacityFinding({ free: 7, freeForGeneralSources: 0, pendingQueueDepth: 0 }),
    ).toBeNull();
  });

  // AC(1): info-level (not warn) when queue is empty AND prsPerDay >= target.
  test('info (not warning) when queue empty and throughput at/above target', () => {
    const finding = evaluateIdleCapacityFinding(idleLedger(), {
      prsPerDay: 72,
      targetPrsPerDay: 24,
    });
    expect(finding).not.toBeNull();
    expect(finding!.code).toBe(IDLE_CAPACITY_FINDING_CODE);
    expect(finding!.severity).toBe('info');
    expect(finding!.driver).toBe('headroom_unused');
    expect(finding!.atOrAboveThroughputTarget).toBe(true);
    expect(finding!.idleSlots).toBe(7);
  });

  // The exact false-positive this issue fixes: 300% of target, empty queue,
  // no runway signal → unused headroom, not a defect.
  test('the "sideways-on-capacity-fill" scenario is info, not warning', () => {
    const finding = evaluateIdleCapacityFinding(
      { free: 16, freeForGeneralSources: 6, pendingQueueDepth: 0 },
      { prsPerDay: 72, targetPrsPerDay: 24 },
    );
    expect(finding!.severity).toBe('info');
    // Idle slots read from the general-source view when a reservation is configured.
    expect(finding!.idleSlots).toBe(6);
  });

  // AC(3): escalation keys on runway shortfall, NOT raw utilization — warning
  // even at 300% throughput when the vetted-idea stream is running dry.
  test('warning on runway shortfall even when throughput is far above target', () => {
    const finding = evaluateIdleCapacityFinding(idleLedger(), {
      prsPerDay: 72,
      targetPrsPerDay: 24,
      vettedIdea: { backlogDepth: 1, consumptionPerDay: 4 }, // 0.25d < 2d floor
    });
    expect(finding!.severity).toBe('warning');
    expect(finding!.driver).toBe('runway_shortfall');
    expect(finding!.runwayShortfall).toBe(true);
    expect(finding!.vettedIdeaRunwayDays).toBe(0.25);
    expect(finding!.atOrAboveThroughputTarget).toBe(true);
  });

  // AC(3) directly: known throughput BELOW target, empty queue, healthy runway →
  // still info. Utilization is not an escalation key.
  test('known below-target throughput with empty queue and healthy runway stays info', () => {
    const finding = evaluateIdleCapacityFinding(idleLedger(), {
      prsPerDay: 5,
      targetPrsPerDay: 24,
      vettedIdea: { backlogDepth: 20, consumptionPerDay: 4 }, // 5d >= 2d floor
    });
    expect(finding!.severity).toBe('info');
    expect(finding!.driver).toBe('headroom_unused');
    expect(finding!.atOrAboveThroughputTarget).toBe(false);
  });

  test('runway exactly at the floor is not a shortfall (strict < boundary) → info', () => {
    const finding = evaluateIdleCapacityFinding(idleLedger(), {
      vettedIdea: { backlogDepth: 4, consumptionPerDay: 2 }, // 2.0d == default floor
    });
    expect(finding!.runwayShortfall).toBe(false);
    expect(finding!.severity).toBe('info');
  });

  test('healthy runway at/above target stays info', () => {
    const finding = evaluateIdleCapacityFinding(idleLedger(), {
      prsPerDay: 72,
      targetPrsPerDay: 24,
      vettedIdea: { backlogDepth: 20, consumptionPerDay: 4 }, // 5d >= 2d floor
    });
    expect(finding!.severity).toBe('info');
    expect(finding!.runwayShortfall).toBe(false);
  });

  // Genuine under-driving: queued work stranded behind idle slots warns
  // regardless of supply/throughput.
  test('warning when queued work is stranded behind idle slots', () => {
    const finding = evaluateIdleCapacityFinding(idleLedger({ pendingQueueDepth: 3 }), {
      prsPerDay: 72,
      targetPrsPerDay: 24,
    });
    expect(finding!.severity).toBe('warning');
    expect(finding!.driver).toBe('queue_backlog_idle');
  });

  test('queue backlog takes precedence over runway shortfall as the driver', () => {
    const finding = evaluateIdleCapacityFinding(idleLedger({ pendingQueueDepth: 2 }), {
      vettedIdea: { backlogDepth: 0, consumptionPerDay: 4 },
    });
    expect(finding!.severity).toBe('warning');
    expect(finding!.driver).toBe('queue_backlog_idle');
    expect(finding!.runwayShortfall).toBe(true);
  });

  test('reports the runway metric and defaults floor when only supply is given', () => {
    const finding = evaluateIdleCapacityFinding(idleLedger(), {
      vettedIdea: { backlogDepth: 6, consumptionPerDay: 2 },
    });
    expect(finding!.vettedIdeaRunwayDays).toBe(3);
    expect(finding!.runwayFloorDays).toBe(DEFAULT_VETTED_IDEA_RUNWAY_FLOOR_DAYS);
    expect(finding!.runwayShortfall).toBe(false);
    // No throughput inputs ⇒ not judged against target, and no queue ⇒ info.
    expect(finding!.atOrAboveThroughputTarget).toBe(false);
    expect(finding!.severity).toBe('info');
  });

  test('unknown throughput/supply with empty queue is info (pure headroom observability)', () => {
    const finding = evaluateIdleCapacityFinding(idleLedger());
    expect(finding!.severity).toBe('info');
    expect(finding!.prsPerDay).toBeNull();
    expect(finding!.targetPrsPerDay).toBeNull();
    expect(finding!.vettedIdeaRunwayDays).toBeNull();
  });
});

describe('resolveIdleCapacitySignalInputs (issue #2143)', () => {
  test('parses all supply-aware operands from env', () => {
    expect(
      resolveIdleCapacitySignalInputs({
        KOOKR_PRS_PER_DAY: '72',
        KOOKR_TARGET_PRS_PER_DAY: '24',
        KOOKR_VETTED_IDEA_BACKLOG: '8',
        KOOKR_VETTED_IDEA_CONSUMPTION_PER_DAY: '4',
        KOOKR_VETTED_IDEA_RUNWAY_FLOOR_DAYS: '3',
      }),
    ).toEqual({
      prsPerDay: 72,
      targetPrsPerDay: 24,
      vettedIdea: { backlogDepth: 8, consumptionPerDay: 4 },
      runwayFloorDays: 3,
    });
  });

  test('absent env ⇒ null operands, no vettedIdea, no floor override', () => {
    expect(resolveIdleCapacitySignalInputs({})).toEqual({
      prsPerDay: null,
      targetPrsPerDay: null,
      vettedIdea: null,
    });
  });

  test('vettedIdea requires BOTH backlog and consumption', () => {
    expect(
      resolveIdleCapacitySignalInputs({ KOOKR_VETTED_IDEA_BACKLOG: '8' }).vettedIdea,
    ).toBeNull();
    expect(
      resolveIdleCapacitySignalInputs({ KOOKR_VETTED_IDEA_CONSUMPTION_PER_DAY: '4' }).vettedIdea,
    ).toBeNull();
  });

  test('malformed / negative values are treated as absent', () => {
    const inputs = resolveIdleCapacitySignalInputs({
      KOOKR_PRS_PER_DAY: 'abc',
      KOOKR_TARGET_PRS_PER_DAY: '-5',
      KOOKR_VETTED_IDEA_RUNWAY_FLOOR_DAYS: '   ',
    });
    expect(inputs.prsPerDay).toBeNull();
    expect(inputs.targetPrsPerDay).toBeNull();
    expect(inputs.runwayFloorDays).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Effective vs nominal utilization (issue #2169)
//
// The two production samples from the issue, taken ~1 min apart on 2026-08-07,
// both read "capacity 93.8% utilized (15/16 active) — healthy_throughput" from
// the NOMINAL active count while real productive utilization was 37–50%.
// ---------------------------------------------------------------------------
describe('effective vs nominal utilization (issue #2169)', () => {
  const MAX = 16;

  /**
   * Build a ledger for a phantom-heavy sample: `working` productive tasks,
   * `faa` finished-awaiting-ack, `hung` hung-suspect — all inProgress, so
   * `active = working + faa + hung`. No launching, no reservation, so the
   * effective-free fallback (not `freeForGeneralSources`) is what's exercised.
   */
  function sampleLedger({ working, faa, hung }: { working: number; faa: number; hung: number }) {
    const tasks: Task[] = [];
    for (let i = 0; i < working; i++) tasks.push(task({ id: `w${i}`, status: 'inProgress' }));
    for (let i = 0; i < faa; i++)
      tasks.push(
        task({
          id: `a${i}`,
          status: 'inProgress',
          pendingSignal: { kind: 'completion_ready', raisedAt: '2026-07-24T11:00:00.000Z' },
        }),
      );
    const hungIds = new Set<string>();
    for (let i = 0; i < hung; i++) {
      const id = `h${i}`;
      hungIds.add(id);
      tasks.push(task({ id, status: 'inProgress' }));
    }
    return buildCapacityLedger(tasks, {
      now: NOW,
      maxActiveTasks: MAX,
      isHungSuspect: (t) => hungIds.has(t.id),
      isLaunching: () => false,
    });
  }

  // Sample A (09:29Z): 15/16 active, 8 working, 2 FAA, 5 hung.
  const sampleA = sampleLedger({ working: 8, faa: 2, hung: 5 });
  // Sample B (09:30Z): 15/16 active, 6 working, 5 FAA, 4 hung.
  const sampleB = sampleLedger({ working: 6, faa: 5, hung: 4 });

  test('the ledger surfaces effectiveUtilizationPct alongside the nominal figure', () => {
    expect(sampleA.active).toBe(15);
    expect(sampleA.effectiveWorking).toBe(8);
    expect(sampleA.phantomActive).toBe(7);
    // Nominal masks phantom hold at 93.8%; effective tells the truth at 50%.
    // 15/16 is a power-of-two fraction, so 93.75 is exactly representable.
    expect(sampleA.utilizationPct).toBe(93.75);
    expect(sampleA.effectiveUtilizationPct).toBe(50);

    expect(sampleB.active).toBe(15);
    expect(sampleB.effectiveWorking).toBe(6);
    expect(sampleB.phantomActive).toBe(9);
    expect(sampleB.utilizationPct).toBe(93.75);
    expect(sampleB.effectiveUtilizationPct).toBe(37.5);
  });

  test('the throughput verdict keys on effective utilization — samples A & B do NOT read healthy', () => {
    const verdictA = evaluateCapacityThroughputVerdict(sampleA);
    expect(verdictA.verdict).toBe('idle_capacity');
    expect(verdictA.effectiveUtilizationPct).toBe(50);
    expect(verdictA.utilizationPct).toBe(93.75);
    expect(verdictA.idleEffectiveSlots).toBe(8); // 16 - 8 working

    const verdictB = evaluateCapacityThroughputVerdict(sampleB);
    expect(verdictB.verdict).toBe('idle_capacity');
    expect(verdictB.effectiveUtilizationPct).toBe(37.5);
    expect(verdictB.idleEffectiveSlots).toBe(10); // 16 - 6 working
  });

  test('a genuinely full productive fleet reads healthy_throughput', () => {
    const full = sampleLedger({ working: 16, faa: 0, hung: 0 });
    expect(full.effectiveUtilizationPct).toBe(100);
    expect(evaluateCapacityThroughputVerdict(full).verdict).toBe('healthy_throughput');
    expect(evaluateCapacityThroughputVerdict(full).idleEffectiveSlots).toBe(0);
  });

  // The sharpest form of the AC: a NOMINALLY-FULL fleet (active === max, so
  // nominal free is 0) held open entirely by phantoms. Naive nominal-free
  // keying would flip the verdict to healthy_throughput; effective keying must
  // not. 8 working + 8 phantom = 16 active of 16.
  test('a nominally-full fleet held open by phantoms still reads idle_capacity', () => {
    const phantomFull = sampleLedger({ working: 8, faa: 4, hung: 4 });
    expect(phantomFull.active).toBe(16);
    expect(phantomFull.free).toBe(0); // nominal free is zero — the trap
    expect(phantomFull.effectiveUtilizationPct).toBe(50);
    const verdict = evaluateCapacityThroughputVerdict(phantomFull);
    expect(verdict.verdict).toBe('idle_capacity');
    expect(verdict.idleEffectiveSlots).toBe(8); // 16 - 8 working, not nominal free (0)
  });

  test('the supply-aware idle signal consumes effective (not nominal) idle slots and carries effective utilization', () => {
    // Nominal free is only 1 (16 - 15 active), but the idle signal keys on
    // effective occupancy: 8 productive slots are idle behind phantom hold.
    const finding = evaluateIdleCapacityFinding(sampleA, { prsPerDay: 72, targetPrsPerDay: 24 });
    expect(finding).not.toBeNull();
    expect(finding!.idleSlots).toBe(8); // effective, not nominal free (1)
    expect(finding!.effectiveUtilizationPct).toBe(50);
    expect(finding!.utilizationPct).toBeCloseTo(93.75, 5);

    const findingB = evaluateIdleCapacityFinding(sampleB);
    expect(findingB!.idleSlots).toBe(10);
    expect(findingB!.effectiveUtilizationPct).toBe(37.5);
  });

  test('a reservation-aware ledger keeps freeForGeneralSources as the idle-slot source', () => {
    // freeForGeneralSources already excludes phantoms (issue #1935); the verdict
    // and idle signal must use it verbatim rather than recomputing.
    const tasks: Task[] = [];
    for (let i = 0; i < 8; i++) tasks.push(task({ id: `w${i}`, status: 'inProgress' }));
    for (let i = 0; i < 5; i++) {
      tasks.push(task({ id: `h${i}`, status: 'inProgress' }));
    }
    const hungIds = new Set(['h0', 'h1', 'h2', 'h3', 'h4']);
    const ledger = buildCapacityLedger(tasks, {
      now: NOW,
      maxActiveTasks: MAX,
      isHungSuspect: (t) => hungIds.has(t.id),
      isLaunching: () => false,
      reservedActiveSlots: 2,
      reservedSlotSources: ['kookr'],
    });
    // 16 - 2 reserved - 8 working = 6 general-source slots.
    expect(ledger.freeForGeneralSources).toBe(6);
    expect(evaluateCapacityThroughputVerdict(ledger).idleEffectiveSlots).toBe(6);
    expect(evaluateIdleCapacityFinding(ledger)!.idleSlots).toBe(6);
  });

  test('a fully-reserved pool (freeForGeneralSources 0) reads healthy_throughput even with productive headroom', () => {
    // Mirrors the #1935 general-source view and the idle-finding null case:
    // when the whole pool is reserved, general sources see no idle slots, so
    // the verdict keys on freeForGeneralSources (0), not pure effective free.
    const verdict = evaluateCapacityThroughputVerdict({
      maxActiveTasks: 16,
      active: 4,
      effectiveWorking: 4,
      phantomActive: 0,
      utilizationPct: 25,
      effectiveUtilizationPct: 25,
      freeForGeneralSources: 0,
    });
    expect(verdict.idleEffectiveSlots).toBe(0);
    expect(verdict.verdict).toBe('healthy_throughput');
  });

  test('utilization is 0 (not NaN) when maxActiveTasks is 0', () => {
    const ledger = buildCapacityLedger([], {
      now: NOW,
      maxActiveTasks: 0,
      isHungSuspect: () => false,
      isLaunching: () => false,
    });
    expect(ledger.utilizationPct).toBe(0);
    expect(ledger.effectiveUtilizationPct).toBe(0);
  });
});

describe('capacityHasResidualPhantomPressure (issue #2357)', () => {
  test('live residual: idle_capacity + multi-phantom fires', () => {
    // Reflection snapshot shape: idleEffectiveSlots=4/2, phantomActive=6/3.
    expect(
      capacityHasResidualPhantomPressure({
        idleEffectiveSlots: 4,
        phantomActive: 6,
        pendingQueueDepth: 0,
      }),
    ).toBe(true);
    expect(
      capacityHasResidualPhantomPressure({
        idleEffectiveSlots: 2,
        phantomActive: 3,
        providerPausedCount: 5,
        pendingQueueDepth: 0,
      }),
    ).toBe(true);
  });

  test('agrees with capacityThroughputVerdict: no idle slots → no residual pressure', () => {
    const full = evaluateCapacityThroughputVerdict({
      maxActiveTasks: 16,
      active: 16,
      effectiveWorking: 16,
      phantomActive: 0,
      utilizationPct: 100,
      effectiveUtilizationPct: 100,
    });
    expect(full.verdict).toBe('healthy_throughput');
    expect(
      capacityHasResidualPhantomPressure({
        idleEffectiveSlots: full.idleEffectiveSlots,
        phantomActive: 6,
      }),
    ).toBe(false);
  });

  test('issue #2357: coherent residual ledger — verdict, residual gate, and idle slots agree', () => {
    // Nominal full (free=0): 12 working + 4 FAA phantoms, reserved freeForGeneral=4.
    // Residual-only util/phantom shape relative to #2355 bound of 4 with util at 75.
    const residual = evaluateCapacityThroughputVerdict({
      maxActiveTasks: 16,
      active: 16,
      effectiveWorking: 12,
      phantomActive: 4,
      utilizationPct: 100,
      effectiveUtilizationPct: 75,
      freeForGeneralSources: 4,
    });
    expect(residual.verdict).toBe('idle_capacity');
    expect(residual.idleEffectiveSlots).toBe(4);
    expect(residual.phantomActive).toBe(4);
    expect(
      capacityHasResidualPhantomPressure({
        idleEffectiveSlots: residual.idleEffectiveSlots,
        phantomActive: residual.phantomActive,
        pendingQueueDepth: 0,
      }),
    ).toBe(true);
    // Residual-only shape (phantom under #2355 bound of 4, util not < 75) still
    // enables soft reclaim via idleEffectiveSlots from the same verdict.
    expect(
      capacityHasResidualPhantomPressure({
        idleEffectiveSlots: residual.idleEffectiveSlots,
        phantomActive: 3,
        pendingQueueDepth: 0,
      }),
    ).toBe(true);
  });

  test('occupancy bound defaults to 2; single squatter under idle does not fire', () => {
    expect(DEFAULT_RESIDUAL_PHANTOM_PRESSURE_BOUND).toBe(2);
    expect(
      capacityHasResidualPhantomPressure({
        idleEffectiveSlots: 4,
        phantomActive: 1,
      }),
    ).toBe(false);
    expect(
      capacityHasResidualPhantomPressure({
        idleEffectiveSlots: 4,
        phantomActive: 2,
      }),
    ).toBe(true);
  });

  test('pending queue blocks residual pressure', () => {
    expect(
      capacityHasResidualPhantomPressure({
        idleEffectiveSlots: 4,
        phantomActive: 6,
        pendingQueueDepth: 2,
      }),
    ).toBe(false);
  });
});
