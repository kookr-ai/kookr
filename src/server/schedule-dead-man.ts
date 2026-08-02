import type { Schedule, ScheduleExecutionLedgerEntry, ScheduleExecutionOutcome } from '../core/schedule.js';
import type { ServerMessage } from '../shared/contracts/messages.js';
import { OPERATIONAL_ALERT_AGENT_ID } from './operational-alert-rules.js';

/**
 * In-server dead-man switch for scheduled-task starvation (issue #1526 Phase
 * C, deliverable C1-2). Motivated by the 2026-07-24 incident: scheduled
 * watchdogs were starved for 7+ hours and NOTHING noticed — every failure was
 * recorded faithfully in the execution ledger, but no component ever looked
 * at the ledger and raised its hand.
 *
 * Evaluated from the schedule runner's existing 60s tick (no new interval).
 * Two starvation conditions:
 *
 * (a) CONSECUTIVE-FAILURE: any enabled schedule's last
 *     {@link DEAD_MAN_CONSECUTIVE_FAILURES} ledger outcomes are all
 *     capacity/dispatch failures (`dispatch_failed`, `queued_capacity`,
 *     `skipped_coalesced`). Note `queued_capacity` entries are UPDATED to
 *     `completed` when their task eventually runs, so a persistent
 *     `queued_capacity` tail genuinely means "queued and never launched".
 *
 * (b) WINDOW: fires were due within the dead-man window (some enabled
 *     schedule has a ledger entry evaluated inside it) but NO scheduled
 *     execution was dispatched or completed in that window. "Dispatched"
 *     (`running`) deliberately counts as healthy: a fire that launched a
 *     long-running task is a slow task, not scheduler starvation.
 *     `skipped_draining` / `skipped_safe_mode` entries are ignored entirely —
 *     an operator drain or automation kill-switch (issue #1710) is
 *     intentional and must not trip the dead man.
 *
 * Alert semantics: edge-triggered, one `alert` ServerMessage (severity
 * `warning`, agentId `system`, operationalAlert key `schedule:dead_man`) per
 * continuous starvation episode; a matching severity-`info` recovery alert
 * when the episode clears (a scheduled execution completing updates the
 * ledger, which clears both conditions).
 *
 * Bounded self-heal (issue #1903, WS2.5 of #1699, remaining "+ bounded
 * self-heal" of #1526 C1): when a {@link ScheduleDeadManDeps.selfHeal} action
 * is wired, the switch does more than alert. On the starving edge and on each
 * subsequent still-starving tick it forces the starving schedule(s) to re-fire
 * (out of cron cadence) up to a hard per-episode cap
 * ({@link DEAD_MAN_SELF_HEAL_MAX_ATTEMPTS}). Because `check` runs once per
 * dead-man tick, attempts are naturally spaced one tick apart — a transient
 * stall (a capacity slot freeing, a blocking task aging out) gets a full tick
 * interval to clear between re-fires. If a re-fire gets work flowing again the
 * episode clears normally (counted a self-heal success). If the cap is
 * exhausted while still starving the switch escalates ONCE to a standing,
 * severity-`critical` alert on the same key and stops re-firing — a bounded
 * loop, never an infinite restart loop. Attempt/success counters are exposed
 * via {@link ScheduleDeadManSwitch.stats}. With no `selfHeal` wired the switch
 * is alert-only exactly as before (back-compat).
 */
export const DEAD_MAN_CONSECUTIVE_FAILURES = 3;

/**
 * Hard cap on self-heal kicks per starvation episode before the switch stops
 * kicking and escalates to a standing durable alert (issue #1903). Bounds the
 * remediation so a genuinely-stuck scheduler (e.g. capacity exhausted) cannot
 * spin the runner forever — it gets a few kicks, then an operator.
 */
export const DEAD_MAN_SELF_HEAL_MAX_ATTEMPTS = 3;

/** Mirrors the `deadManScheduleMinutes` settings default (120m; range 30–1440). */
export const DEFAULT_DEAD_MAN_SCHEDULE_MS = 120 * 60_000;

/** Outcomes that count as a capacity/dispatch failure for condition (a). */
const STARVATION_OUTCOMES: ReadonlySet<ScheduleExecutionOutcome> = new Set([
  'dispatch_failed',
  'queued_capacity',
  'skipped_coalesced',
]);

/** Outcomes proving the launch pipeline dispatched real work (condition (b)). */
const HEALTHY_OUTCOMES: ReadonlySet<ScheduleExecutionOutcome> = new Set([
  'running',
  'completed',
  'cancelled',
]);

export interface ScheduleDeadManDeps {
  broadcast: (msg: ServerMessage) => void;
  /**
   * Optional durable sink for fire/clear transitions (issue #1709). Called with
   * the same alert that is broadcast, so a transition that happens while no
   * client is listening still leaves an on-disk trace. Fire-and-forget: it must
   * not throw, and never gates the WS broadcast.
   */
  recordTransition?: (alert: Extract<ServerMessage, { type: 'alert' }>) => void;
  /**
   * Bounded self-heal action invoked on the starving edge and on each
   * subsequent still-starving tick while attempts remain under the cap (issue
   * #1903), passed the ids of the starving schedules to remediate. The wired
   * action forces those schedules to re-fire out of cron cadence (a runner
   * re-fire), but the switch treats it opaquely. Fire-and-forget: it must not
   * throw (a throw is caught and logged) and its return value is ignored;
   * success is measured by the NEXT tick observing recovery, not by the action
   * itself. It runs at most once per dead-man tick, so a transient stall has a
   * full tick interval to clear between attempts. Absent means alert-only
   * (back-compat) and disables escalation.
   */
  selfHeal?: (scheduleIds: string[]) => void;
  /**
   * Live getter for the per-episode self-heal attempt cap (issue #1903). Falls
   * back to {@link DEAD_MAN_SELF_HEAL_MAX_ATTEMPTS}. A value of `0` escalates on
   * the first still-starving tick without kicking.
   */
  getSelfHealMaxAttempts?: () => number;
  /** Live getter for the dead-man window (ms). Falls back to {@link DEFAULT_DEAD_MAN_SCHEDULE_MS}. */
  getDeadManMs?: () => number;
  /** Injectable clock (tests). */
  now?: () => Date;
}

interface StarvationVerdict {
  starving: boolean;
  reason?: string;
  /** Ids of the enabled schedules the verdict deems starving — the self-heal re-fire targets. */
  scheduleIds?: string[];
}

/**
 * Observable self-heal counters (issue #1903). Cumulative totals are for
 * operator observability (surfaced on the schedule status snapshot / health);
 * `episodeAttempts` and `escalated` describe the in-flight episode.
 */
export interface ScheduleDeadManStats {
  /** Cumulative self-heal kicks attempted across all episodes. */
  attempts: number;
  /** Cumulative episodes healed by self-heal within the cap (recovered after ≥1 kick, pre-escalation). */
  successes: number;
  /** Kicks attempted in the current episode (0 when not starving). */
  episodeAttempts: number;
  /** True once the current episode has exhausted the cap and escalated. */
  escalated: boolean;
  /** True while a starvation episode is in flight. */
  firing: boolean;
}

export class ScheduleDeadManSwitch {
  private firing = false;
  /** Kicks attempted in the current episode; bounds the cap. Reset on clear. */
  private episodeAttempts = 0;
  /** Whether the current episode has escalated (so escalation emits once). */
  private escalated = false;
  /** Reason captured on the starving edge, reused for the escalation alert. */
  private episodeReason = '';
  /** Cumulative self-heal counters, exposed via {@link stats}. */
  private totalAttempts = 0;
  private totalSuccesses = 0;
  private readonly deps: ScheduleDeadManDeps;

  constructor(deps: ScheduleDeadManDeps) {
    this.deps = deps;
  }

  /**
   * Evaluate one tick. Broadcasts at most one alert per state transition
   * (fired on the healthy→starving edge, recovered on the way back) and, when a
   * self-heal action is wired, kicks the runner up to the per-episode cap before
   * escalating to a standing durable alert (issue #1903).
   */
  check(schedules: Schedule[]): void {
    const nowMs = (this.deps.now?.() ?? new Date()).getTime();
    const windowMs = this.resolveWindowMs();
    const verdict = evaluateScheduleStarvation(schedules, nowMs, windowMs);

    if (verdict.starving) {
      if (!this.firing) {
        // healthy → starving edge: open the episode and raise the warning once.
        this.firing = true;
        this.episodeAttempts = 0;
        this.escalated = false;
        this.episodeReason = verdict.reason ?? 'scheduled executions are starving';
        this.emit(buildScheduleStarvationAlert(this.episodeReason, windowMs));
      }
      // Attempt a bounded self-heal on the edge tick AND every still-starving
      // tick thereafter, escalating once the cap is exhausted.
      this.maybeSelfHeal(windowMs, verdict.scheduleIds ?? []);
      return;
    }

    if (this.firing) {
      // starving → healthy edge. A recovery after ≥1 re-fire and before
      // escalating is attributed to self-heal; recovery after escalation
      // (operator action) is not — the recovery-alert copy and the success
      // counter agree.
      const healedBySelfHeal = this.episodeAttempts > 0 && !this.escalated;
      const attempts = this.episodeAttempts;
      this.firing = false;
      this.episodeAttempts = 0;
      this.escalated = false;
      if (healedBySelfHeal) {
        this.totalSuccesses += 1;
        console.log(`[schedule-dead-man] starvation cleared after ${attempts} self-heal attempt(s)`);
      }
      this.emit(buildScheduleStarvationRecoveryAlert(healedBySelfHeal ? attempts : 0));
    }
  }

  /** Current self-heal counters (issue #1903), for health/observability. */
  stats(): ScheduleDeadManStats {
    return {
      attempts: this.totalAttempts,
      successes: this.totalSuccesses,
      episodeAttempts: this.episodeAttempts,
      escalated: this.escalated,
      firing: this.firing,
    };
  }

  /**
   * Bounded self-heal step (issue #1903). Forces the starving schedule(s) to
   * re-fire while under the cap, then escalates ONCE to a standing durable alert
   * and stops. Called once per dead-man tick, so attempts are spaced one tick
   * apart. No-op when no self-heal action is wired (alert-only back-compat).
   */
  private maybeSelfHeal(windowMs: number, scheduleIds: string[]): void {
    if (!this.deps.selfHeal) return;
    const cap = this.resolveSelfHealCap();

    if (this.episodeAttempts < cap) {
      this.episodeAttempts += 1;
      this.totalAttempts += 1;
      console.warn(
        `[schedule-dead-man] self-heal attempt ${this.episodeAttempts}/${cap} (forcing re-fire): ${this.episodeReason}`,
      );
      try {
        this.deps.selfHeal(scheduleIds);
      } catch (err) {
        console.warn(
          '[schedule-dead-man] selfHeal threw (ignored):',
          err instanceof Error ? err.message : String(err),
        );
      }
      return;
    }

    if (!this.escalated) {
      this.escalated = true;
      console.error(
        `[schedule-dead-man] self-heal exhausted after ${this.episodeAttempts} attempt(s); escalating to a standing alert`,
      );
      this.emit(buildScheduleStarvationEscalationAlert(this.episodeReason, windowMs, this.episodeAttempts));
    }
  }

  private resolveSelfHealCap(): number {
    const value = this.deps.getSelfHealMaxAttempts?.();
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.floor(value);
    return DEAD_MAN_SELF_HEAL_MAX_ATTEMPTS;
  }

  /**
   * Record the transition to the durable sink (if configured) BEFORE
   * broadcasting, so the on-disk trace is written even if the broadcast path is
   * somehow lossy. The recorder is fire-and-forget; a throw from it (a future
   * alternate emitter, a bug) must never suppress the WS broadcast, so it is
   * guarded here rather than trusting caller discipline.
   */
  private emit(alert: Extract<ServerMessage, { type: 'alert' }>): void {
    try {
      this.deps.recordTransition?.(alert);
    } catch (err) {
      console.warn(
        '[schedule-dead-man] recordTransition threw (ignored):',
        err instanceof Error ? err.message : String(err),
      );
    }
    this.deps.broadcast(alert);
  }

  private resolveWindowMs(): number {
    const value = this.deps.getDeadManMs?.();
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
    return DEFAULT_DEAD_MAN_SCHEDULE_MS;
  }
}

/**
 * Pure starvation evaluator — exported for direct unit testing.
 */
export function evaluateScheduleStarvation(
  schedules: Schedule[],
  nowMs: number,
  windowMs: number,
): StarvationVerdict {
  const enabled = schedules.filter((schedule) => schedule.enabled);

  // Condition (a): consecutive capacity/dispatch failures. Collect EVERY
  // schedule in this state (issue #1903) — a single episode's self-heal cap must
  // be shared across all starving schedules, not spent re-firing only the first
  // one encountered while the rest stay starved (matches condition (b), which
  // already accumulates all windowed ids).
  const consecutiveFailureIds: string[] = [];
  let firstConsecutiveReason: string | undefined;
  for (const schedule of enabled) {
    const relevant = schedule.executionLedger.filter(
      (entry) => entry.outcome !== 'skipped_draining' && entry.outcome !== 'skipped_safe_mode',
    );
    if (relevant.length < DEAD_MAN_CONSECUTIVE_FAILURES) continue;
    const tail = relevant.slice(-DEAD_MAN_CONSECUTIVE_FAILURES);
    if (tail.every((entry) => STARVATION_OUTCOMES.has(entry.outcome))) {
      consecutiveFailureIds.push(schedule.id);
      if (firstConsecutiveReason === undefined) {
        const outcomes = tail.map((entry) => entry.outcome).join(', ');
        firstConsecutiveReason = `schedule "${schedule.name}" — last ${DEAD_MAN_CONSECUTIVE_FAILURES} outcomes were capacity/dispatch failures (${outcomes})`;
      }
    }
  }
  if (consecutiveFailureIds.length > 0) {
    const more = consecutiveFailureIds.length - 1;
    return {
      starving: true,
      reason:
        more > 0
          ? `${firstConsecutiveReason} (+${more} other schedule(s) also starving)`
          : (firstConsecutiveReason as string),
      scheduleIds: consecutiveFailureIds,
    };
  }

  // Condition (b): fires were due in the window, none dispatched/completed.
  const windowStart = nowMs - windowMs;
  const windowed: ScheduleExecutionLedgerEntry[] = [];
  const windowedScheduleIds = new Set<string>();
  for (const schedule of enabled) {
    for (const entry of schedule.executionLedger) {
      if (entry.outcome === 'skipped_draining' || entry.outcome === 'skipped_safe_mode') continue;
      const evaluatedAtMs = Date.parse(entry.evaluatedAt);
      if (Number.isFinite(evaluatedAtMs) && evaluatedAtMs >= windowStart) {
        windowed.push(entry);
        windowedScheduleIds.add(schedule.id);
      }
    }
  }
  if (windowed.length > 0 && !windowed.some((entry) => HEALTHY_OUTCOMES.has(entry.outcome))) {
    return {
      starving: true,
      reason: `${windowed.length} scheduled fire(s) were due in the last ${Math.round(windowMs / 60_000)}m and none was dispatched or completed`,
      scheduleIds: [...windowedScheduleIds],
    };
  }

  return { starving: false };
}

function buildScheduleStarvationAlert(reason: string, windowMs: number): Extract<ServerMessage, { type: 'alert' }> {
  return {
    type: 'alert',
    agentId: OPERATIONAL_ALERT_AGENT_ID,
    summary: `Scheduled tasks are starving: ${reason}`,
    details:
      `Dead-man switch (issue #1526 Phase C): ${reason}. ` +
      `Window: ${Math.round(windowMs / 60_000)} minutes (deadManScheduleMinutes setting). ` +
      'Inspect /api/health capacity ledger and the schedules panel; free capacity or fix the launch pipeline. ' +
      'This alert is raised once per starvation episode and clears when a scheduled execution completes. ' +
      `A bounded self-heal (up to ${DEAD_MAN_SELF_HEAL_MAX_ATTEMPTS} forced re-fires, one per tick) is attempted before escalating.`,
    severity: 'warning',
    operationalAlert: {
      key: 'schedule:dead_man',
      metric: 'schedule_starvation',
      state: 'fired',
    },
  };
}

/**
 * Escalation alert emitted once when the bounded self-heal exhausts its cap
 * while still starving (issue #1903). Re-fires the SAME operational key at
 * severity `critical` so it updates the already-standing dead-man alert in place
 * (ResourceStatusService correlates fires by key) rather than opening a second
 * one; it stays standing until the normal recovery clears the key.
 */
function buildScheduleStarvationEscalationAlert(
  reason: string,
  windowMs: number,
  attempts: number,
): Extract<ServerMessage, { type: 'alert' }> {
  return {
    type: 'alert',
    agentId: OPERATIONAL_ALERT_AGENT_ID,
    summary: `Scheduled tasks still starving after ${attempts} self-heal attempt(s) — manual intervention required: ${reason}`,
    details:
      `Dead-man self-heal exhausted (issue #1903): ${attempts} bounded forced re-fire(s) did not restore flow within ` +
      `the ${Math.round(windowMs / 60_000)}-minute window. Automatic remediation has stopped to avoid an unbounded ` +
      'restart loop; this is now a standing alert until an operator acts. ' +
      'Inspect /api/health capacity ledger and the schedules panel; free capacity or fix the launch pipeline.',
    severity: 'critical',
    operationalAlert: {
      key: 'schedule:dead_man',
      metric: 'schedule_starvation',
      state: 'fired',
    },
  };
}

function buildScheduleStarvationRecoveryAlert(selfHealAttempts: number): Extract<ServerMessage, { type: 'alert' }> {
  const healNote =
    selfHealAttempts > 0
      ? ` Recovered after ${selfHealAttempts} bounded self-heal attempt(s).`
      : '';
  return {
    type: 'alert',
    agentId: OPERATIONAL_ALERT_AGENT_ID,
    summary: 'Recovered: scheduled executions are flowing again',
    details:
      'Dead-man switch cleared: a scheduled execution was dispatched/completed ' +
      `and no enabled schedule shows a consecutive capacity/dispatch-failure tail.${healNote}`,
    severity: 'info',
    operationalAlert: {
      key: 'schedule:dead_man',
      metric: 'schedule_starvation',
      state: 'recovered',
    },
  };
}
