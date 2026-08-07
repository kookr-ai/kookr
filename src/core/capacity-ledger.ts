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
  /**
   * Nominal utilization headline: `active / maxActiveTasks * 100` (0 when
   * `maxActiveTasks <= 0`). This is the figure that read "93.8% utilized
   * (15/16 active)" while 7–9 of 16 slots were phantom-held doing no work
   * (issue #2169). Kept for continuity, but always paired with
   * {@link effectiveUtilizationPct} so no consumer reads it in isolation.
   */
  utilizationPct: number;
  /**
   * Truthful utilization: `effectiveWorking / maxActiveTasks * 100` (0 when
   * `maxActiveTasks <= 0`). Counts only productively-occupied slots, so the
   * 15/16-nominal fleet with 8 working reads 50%, not 93.8% (issue #2169).
   * Velocity / throughput verdicts and the supply-aware idle signal MUST key
   * on this, never on {@link utilizationPct}.
   */
  effectiveUtilizationPct: number;
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

  // Utilization headlines (issue #2169). Nominal counts every occupied slot
  // (phantoms included) — the figure that masked 44–56% phantom hold behind a
  // "93.8% utilized" verdict. Effective counts only productive slots so
  // consumers can key throughput verdicts on real work, not held-but-idle slots.
  const utilizationPct = deps.maxActiveTasks > 0 ? (active / deps.maxActiveTasks) * 100 : 0;
  const effectiveUtilizationPct =
    deps.maxActiveTasks > 0 ? (effectiveWorking / deps.maxActiveTasks) * 100 : 0;

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
    utilizationPct,
    effectiveUtilizationPct,
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

// ---------------------------------------------------------------------------
// Effective-utilization throughput verdict (issue #2169)
//
// The external workflow-velocity probe read the NOMINAL `active` count and
// reported "capacity 93.8% utilized (15/16 active) — healthy_throughput" while
// 7–9 of 16 slots were phantom-held (finishedAwaitingAck + hungSuspect) doing
// no work. Real productive utilization was 37–50%. That did not merely
// mislead: it fed the #2143 supply-aware idle signal a "fleet is full" picture
// that suppressed the very idea-supply pressure a half-empty fleet needed —
// the masking loop the issue calls out.
//
// The fix is a first-class verdict keyed on EFFECTIVE occupancy: the fleet is
// `healthy_throughput` only when it has no idle *productive* slots; any
// effective headroom reads `idle_capacity`. Both utilization figures ride
// along so no downstream consumer has to re-derive (and mis-derive) the
// number. Pure — nothing here touches scheduling or launch admission.
// ---------------------------------------------------------------------------

export type CapacityThroughputVerdictCode = 'healthy_throughput' | 'idle_capacity';

/**
 * Effective-utilization throughput verdict (issue #2169). Always returned (it
 * is a headline, not a fires-only-on-defect finding), so a probe can read one
 * stable field instead of recomputing utilization from `active`.
 */
export interface CapacityThroughputVerdict {
  /**
   * `healthy_throughput` only when there are no idle *productive* slots;
   * otherwise `idle_capacity`. Keyed on {@link idleEffectiveSlots}, never on
   * nominal `active` — so 15/16 nominal with 8 working reads `idle_capacity`.
   */
  verdict: CapacityThroughputVerdictCode;
  /** Truthful headline: `effectiveWorking / maxActiveTasks * 100`. The verdict keys on this. */
  effectiveUtilizationPct: number;
  /** Nominal figure: `active / maxActiveTasks * 100`. Reported for continuity, never the key. */
  utilizationPct: number;
  effectiveWorking: number;
  phantomActive: number;
  active: number;
  maxActiveTasks: number;
  /**
   * Idle *productive* slots the verdict keys on:
   * `freeForGeneralSources ?? max(0, maxActiveTasks - effectiveWorking)`.
   * Uses the reservation-aware general-source view when present (issue #1564),
   * else the pure effective-free count — never nominal `free`, which would
   * hide phantom-held slots.
   */
  idleEffectiveSlots: number;
}

/**
 * Evaluate the effective-utilization throughput verdict against a ledger
 * snapshot (issue #2169). Pure. Keys strictly on effective (productive)
 * occupancy so a nominally-full fleet held open by phantoms never reads
 * `healthy_throughput`.
 */
export function evaluateCapacityThroughputVerdict(
  ledger: Pick<
    CapacityLedger,
    | 'maxActiveTasks'
    | 'active'
    | 'effectiveWorking'
    | 'phantomActive'
    | 'utilizationPct'
    | 'effectiveUtilizationPct'
    | 'freeForGeneralSources'
  >,
): CapacityThroughputVerdict {
  const idleEffectiveSlots =
    ledger.freeForGeneralSources ?? Math.max(0, ledger.maxActiveTasks - ledger.effectiveWorking);
  return {
    verdict: idleEffectiveSlots > 0 ? 'idle_capacity' : 'healthy_throughput',
    effectiveUtilizationPct: ledger.effectiveUtilizationPct,
    utilizationPct: ledger.utilizationPct,
    effectiveWorking: ledger.effectiveWorking,
    phantomActive: ledger.phantomActive,
    active: ledger.active,
    maxActiveTasks: ledger.maxActiveTasks,
    idleEffectiveSlots,
  };
}

// ---------------------------------------------------------------------------
// Supply-aware capacity signal (issue #2143)
//
// The orchestration supervisor kept flagging "sideways-on-capacity-fill": idle
// task slots with an empty queue while throughput sat at 300% of the PR/day
// target. Utilization is a valid proxy only while the queue has work; at
// `pendingQueueDepth == 0` with the vetted-idea stream exhausted, forcing
// utilization higher would only manufacture low-value substrate plumbing. So
// the idle-capacity finding must NOT warn on raw utilization — it keys on the
// actual scarce resource: vetted-idea *runway* (backlog depth ÷ consumption
// rate). Idle slots at/above target with an empty queue and healthy runway are
// unused headroom (info), not a defect. Pure reporting logic — nothing here
// touches scheduling or launch admission.
// ---------------------------------------------------------------------------

/** Vetted-idea supply operands for the runway metric (issue #2143). */
export interface VettedIdeaSupply {
  /**
   * Vetted-idea backlog depth: count of vetted / safe-to-autofile stalled work
   * waiting to be tasked (the numerator of the runway calculation).
   */
  backlogDepth: number;
  /** Recent consumption rate, in vetted ideas consumed per day (the denominator). */
  consumptionPerDay: number;
}

/**
 * Default vetted-idea runway floor: below this many days of supply, the
 * supervisor should trigger idea-supply work rather than chase utilization.
 */
export const DEFAULT_VETTED_IDEA_RUNWAY_FLOOR_DAYS = 2;

/**
 * Days of vetted-idea runway = `backlogDepth ÷ consumptionPerDay` (issue #2143).
 * Returns `null` when the operands are unavailable, negative, or consumption is
 * non-positive — in the last case runway is effectively unbounded (never a
 * shortfall), which the callers treat as "no runway signal" rather than 0.
 */
export function computeVettedIdeaRunwayDays(supply: VettedIdeaSupply | null | undefined): number | null {
  if (!supply) return null;
  const { backlogDepth, consumptionPerDay } = supply;
  if (!Number.isFinite(backlogDepth) || backlogDepth < 0) return null;
  if (!Number.isFinite(consumptionPerDay) || consumptionPerDay <= 0) return null;
  return backlogDepth / consumptionPerDay;
}

/** First-class metric of the vetted-idea runway for the capacity read (issue #2143). */
export interface VettedIdeaRunwayReport {
  /** Days of runway, or null when unavailable/unbounded (see {@link computeVettedIdeaRunwayDays}). */
  runwayDays: number | null;
  /** Floor the runway is judged against. */
  floorDays: number;
  /** True when runway is known and below the floor — supply is running dry. */
  shortfall: boolean;
  backlogDepth: number;
  consumptionPerDay: number;
}

/**
 * Build the first-class vetted-idea runway report (issue #2143). Names the
 * actual scarce resource — days of vetted-idea supply — so the supervisor can
 * trigger idea-supply work when `shortfall` instead of chasing utilization.
 * Returns null when the supply operands are unavailable. Pure.
 */
export function buildVettedIdeaRunwayReport(
  supply: VettedIdeaSupply | null | undefined,
  runwayFloorDays: number = DEFAULT_VETTED_IDEA_RUNWAY_FLOOR_DAYS,
): VettedIdeaRunwayReport | null {
  if (!supply) return null;
  const runwayDays = computeVettedIdeaRunwayDays(supply);
  return {
    runwayDays,
    floorDays: runwayFloorDays,
    shortfall: runwayDays !== null && runwayDays < runwayFloorDays,
    backlogDepth: supply.backlogDepth,
    consumptionPerDay: supply.consumptionPerDay,
  };
}

/** First-class finding code for idle (under-driven) capacity (issue #2143). */
export const IDLE_CAPACITY_FINDING_CODE = 'idle_capacity' as const;

/**
 * Severity of the idle-capacity finding. Reuses the `'info' | 'warning'` half of
 * {@link import('../shared/contracts/anomalies.js').AnomalySeverity} that
 * `operational-alert-rules` already uses on `/api/health` — the issue's "warn"
 * maps to `'warning'`.
 */
export type CapacityFindingSeverity = 'info' | 'warning';

/** Operator/supervisor-supplied inputs to the supply-aware capacity signal (issue #2143). */
export interface IdleCapacitySignalInputs {
  /** Recent PR/day throughput; null/undefined when unknown. */
  prsPerDay?: number | null;
  /** Configured PR/day target the throughput is judged against; null/undefined when unset. */
  targetPrsPerDay?: number | null;
  /** Vetted-idea supply operands for the runway metric. */
  vettedIdea?: VettedIdeaSupply | null;
  /** Runway floor in days (default {@link DEFAULT_VETTED_IDEA_RUNWAY_FLOOR_DAYS}). */
  runwayFloorDays?: number;
}

/**
 * A first-class health finding: there are idle task slots (capacity to fill).
 * Its `severity` names WHY, so the supervisor no longer has to re-derive intent
 * from raw utilization (issue #2143).
 */
export interface IdleCapacityFinding {
  code: typeof IDLE_CAPACITY_FINDING_CODE;
  severity: CapacityFindingSeverity;
  /** Idle general-source slots (`freeForGeneralSources ?? free`) that triggered the finding. */
  idleSlots: number;
  pendingQueueDepth: number;
  prsPerDay: number | null;
  targetPrsPerDay: number | null;
  /** True when throughput is known and at/above target. */
  atOrAboveThroughputTarget: boolean;
  /** Days of vetted-idea runway, or null when unavailable. */
  vettedIdeaRunwayDays: number | null;
  runwayFloorDays: number;
  /** True when runway is known and below the floor — the real scarce resource. */
  runwayShortfall: boolean;
  /** The actionable driver behind the severity. */
  driver: 'queue_backlog_idle' | 'runway_shortfall' | 'headroom_unused';
  /**
   * Truthful utilization at finding time: `effectiveWorking / max * 100`
   * (issue #2169), or null when the ledger did not carry it. Paired with
   * {@link utilizationPct} so the supply-aware signal reports effective — not
   * the nominal figure that masked phantom-held slots.
   */
  effectiveUtilizationPct: number | null;
  /** Nominal utilization: `active / max * 100`, or null when unavailable. Never read in isolation. */
  utilizationPct: number | null;
}

/**
 * Evaluate the idle-capacity finding against a ledger snapshot (issue #2143).
 *
 * Fires only when there are idle general-source slots (there is capacity to
 * fill), else returns null so the health block is present only when there is
 * something to observe. Severity keys on ACTIONABLE supply signals, NEVER on
 * raw utilization: idle slots at/above the PR/day target with an empty queue
 * and healthy vetted-idea runway are unused headroom, not a defect → `info`
 * (this ends the recurring "sideways-on-capacity-fill" false-positive stream).
 * It escalates to `warning` only when work is genuinely under-driven:
 *   - `queue_backlog_idle` — queued work is stranded behind idle slots
 *     (a real under-driving defect, independent of supply), or
 *   - `runway_shortfall` — the vetted-idea stream is running dry (runway below
 *     floor), the actual scarce resource the supervisor should act on.
 * Pure.
 */
export function evaluateIdleCapacityFinding(
  ledger: Pick<CapacityLedger, 'free' | 'freeForGeneralSources' | 'pendingQueueDepth'> &
    Partial<
      Pick<CapacityLedger, 'maxActiveTasks' | 'effectiveWorking' | 'effectiveUtilizationPct' | 'utilizationPct'>
    >,
  inputs: IdleCapacitySignalInputs = {},
): IdleCapacityFinding | null {
  // Idle slots key on EFFECTIVE occupancy (issue #2169): prefer the
  // reservation-aware general-source view (already phantom-excluded, #1935),
  // else the pure effective-free count, and only fall back to nominal `free`
  // when the ledger carries neither (older/partial callers). Nominal `free`
  // hides phantom-held slots — the masking this issue removes.
  const idleSlots =
    ledger.freeForGeneralSources ??
    (ledger.maxActiveTasks !== undefined && ledger.effectiveWorking !== undefined
      ? Math.max(0, ledger.maxActiveTasks - ledger.effectiveWorking)
      : ledger.free);
  if (idleSlots <= 0) return null;

  const prsPerDay = inputs.prsPerDay ?? null;
  const targetPrsPerDay = inputs.targetPrsPerDay ?? null;
  const runwayFloorDays = inputs.runwayFloorDays ?? DEFAULT_VETTED_IDEA_RUNWAY_FLOOR_DAYS;
  const vettedIdeaRunwayDays = computeVettedIdeaRunwayDays(inputs.vettedIdea);
  const runwayShortfall = vettedIdeaRunwayDays !== null && vettedIdeaRunwayDays < runwayFloorDays;
  const atOrAboveThroughputTarget =
    prsPerDay !== null && targetPrsPerDay !== null && prsPerDay >= targetPrsPerDay;

  let severity: CapacityFindingSeverity = 'info';
  let driver: IdleCapacityFinding['driver'] = 'headroom_unused';
  if (ledger.pendingQueueDepth > 0) {
    // Queued work behind idle slots is genuine under-driving, independent of supply.
    severity = 'warning';
    driver = 'queue_backlog_idle';
  } else if (runwayShortfall) {
    // The actual scarce resource: vetted-idea supply is running dry.
    severity = 'warning';
    driver = 'runway_shortfall';
  }

  return {
    code: IDLE_CAPACITY_FINDING_CODE,
    severity,
    idleSlots,
    pendingQueueDepth: ledger.pendingQueueDepth,
    prsPerDay,
    targetPrsPerDay,
    atOrAboveThroughputTarget,
    vettedIdeaRunwayDays,
    runwayFloorDays,
    runwayShortfall,
    driver,
    effectiveUtilizationPct: ledger.effectiveUtilizationPct ?? null,
    utilizationPct: ledger.utilizationPct ?? null,
  };
}

function parseFiniteNonNegative(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0) return null;
  return value;
}

/**
 * Resolve the supply-aware capacity signal inputs from environment
 * configuration (issue #2143). Every operand is operator/supervisor-supplied
 * (there is no in-process global PR/day or vetted-idea data source), and every
 * one is optional: absent or malformed values resolve to null so the finding
 * degrades to pure idle-slot observability. Pure — reads only the passed `env`.
 */
export function resolveIdleCapacitySignalInputs(
  env: Record<string, string | undefined>,
): IdleCapacitySignalInputs {
  const backlogDepth = parseFiniteNonNegative(env.KOOKR_VETTED_IDEA_BACKLOG);
  const consumptionPerDay = parseFiniteNonNegative(env.KOOKR_VETTED_IDEA_CONSUMPTION_PER_DAY);
  const runwayFloorDays = parseFiniteNonNegative(env.KOOKR_VETTED_IDEA_RUNWAY_FLOOR_DAYS);
  const vettedIdea =
    backlogDepth !== null && consumptionPerDay !== null ? { backlogDepth, consumptionPerDay } : null;
  return {
    prsPerDay: parseFiniteNonNegative(env.KOOKR_PRS_PER_DAY),
    targetPrsPerDay: parseFiniteNonNegative(env.KOOKR_TARGET_PRS_PER_DAY),
    vettedIdea,
    ...(runwayFloorDays !== null ? { runwayFloorDays } : {}),
  };
}
