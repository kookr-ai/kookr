import type { Task } from './task-read-model.js';
import {
  type FaaRootCause,
  classifyFaaRootCause,
  emptyFaaRootCauseTally,
} from './faa-root-cause.js';

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
  /**
   * Per-root-cause tally over the `byClass.finishedAwaitingAck` population
   * (issue #2142): classifies WHY each FAA task's ack lags — normal poll
   * latency, the auto-close sweep falling behind, a by-design human gate, or a
   * configuration gap — so the chronic FAA churn can be attacked at its
   * dominant cause instead of with yet another downstream mitigation. The
   * counts here sum to `byClass.finishedAwaitingAck` (every FAA task
   * classifies). Always present; all-zero when there are no FAA tasks.
   */
  finishedAwaitingAckByCause: Record<FaaRootCause, number>;
  /**
   * Productive occupancy (issue #1935): `working + launching`. Excludes
   * phantom-active classes (`hungSuspect` + `finishedAwaitingAck`) so
   * utilization consumers can tell "slots busy doing work" from "slots held
   * by stalled/hung tasks". Always present; equals `active` when no phantoms.
   */
  effectiveWorking: number;
  /**
   * Phantom occupancy (issue #1935): `hungSuspect + finishedAwaitingAck`.
   * These hold real concurrency slots but produce no forward progress —
   * the 2026-08-03 reflection's 7 hung / 6 working grid had 50% phantom.
   * Always present; 0 when every active task is productive.
   */
  phantomActive: number;
  pendingQueueDepth: number;
  oldestPendingAgeMs: number | null;
  oldestFinishedAwaitingAckAgeMs: number | null;
  /**
   * Reserved self-maintenance capacity (issue #1564). Additive-optional (no
   * schema version bump): absent on ledgers built without a reservation
   * configured, always present once `buildCapacityLedger` is given a
   * reservation. Makes the guarantee — that a lucy-style burst cannot consume
   * the last {@link reservedActiveSlots} slots — verifiable from `/api/health`.
   */
  reservedActiveSlots?: number;
  /** Source/actor identifiers privileged to consume the reserved slots. */
  reservedSlotSources?: readonly string[];
  /**
   * Free slots a privileged (reserved) source may still launch into. Equals
   * {@link free}: privileged launches see the whole pool (real occupancy).
   */
  freeForReservedSources?: number;
  /**
   * Free slots a general (non-privileged) source may still launch into,
   * computed from **non-phantom** occupancy (issue #1935):
   * `maxActiveTasks - reservedActiveSlots - effectiveWorking`, floored at 0.
   *
   * Phantom-active tasks (`hungSuspect` / `finishedAwaitingAck`) are excluded
   * so queue-feeder / supervisor / velocity probes see capacity that reclaim
   * will free — not the inflated "slots full" picture that hid a 43% phantom
   * hold. Real launch admission still uses `TaskStore.getActiveCount()` (all
   * inProgress tasks), so this field is observability + feeder signal only;
   * it can read higher than {@link free} while phantoms are still resident.
   *
   * When this hits 0 while {@link freeForReservedSources} is still positive,
   * the reservation is actively protecting kookr self-maintenance headroom
   * against genuine productive load (not just phantom hold).
   */
  freeForGeneralSources?: number;
}

/**
 * Whether a launch attributed to `source` (its `launchSource`) and optional
 * `actorId` (the `X-Kookr-Actor` attribution) is privileged to consume the
 * reserved self-maintenance slots (issue #1564). Privileged when EITHER the
 * bare launch source or the attributed actor id is listed in
 * `reservedSlotSources` — so a reservation can be expressed against a launch
 * source (e.g. a future dedicated source) or, as configured by default,
 * against the `kookr` actor.
 */
export function isReservedSlotLaunch(
  source: string | undefined,
  actorId: string | undefined,
  reservedSlotSources: readonly string[],
): boolean {
  if (reservedSlotSources.length === 0) return false;
  const trimmedActor = actorId?.trim();
  return (
    (source !== undefined && reservedSlotSources.includes(source)) ||
    (trimmedActor !== undefined && trimmedActor.length > 0 && reservedSlotSources.includes(trimmedActor))
  );
}

export interface BuildCapacityLedgerDeps {
  now: number;
  maxActiveTasks: number;
  /** Per-task hung-suspect check — see {@link CapacityClassifyDeps.isHungSuspect}. */
  isHungSuspect: (task: Task) => boolean;
  /** Per-task launch-reservation check — see {@link CapacityClassifyDeps.isLaunching}. */
  isLaunching: (task: Task) => boolean;
  /**
   * Stale threshold for FAA root-cause classification (issue #2142). Defaults
   * inside {@link classifyFaaRootCause} to the shared stale-completion window;
   * callers that already resolve a custom threshold may thread it through.
   */
  faaStaleThresholdMs?: number;
  /**
   * TTL-escalation window for FAA root-cause classification (issue #2142).
   * Mirrors the background sweep's `ttlMs`; `undefined` disables the TTL tier.
   */
  faaTtlMs?: number;
  /**
   * Reserved self-maintenance slot count (issue #1564). When present and > 0,
   * the ledger reports the reservation so operators can verify the guarantee.
   * Clamped to `[0, maxActiveTasks]`. Absent ⇒ no reservation is reported.
   */
  reservedActiveSlots?: number;
  /** Source/actor identifiers privileged to consume the reserved slots. */
  reservedSlotSources?: readonly string[];
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
  const finishedAwaitingAckByCause = emptyFaaRootCauseTally();
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
        const cause = classifyFaaRootCause(task, {
          now: deps.now,
          staleThresholdMs: deps.faaStaleThresholdMs,
          ttlMs: deps.faaTtlMs,
        });
        if (cause) finishedAwaitingAckByCause[cause]++;
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

  // Productive vs phantom split (issue #1935). active = both; free still uses
  // real occupancy so privileged free and the raw free gauge never oversell
  // slots still held by hungSuspect / finishedAwaitingAck.
  const effectiveWorking = byClass.working + byClass.launching;
  const phantomActive = byClass.hungSuspect + byClass.finishedAwaitingAck;
  const active = effectiveWorking + phantomActive;
  const free = Math.max(0, deps.maxActiveTasks - active);

  // Reserved self-maintenance capacity (issue #1564). Reported only when a
  // reservation is configured, keeping the block additive-optional.
  // freeForGeneralSources uses non-phantom occupancy (issue #1935) so a
  // 7-hung/6-working grid no longer reports freeForGeneralSources=0 while
  // half the pool is phantom.
  const reservedActiveSlots =
    deps.reservedActiveSlots !== undefined
      ? Math.max(0, Math.min(deps.maxActiveTasks, deps.reservedActiveSlots))
      : undefined;
  const reservation =
    reservedActiveSlots !== undefined
      ? {
          reservedActiveSlots,
          reservedSlotSources: deps.reservedSlotSources ?? [],
          freeForReservedSources: free,
          freeForGeneralSources: Math.max(0, deps.maxActiveTasks - reservedActiveSlots - effectiveWorking),
        }
      : undefined;

  return {
    maxActiveTasks: deps.maxActiveTasks,
    active,
    free,
    byClass,
    finishedAwaitingAckByCause,
    effectiveWorking,
    phantomActive,
    pendingQueueDepth,
    oldestPendingAgeMs: oldestPendingAt !== undefined ? deps.now - oldestPendingAt : null,
    oldestFinishedAwaitingAckAgeMs: oldestFinishedAwaitingAckAt !== undefined ? deps.now - oldestFinishedAwaitingAckAt : null,
    ...(reservation ?? {}),
  };
}

/** Default thresholds for the hung_suspect_capacity health finding (issue #1935). */
export const DEFAULT_HUNG_SUSPECT_CAPACITY_COUNT_BOUND = 3;
export const DEFAULT_HUNG_SUSPECT_CAPACITY_RATIO_BOUND = 0.3;

/** First-class finding code when hungSuspect occupancy wastes capacity (issue #1935). */
export const HUNG_SUSPECT_CAPACITY_FINDING_CODE = 'hung_suspect_capacity' as const;

/**
 * A first-class health finding: hungSuspect tasks are consuming a material
 * share of active capacity (issue #1935). Fires when `hungSuspect ≥ countBound`
 * (default 3) OR `hungSuspect/active ≥ ratioBound` (default 0.3), even when
 * utilization is high — the 7-hung/6-working grid must never classify as
 * purely healthy.
 */
export interface HungSuspectCapacityFinding {
  code: typeof HUNG_SUSPECT_CAPACITY_FINDING_CODE;
  hungSuspect: number;
  active: number;
  /** hungSuspect / active, or 0 when active is 0. */
  ratio: number;
  effectiveWorking: number;
  phantomActive: number;
}

/**
 * Evaluate hungSuspect capacity waste against a ledger snapshot. Returns a
 * finding when either absolute or ratio bound is exceeded, else null (so the
 * health block is only present when there is something to act on). Pure.
 */
export function evaluateHungSuspectCapacityFinding(
  ledger: Pick<CapacityLedger, 'byClass' | 'active' | 'effectiveWorking' | 'phantomActive'>,
  opts: { countBound?: number; ratioBound?: number } = {},
): HungSuspectCapacityFinding | null {
  const hungSuspect = ledger.byClass.hungSuspect;
  const active = ledger.active;
  const countBound = opts.countBound ?? DEFAULT_HUNG_SUSPECT_CAPACITY_COUNT_BOUND;
  const ratioBound = opts.ratioBound ?? DEFAULT_HUNG_SUSPECT_CAPACITY_RATIO_BOUND;
  if (hungSuspect <= 0) return null;
  const ratio = active > 0 ? hungSuspect / active : 0;
  if (hungSuspect < countBound && ratio < ratioBound) return null;
  return {
    code: HUNG_SUSPECT_CAPACITY_FINDING_CODE,
    hungSuspect,
    active,
    ratio,
    effectiveWorking: ledger.effectiveWorking,
    phantomActive: ledger.phantomActive,
  };
}
