/**
 * Delivery-aware loop watchdog (issue #1902, WS2.4 of the #1699 self-sustaining
 * loop engine; complements #1545's hang-proof delivery tail).
 *
 * A self-sustaining loop can be "delivered-then-hung": it keeps producing
 * activity (tokens, hook events, pane churn) yet makes no forward DELIVERY
 * progress — no new commit, no PR opened, nothing merged. Silence-only
 * watchdogs can't see this: `hung-task-reaper` and the `resource-watchdog-*`
 * family judge liveness / host resources, not delivery, so a chatty-but-
 * unproductive loop reads as perfectly healthy, and — worse — a quiet-but-
 * progressing loop (an agent thinking hard between merges) reads as suspicious.
 *
 * This module judges a loop on POSITIVE DELIVERY PROGRESS with hysteresis. It
 * is fed a monotonic {@link DeliverySnapshot} (cumulative commits / PRs opened /
 * PRs merged) once per loop iteration. If the snapshot advanced since the
 * previous sample the loop is progressing; if it stays unchanged for
 * `noProgressSamples` CONSECUTIVE samples the loop is flagged. It NEVER inspects
 * token / hook / pane activity, so:
 *   - silence alone can never flag a loop (silence is not even an input), and
 *   - a loop that is quiet but still advancing its delivery counters is never
 *     flagged.
 *
 * Hysteresis mirrors {@link ../server/websocket-load-shed.ts}: entering the
 * flagged state requires N consecutive no-progress samples, and leaving it
 * requires M consecutive progress samples, so a loop oscillating around the
 * boundary can't flap the flag every iteration.
 */

/**
 * A point-in-time snapshot of a loop's cumulative delivery counters. Every
 * field is MONOTONIC non-decreasing over a single loop's life — the watchdog
 * treats any increase as delivery progress and never reads absolute values.
 */
export interface DeliverySnapshot {
  /** Cumulative commits attributable to the loop's delivery. */
  commits: number;
  /** Cumulative count of PRs the loop has opened. */
  prsOpened: number;
  /** Cumulative count of the loop's opened PRs that have merged. */
  prsMerged: number;
}

/** Default consecutive no-progress samples before a loop is flagged. */
export const DEFAULT_LOOP_DELIVERY_NO_PROGRESS_SAMPLES = 3;

/** Default consecutive progress samples before a flagged loop is cleared. */
export const DEFAULT_LOOP_DELIVERY_RECOVER_SAMPLES = 2;

export interface LoopDeliveryWatchdogConfig {
  /**
   * Consecutive no-progress samples required to FLAG a loop. `0` disables the
   * watchdog entirely (mirrors the `KOOKR_*=0` opt-out convention used by the
   * WS load-shed gate). Must be a positive integer to enable.
   */
  noProgressSamples: number;
  /** Consecutive progress samples required to CLEAR a flagged loop. */
  recoverSamples: number;
}

/** Why {@link LoopDeliveryWatchdog.noteSample} returned the result it did. */
export type LoopDeliverySampleReason =
  /** Watchdog disabled (`noProgressSamples <= 0`). */
  | 'disabled'
  /** No snapshot available this sample (source unreadable) — streaks unchanged. */
  | 'no_sample'
  /** First snapshot; established the baseline, no progress judgement possible yet. */
  | 'baseline'
  /** Snapshot advanced — a progress sample. */
  | 'progressing'
  /** Snapshot unchanged — a no-progress sample. */
  | 'no_progress'
  /** No-progress streak reached the threshold: the flag ENGAGED this sample. */
  | 'flagged'
  /** Progress streak reached the recover threshold: the flag CLEARED this sample. */
  | 'cleared';

export interface LoopDeliverySampleResult {
  /** The watchdog's flagged state AFTER processing this sample. */
  flagged: boolean;
  /** True only on the sample where `flagged` flipped (engage or clear). */
  transitioned: boolean;
  reason: LoopDeliverySampleReason;
  /** Consecutive no-progress samples counted so far (0 while progressing). */
  consecutiveNoProgress: number;
}

/** True when `next` advanced ANY delivery counter beyond `prev`. */
export function hasDeliveryProgress(prev: DeliverySnapshot, next: DeliverySnapshot): boolean {
  return (
    next.commits > prev.commits
    || next.prsOpened > prev.prsOpened
    || next.prsMerged > prev.prsMerged
  );
}

/**
 * `GitHubReference.detectedFrom` sentinel for a PR reference extracted from the
 * task PROMPT rather than the agent's own activity. A prompt-cited PR is not
 * the loop's delivery, so it is excluded from the counts — mirroring the
 * delivered-completion selector (#1560), where attributing a merely-referenced
 * PR would misjudge a live loop that only mentions an already-merged PR.
 */
export const PROMPT_DETECTED_FROM = 'prompt';

export interface DeliveredPrCounts {
  /** Non-prompt PR references the loop has opened. */
  prsOpened: number;
  /** Of those, how many have merged. */
  prsMerged: number;
}

/**
 * Count a loop's own opened/merged PRs from its tracked PR references, excluding
 * prompt-cited ones. Pure so the exclusion rule is unit-testable without a live
 * `GitHubStateStore`. The `commits` half of a {@link DeliverySnapshot} is sourced
 * separately (branch commit count) — it, not PR milestones, is what advances
 * during the dominant "iterate on an open PR until merge" phase.
 */
export function countDeliveredPullRequests(
  prs: ReadonlyArray<{ status: string; detectedFrom: string }>,
): DeliveredPrCounts {
  let prsOpened = 0;
  let prsMerged = 0;
  for (const pr of prs) {
    if (pr.detectedFrom === PROMPT_DETECTED_FROM) continue;
    prsOpened += 1;
    if (pr.status === 'merged') prsMerged += 1;
  }
  return { prsOpened, prsMerged };
}

function readPositiveInt(raw: string | undefined, fallback: number): number {
  if (raw == null || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) return fallback;
  return parsed;
}

/** `0` is the sentinel opt-out for `noProgressSamples`; anything else must be `>= 1`. */
function readNoProgressSamples(raw: string | undefined, fallback: number): number {
  if (raw == null || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) return fallback;
  return parsed;
}

/**
 * Read watchdog thresholds from the environment. Invalid or blank values fall
 * back to the documented defaults; `KOOKR_LOOP_DELIVERY_NO_PROGRESS_SAMPLES=0`
 * disables the watchdog.
 */
export function readLoopDeliveryWatchdogConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): LoopDeliveryWatchdogConfig {
  return {
    noProgressSamples: readNoProgressSamples(
      env.KOOKR_LOOP_DELIVERY_NO_PROGRESS_SAMPLES,
      DEFAULT_LOOP_DELIVERY_NO_PROGRESS_SAMPLES,
    ),
    recoverSamples: readPositiveInt(
      env.KOOKR_LOOP_DELIVERY_RECOVER_SAMPLES,
      DEFAULT_LOOP_DELIVERY_RECOVER_SAMPLES,
    ),
  };
}

/**
 * Pure, synchronous per-loop hysteresis tracker — no I/O, no timers, no clock.
 * One instance per loop. `noteSample` is called once per loop iteration with
 * that iteration's cumulative {@link DeliverySnapshot}.
 */
export class LoopDeliveryWatchdog {
  private readonly config: LoopDeliveryWatchdogConfig;
  private last: DeliverySnapshot | null = null;
  private noProgressStreak = 0;
  private progressStreak = 0;
  private flagged = false;

  constructor(config: LoopDeliveryWatchdogConfig) {
    this.config = config;
  }

  get isFlagged(): boolean {
    return this.flagged;
  }

  get consecutiveNoProgress(): number {
    return this.noProgressStreak;
  }

  /**
   * Feed one delivery snapshot. A disabled watchdog never flags. A missing
   * snapshot (`null`/`undefined`, e.g. the delivery source was momentarily
   * unreadable) leaves the streaks untouched — missing data must never itself
   * flag a loop, exactly as the load-shed gate refuses to shed on a missing
   * event-loop sample.
   */
  noteSample(snapshot: DeliverySnapshot | null | undefined): LoopDeliverySampleResult {
    if (!(this.config.noProgressSamples > 0)) {
      this.flagged = false;
      return this.result(false, 'disabled');
    }
    if (snapshot == null) {
      return this.result(false, 'no_sample');
    }

    // First snapshot establishes the baseline; no progress judgement is
    // possible without a predecessor, so no streak moves.
    if (this.last === null) {
      this.last = snapshot;
      return this.result(false, 'baseline');
    }

    const progressed = hasDeliveryProgress(this.last, snapshot);
    this.last = snapshot;

    if (progressed) {
      this.progressStreak += 1;
      this.noProgressStreak = 0;
      if (this.flagged && this.progressStreak >= this.config.recoverSamples) {
        this.flagged = false;
        return this.result(true, 'cleared');
      }
      return this.result(false, 'progressing');
    }

    this.noProgressStreak += 1;
    this.progressStreak = 0;
    if (!this.flagged && this.noProgressStreak >= this.config.noProgressSamples) {
      this.flagged = true;
      return this.result(true, 'flagged');
    }
    return this.result(false, 'no_progress');
  }

  private result(transitioned: boolean, reason: LoopDeliverySampleReason): LoopDeliverySampleResult {
    return {
      flagged: this.flagged,
      transitioned,
      reason,
      consecutiveNoProgress: this.noProgressStreak,
    };
  }
}

/**
 * Manages one {@link LoopDeliveryWatchdog} per task id. Watchdogs are created
 * lazily on first {@link sample}; call {@link retain} once per liveness tick
 * with the ids of loops still running so terminated loops don't leak.
 */
export class LoopDeliveryWatchdogRegistry {
  private readonly config: LoopDeliveryWatchdogConfig;
  private readonly watchdogs = new Map<string, LoopDeliveryWatchdog>();

  constructor(config: LoopDeliveryWatchdogConfig) {
    this.config = config;
  }

  /** True when the watchdog is enabled (a `0` threshold disables it globally). */
  get enabled(): boolean {
    return this.config.noProgressSamples > 0;
  }

  /** Feed one sample for a task, creating its watchdog on first use. */
  sample(taskId: string, snapshot: DeliverySnapshot | null | undefined): LoopDeliverySampleResult {
    let watchdog = this.watchdogs.get(taskId);
    if (!watchdog) {
      watchdog = new LoopDeliveryWatchdog(this.config);
      this.watchdogs.set(taskId, watchdog);
    }
    return watchdog.noteSample(snapshot);
  }

  isFlagged(taskId: string): boolean {
    return this.watchdogs.get(taskId)?.isFlagged ?? false;
  }

  /** Task ids whose loops are currently flagged. */
  flaggedTaskIds(): string[] {
    const ids: string[] = [];
    for (const [taskId, watchdog] of this.watchdogs) {
      if (watchdog.isFlagged) ids.push(taskId);
    }
    return ids;
  }

  /** Drop a single task's watchdog (e.g. its loop reached a terminal status). */
  forget(taskId: string): void {
    this.watchdogs.delete(taskId);
  }

  /** Drop every watchdog whose task id is not in `activeTaskIds`. */
  retain(activeTaskIds: Iterable<string>): void {
    const keep = activeTaskIds instanceof Set ? activeTaskIds : new Set(activeTaskIds);
    for (const taskId of this.watchdogs.keys()) {
      if (!keep.has(taskId)) this.watchdogs.delete(taskId);
    }
  }

  /** Number of tracked watchdogs. */
  get size(): number {
    return this.watchdogs.size;
  }
}

export function createLoopDeliveryWatchdogRegistry(
  config: LoopDeliveryWatchdogConfig,
): LoopDeliveryWatchdogRegistry {
  return new LoopDeliveryWatchdogRegistry(config);
}

/** Minimal loop shape the prune helper reads. */
interface PrunableLoopTask {
  id: string;
  ralphLoop?: { status: string } | undefined;
}

/**
 * Drop watchdog entries whose loop is no longer ACTIVE (issue #1902). A loop is
 * active while `running` or `paused` — a paused loop keeps its watchdog so a
 * resume continues the same streak/flag instead of restarting the baseline and
 * losing an engaged flag. Terminal loops (completed/failed/cancelled) and gone
 * tasks are pruned. No-op when the registry is disabled.
 */
export function pruneLoopDeliveryWatchdog(
  tasks: Iterable<PrunableLoopTask>,
  registry: Pick<LoopDeliveryWatchdogRegistry, 'enabled' | 'retain'>,
): void {
  if (!registry.enabled) return;
  const active = new Set<string>();
  for (const task of tasks) {
    const status = task.ralphLoop?.status;
    if (status === 'running' || status === 'paused') active.add(task.id);
  }
  registry.retain(active);
}
