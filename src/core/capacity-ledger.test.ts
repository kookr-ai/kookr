import { describe, expect, test } from 'vitest';
import { buildCapacityLedger, classifyTaskCapacity, isReservedSlotLaunch, type TaskCapacityClass } from './capacity-ledger.js';
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
    expect(ledger.maxActiveTasks).toBe(10);
    expect(ledger.free).toBe(5);
    expect(ledger.pendingQueueDepth).toBe(2);
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
    expect(ledger.active).toBe(0);
    expect(ledger.free).toBe(10);
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
