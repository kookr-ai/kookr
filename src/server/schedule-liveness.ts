import { nextRun, minimumCronIntervalMs } from '../core/cron.js';
import { isTriggerLimitExhausted, type Schedule } from '../core/schedule.js';
import type { ServerMessage } from '../shared/contracts/messages.js';
import { OPERATIONAL_ALERT_AGENT_ID } from './operational-alert-rules.js';

/**
 * Per-schedule liveness / stale-alarm (issue #2694). Motivated by the
 * 2026-08-17→08-19 incident: the orchestration-supervisor schedule went dark —
 * it left NO ledger activity for two days — while every sibling schedule kept
 * firing normally. Nothing noticed for two days because the only liveness
 * signal we had, the {@link ScheduleDeadManSwitch}, is fleet-wide: its
 * window/starvation conditions look at whichever schedules DID produce ledger
 * entries, so a single silent schedule is masked by healthy siblings.
 *
 * This alarm closes that blind spot. It treats each enabled schedule's own
 * execution ledger as its heartbeat and asks a per-schedule question: given
 * this schedule's cron cadence, has it been silent far longer than it should
 * be? A schedule that fires hourly but has left no trace for two days is dark,
 * regardless of how healthy its siblings look.
 *
 * Evaluated from the schedule runner's existing 60s tick (no new interval),
 * right after the dead-man switch, so this tick's fires are already in the
 * ledger.
 *
 * Staleness rule (per enabled, non-exhausted schedule):
 *
 *   silenceMs  = now − lastActivity   (newest ledger entry, else the schedule's
 *                                      last cron/run watermark, else createdAt)
 *   maxGapMs   = the LONGEST legitimate gap between the schedule's fires (the
 *                widest quiet window its cron produces — e.g. the overnight gap
 *                of a business-hours cron, the weekend gap of a weekday cron)
 *   threshold  = max(maxGapMs × STALE_MISSED_FIRE_MULTIPLIER, staleFloorMs)
 *   stale      = silenceMs > threshold
 *
 * Using the LONGEST gap (not the average or the next-two-fire delta) is what
 * keeps this quiet for clustered crons: a `0 9-17 * * *` schedule has a real
 * 16h overnight window in which it legitimately leaves no ledger row, so its
 * cadence must be measured as 16h, not the 1h delta between two daytime fires,
 * or it would be flagged dark every night. The floor (default 6h, matching the
 * issue's ">6h" ask) prevents a fast schedule from alarming on a single missed
 * fire.
 *
 * Alert semantics: edge-triggered PER SCHEDULE — one `alert` ServerMessage
 * (severity `warning`, agentId `system`, operationalAlert key
 * `schedule:stale:<id>`) when a schedule crosses into staleness, and a matching
 * severity-`info` recovery alert when it produces fresh activity again (or is
 * disabled/deleted). Alert-only: no self-heal action is taken here, matching
 * the dead-man switch's deliberate scope.
 *
 * Scope of "dark": this alarm detects a schedule the runner has stopped
 * EVALUATING/firing entirely (no ledger row of any outcome for its whole quiet
 * window) — the #2694 failure. A schedule that keeps firing on cadence but
 * whose work is unproductive (a wedged task recording `previous_run_active`, a
 * broken launcher recording `dispatch_failed`) still writes ledger rows, so it
 * is NOT dark here — that class is the dead-man switch's consecutive-failure
 * condition. Deliberately, every skip row (`skipped_safe_mode`,
 * `skipped_draining`, …) counts as a heartbeat, which is exactly what keeps an
 * operator-paused or draining fleet from tripping this alarm.
 */

/**
 * How many expected fires a schedule must miss before it is considered dark.
 * Two consecutive misses is a strong "not firing" signal while still catching a
 * two-day outage of any sub-daily schedule well inside the window.
 */
export const STALE_MISSED_FIRE_MULTIPLIER = 2;

/**
 * Floor on the staleness threshold (ms). A schedule is never flagged before it
 * has been silent this long, regardless of cadence — mirrors the issue's ">6h"
 * heartbeat-stale threshold and keeps fast schedules from alarming on a single
 * blip.
 */
export const DEFAULT_STALE_SCHEDULE_FLOOR_MS = 6 * 60 * 60_000;

export interface StaleScheduleInfo {
  id: string;
  name: string;
  /** Wall time since the schedule's last observed activity (ms). */
  silenceMs: number;
  /** The longest legitimate gap between the schedule's fires (ms) — its widest quiet window. */
  maxGapMs: number;
  /** The staleness threshold applied to this schedule (ms). */
  thresholdMs: number;
}

export interface ScheduleStaleAlarmDeps {
  broadcast: (msg: ServerMessage) => void;
  /**
   * Optional durable sink for the fire/clear transition (issue #1709 WS0.3),
   * recorded BEFORE the broadcast so a dark episode that opens and clears while
   * no dashboard client is connected still leaves an on-disk trace. Mirrors the
   * dead-man switch's `recordTransition`.
   */
  recordTransition?: (alert: Extract<ServerMessage, { type: 'alert' }>) => void;
  /** Live getter for the staleness floor (ms). Falls back to {@link DEFAULT_STALE_SCHEDULE_FLOOR_MS}. A value <= 0 disables the alarm. */
  getStaleFloorMs?: () => number;
  /** Injectable clock (tests). */
  now?: () => Date;
}

export class ScheduleStaleAlarm {
  /**
   * Schedules currently in a firing (stale) episode, keyed by id → name, for
   * edge-triggering and so the recovery alert can name the schedule that
   * recovered (the id alone lives in `operationalAlert.key`).
   */
  private readonly firing = new Map<string, string>();
  private readonly deps: ScheduleStaleAlarmDeps;

  constructor(deps: ScheduleStaleAlarmDeps) {
    this.deps = deps;
  }

  /**
   * Evaluate one tick. Emits at most one fired alert per schedule per staleness
   * episode, and one recovery alert when that schedule fires again (or leaves
   * the enabled set entirely).
   */
  check(schedules: Schedule[]): void {
    const floorMs = this.resolveFloorMs();
    if (floorMs <= 0) {
      // Disabled: close every open episode with a recovery so the durable
      // trace never dangles on a `fired` with no matching `recovered` (a log
      // consumer reconstructing active alerts would otherwise show the
      // schedule stale forever). Then start clean for any future re-enable.
      for (const [id, name] of this.firing) {
        this.emit(buildStaleScheduleRecoveryAlert(id, name));
      }
      this.firing.clear();
      return;
    }

    const nowMs = (this.deps.now?.() ?? new Date()).getTime();
    const stale = evaluateScheduleLiveness(schedules, nowMs, floorMs);
    const staleById = new Map(stale.map((info) => [info.id, info]));

    for (const info of stale) {
      if (!this.firing.has(info.id)) {
        this.firing.set(info.id, info.name);
        this.emit(buildStaleScheduleAlert(info));
      }
    }

    // Recover any schedule that was firing but is no longer stale — including
    // one that has been disabled or deleted (absent from `staleById`).
    for (const [id, name] of [...this.firing]) {
      if (!staleById.has(id)) {
        this.firing.delete(id);
        this.emit(buildStaleScheduleRecoveryAlert(id, name));
      }
    }
  }

  /**
   * Point-in-time view of the schedules currently flagged dark, for surfacing
   * on a status/health snapshot (issue #2694). Empty when nothing is stale.
   */
  stats(): { staleCount: number; staleSchedules: Array<{ id: string; name: string }> } {
    const staleSchedules = [...this.firing].map(([id, name]) => ({ id, name }));
    return { staleCount: staleSchedules.length, staleSchedules };
  }

  /**
   * Record the transition to the durable sink (if configured) BEFORE
   * broadcasting, so the on-disk trace survives even if no dashboard client is
   * connected. The recorder is fire-and-forget: a throw from it must never
   * suppress the WS broadcast.
   */
  private emit(alert: Extract<ServerMessage, { type: 'alert' }>): void {
    try {
      this.deps.recordTransition?.(alert);
    } catch (err) {
      console.warn(
        '[schedule-liveness] recordTransition threw (ignored):',
        err instanceof Error ? err.message : String(err),
      );
    }
    this.deps.broadcast(alert);
  }

  private resolveFloorMs(): number {
    const value = this.deps.getStaleFloorMs?.();
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    return DEFAULT_STALE_SCHEDULE_FLOOR_MS;
  }
}

/**
 * Pure liveness evaluator — exported for direct unit testing. Returns the
 * enabled, non-exhausted schedules that have gone dark (silent beyond their
 * cadence-relative threshold), newest-silence first is not guaranteed; callers
 * key on `id`.
 */
export function evaluateScheduleLiveness(
  schedules: Schedule[],
  nowMs: number,
  floorMs: number = DEFAULT_STALE_SCHEDULE_FLOOR_MS,
): StaleScheduleInfo[] {
  const stale: StaleScheduleInfo[] = [];
  for (const schedule of schedules) {
    if (!schedule.enabled) continue;
    if (isTriggerLimitExhausted(schedule)) continue;

    const maxGapMs = maxCronGapMs(schedule.cron, nowMs);
    if (maxGapMs === null || maxGapMs <= 0) continue; // invalid/unparseable cadence

    const lastActivity = lastActivityMs(schedule);
    if (lastActivity === null) continue;

    const silenceMs = nowMs - lastActivity;
    if (silenceMs <= 0) continue;

    const thresholdMs = Math.max(maxGapMs * STALE_MISSED_FIRE_MULTIPLIER, floorMs);
    if (silenceMs > thresholdMs) {
      stale.push({ id: schedule.id, name: schedule.name, silenceMs, maxGapMs, thresholdMs });
    }
  }
  return stale;
}

/** Walk at most this many fires forward when measuring a cron's widest gap. */
const MAX_GAP_SAMPLES = 50;
/** Stop walking once the sampled fires span at least this long (captures weekly / monthly). */
const MAX_GAP_HORIZON_MS = 14 * 24 * 60 * 60_000;

/**
 * The LONGEST legitimate gap between a schedule's fires — its widest quiet
 * window. Walks fire times forward from `fromMs` and returns the maximum
 * consecutive gap, so a clustered cron (business hours, weekday-only) reports
 * its real overnight/weekend gap rather than the small delta between two
 * adjacent daytime fires. The walk is bounded two ways: it stops after
 * {@link MAX_GAP_SAMPLES} fires (so a fast cron like hourly doesn't loop
 * forever) and once the sampled fires span {@link MAX_GAP_HORIZON_MS} (so a
 * weekly/monthly cron's single long gap is captured without walking a year of
 * hourly fires). Falls back to the minimum intra-day interval, then null for an
 * unparseable cron.
 */
function maxCronGapMs(cron: string, fromMs: number): number | null {
  let prev = nextRun(cron, new Date(fromMs));
  if (!prev) return minimumCronIntervalMs(cron);

  const firstMs = prev.getTime();
  let maxGap = 0;
  let count = 1;
  while (count < MAX_GAP_SAMPLES) {
    const next = nextRun(cron, prev);
    if (!next) break;
    const gap = next.getTime() - prev.getTime();
    if (gap > maxGap) maxGap = gap;
    prev = next;
    count += 1;
    // Enough coverage once we hold at least one gap AND have spanned the
    // horizon — captures the single long gap of a weekly/monthly cron.
    if (count >= 2 && next.getTime() - firstMs >= MAX_GAP_HORIZON_MS) break;
  }

  if (maxGap > 0) return maxGap;
  return minimumCronIntervalMs(cron);
}

/**
 * Newest observed activity for a schedule — its heartbeat. The freshest of any
 * ledger entry's `evaluatedAt` and the schedule's cron/run watermarks, with
 * `createdAt` as the baseline so a never-fired schedule measures silence from
 * when we started watching it rather than the epoch. Returns null only if
 * nothing parses.
 */
function lastActivityMs(schedule: Schedule): number | null {
  let latest = Number.NEGATIVE_INFINITY;
  const consider = (iso: string | undefined): void => {
    if (!iso) return;
    const ms = Date.parse(iso);
    if (Number.isFinite(ms) && ms > latest) latest = ms;
  };

  for (const entry of schedule.executionLedger) consider(entry.evaluatedAt);
  consider(schedule.lastCronEvaluatedAt);
  consider(schedule.lastScheduledFor);
  consider(schedule.lastRunAt);
  consider(schedule.createdAt);

  return latest === Number.NEGATIVE_INFINITY ? null : latest;
}

function buildStaleScheduleAlert(info: StaleScheduleInfo): Extract<ServerMessage, { type: 'alert' }> {
  const silentH = (info.silenceMs / 3_600_000).toFixed(1);
  const maxGapMin = Math.round(info.maxGapMs / 60_000);
  return {
    type: 'alert',
    agentId: OPERATIONAL_ALERT_AGENT_ID,
    summary: `Schedule "${info.name}" has gone dark — no activity for ${silentH}h`,
    details:
      `Schedule liveness alarm (issue #2694): "${info.name}" is enabled but has left no ` +
      `execution-ledger activity for ${silentH}h, well past its longest normal ${maxGapMin}-minute gap between fires ` +
      `(threshold ${Math.round(info.thresholdMs / 60_000)}m). A dark slot-filler leaves the queue ` +
      'unfed while capacity sits idle. Check `kookr schedule list` / the schedules panel: confirm the ' +
      'schedule is still firing (not held, crashed, or silently early-returning) and inspect its ' +
      'execution ledger. This alert is raised once per dark episode and clears when the schedule ' +
      'produces fresh activity. No automatic remediation is taken (alert-only by design).',
    severity: 'warning',
    operationalAlert: {
      key: `schedule:stale:${info.id}`,
      metric: 'schedule_liveness',
      state: 'fired',
    },
  };
}

function buildStaleScheduleRecoveryAlert(scheduleId: string, name: string): Extract<ServerMessage, { type: 'alert' }> {
  return {
    type: 'alert',
    agentId: OPERATIONAL_ALERT_AGENT_ID,
    summary: `Recovered: schedule "${name}" is producing activity again`,
    details:
      `Schedule liveness alarm cleared for "${name}": it produced fresh execution-ledger activity ` +
      '(or was disabled/removed), so it is no longer silent beyond its cadence threshold.',
    severity: 'info',
    operationalAlert: {
      key: `schedule:stale:${scheduleId}`,
      metric: 'schedule_liveness',
      state: 'recovered',
    },
  };
}
