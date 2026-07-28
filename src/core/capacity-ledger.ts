import type { Task } from './task-read-model.js';

/**
 * Capacity-occupying classification for one task (issue #1526 Phase B / FM9).
 *
 * During the 2026-07-24 deadlock every status surface showed "12 running"
 * while the truth was 11 finished-awaiting-ack + 1 hung + 0 actually working.
 * This is the taxonomy that makes that distinction visible: only tasks that
 * genuinely occupy a concurrency slot are classified, and the class explains
 * WHY the slot is occupied.
 */
export type TaskCapacityClass = 'working' | 'finishedAwaitingAck' | 'hungSuspect' | 'launching';

export const TASK_CAPACITY_CLASSES: readonly TaskCapacityClass[] = [
  'working',
  'finishedAwaitingAck',
  'hungSuspect',
  'launching',
];

export interface CapacityClassifyDeps {
  /** Precomputed via `core/hung-task-reaper.ts#isTaskHungSuspect`. */
  isHungSuspect: boolean;
  /** True when the task has a fresh in-flight launch reservation (`TaskStore.hasFreshLaunchReservation`). */
  isLaunching: boolean;
}

/**
 * Pure classification for a single task. Returns `null` for tasks that don't
 * occupy a capacity slot at all (terminal tasks, or a pending/open task with
 * no launch reservation) — those are not counted in `byClass`.
 */
export function classifyTaskCapacity(
  task: Pick<Task, 'status' | 'pendingSignal'>,
  deps: CapacityClassifyDeps,
): TaskCapacityClass | null {
  if (task.status === 'inProgress') {
    if (task.pendingSignal?.kind === 'completion_ready') return 'finishedAwaitingAck';
    return deps.isHungSuspect ? 'hungSuspect' : 'working';
  }
  if ((task.status === 'open' || task.status === 'pending') && deps.isLaunching) {
    return 'launching';
  }
  return null;
}

export interface CapacityLedger {
  maxActiveTasks: number;
  active: number;
  free: number;
  byClass: Record<TaskCapacityClass, number>;
  pendingQueueDepth: number;
  oldestPendingAgeMs: number | null;
  oldestFinishedAwaitingAckAgeMs: number | null;
}

export interface BuildCapacityLedgerDeps {
  now: number;
  maxActiveTasks: number;
  /** Per-task hung-suspect check — see {@link CapacityClassifyDeps.isHungSuspect}. */
  isHungSuspect: (task: Task) => boolean;
  /** Per-task launch-reservation check — see {@link CapacityClassifyDeps.isLaunching}. */
  isLaunching: (task: Task) => boolean;
}

/**
 * Build the full capacity ledger from the live task list in a single O(active
 * tasks) pass. Callers (e.g. `GET /api/health`) must supply `isHungSuspect`/
 * `isLaunching` as cheap, in-memory lookups (Map gets) — this function does no
 * I/O and does not itself touch the watchdog or attention queue, so it stays
 * safe to call on every poll.
 */
export function buildCapacityLedger(tasks: readonly Task[], deps: BuildCapacityLedgerDeps): CapacityLedger {
  const byClass: Record<TaskCapacityClass, number> = {
    working: 0,
    finishedAwaitingAck: 0,
    hungSuspect: 0,
    launching: 0,
  };
  let pendingQueueDepth = 0;
  let oldestPendingAt: number | undefined;
  let oldestFinishedAwaitingAckAt: number | undefined;

  for (const task of tasks) {
    const taskClass = classifyTaskCapacity(task, {
      isHungSuspect: deps.isHungSuspect(task),
      isLaunching: deps.isLaunching(task),
    });
    if (taskClass) {
      byClass[taskClass]++;
      if (taskClass === 'finishedAwaitingAck' && task.pendingSignal) {
        const raisedAt = Date.parse(task.pendingSignal.raisedAt);
        if (Number.isFinite(raisedAt) && (oldestFinishedAwaitingAckAt === undefined || raisedAt < oldestFinishedAwaitingAckAt)) {
          oldestFinishedAwaitingAckAt = raisedAt;
        }
      }
    }

    if (task.status === 'pending') {
      pendingQueueDepth++;
      const createdAt = task.createdAt.getTime();
      if (oldestPendingAt === undefined || createdAt < oldestPendingAt) {
        oldestPendingAt = createdAt;
      }
    }
  }

  const active = byClass.working + byClass.finishedAwaitingAck + byClass.hungSuspect + byClass.launching;

  return {
    maxActiveTasks: deps.maxActiveTasks,
    active,
    free: Math.max(0, deps.maxActiveTasks - active),
    byClass,
    pendingQueueDepth,
    oldestPendingAgeMs: oldestPendingAt !== undefined ? deps.now - oldestPendingAt : null,
    oldestFinishedAwaitingAckAgeMs: oldestFinishedAwaitingAckAt !== undefined ? deps.now - oldestFinishedAwaitingAckAt : null,
  };
}
