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
 * ledger, which clears both conditions). No self-heal action is taken in
 * this phase — alert-only is a deliberate scope decision.
 */
export const DEAD_MAN_CONSECUTIVE_FAILURES = 3;

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
  /** Live getter for the dead-man window (ms). Falls back to {@link DEFAULT_DEAD_MAN_SCHEDULE_MS}. */
  getDeadManMs?: () => number;
  /** Injectable clock (tests). */
  now?: () => Date;
}

interface StarvationVerdict {
  starving: boolean;
  reason?: string;
}

export class ScheduleDeadManSwitch {
  private firing = false;
  private readonly deps: ScheduleDeadManDeps;

  constructor(deps: ScheduleDeadManDeps) {
    this.deps = deps;
  }

  /**
   * Evaluate one tick. Broadcasts at most one alert per state transition
   * (fired on the healthy→starving edge, recovered on the way back).
   */
  check(schedules: Schedule[]): void {
    const nowMs = (this.deps.now?.() ?? new Date()).getTime();
    const windowMs = this.resolveWindowMs();
    const verdict = evaluateScheduleStarvation(schedules, nowMs, windowMs);

    if (verdict.starving && !this.firing) {
      this.firing = true;
      this.emit(buildScheduleStarvationAlert(verdict.reason ?? 'scheduled executions are starving', windowMs));
      return;
    }
    if (!verdict.starving && this.firing) {
      this.firing = false;
      this.emit(buildScheduleStarvationRecoveryAlert());
    }
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

  // Condition (a): consecutive capacity/dispatch failures on one schedule.
  for (const schedule of enabled) {
    const relevant = schedule.executionLedger.filter(
      (entry) => entry.outcome !== 'skipped_draining' && entry.outcome !== 'skipped_safe_mode',
    );
    if (relevant.length < DEAD_MAN_CONSECUTIVE_FAILURES) continue;
    const tail = relevant.slice(-DEAD_MAN_CONSECUTIVE_FAILURES);
    if (tail.every((entry) => STARVATION_OUTCOMES.has(entry.outcome))) {
      const outcomes = tail.map((entry) => entry.outcome).join(', ');
      return {
        starving: true,
        reason: `schedule "${schedule.name}" — last ${DEAD_MAN_CONSECUTIVE_FAILURES} outcomes were capacity/dispatch failures (${outcomes})`,
      };
    }
  }

  // Condition (b): fires were due in the window, none dispatched/completed.
  const windowStart = nowMs - windowMs;
  const windowed: ScheduleExecutionLedgerEntry[] = [];
  for (const schedule of enabled) {
    for (const entry of schedule.executionLedger) {
      if (entry.outcome === 'skipped_draining' || entry.outcome === 'skipped_safe_mode') continue;
      const evaluatedAtMs = Date.parse(entry.evaluatedAt);
      if (Number.isFinite(evaluatedAtMs) && evaluatedAtMs >= windowStart) {
        windowed.push(entry);
      }
    }
  }
  if (windowed.length > 0 && !windowed.some((entry) => HEALTHY_OUTCOMES.has(entry.outcome))) {
    return {
      starving: true,
      reason: `${windowed.length} scheduled fire(s) were due in the last ${Math.round(windowMs / 60_000)}m and none was dispatched or completed`,
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
      'No automatic remediation is taken (alert-only by design in this phase).',
    severity: 'warning',
    operationalAlert: {
      key: 'schedule:dead_man',
      metric: 'schedule_starvation',
      state: 'fired',
    },
  };
}

function buildScheduleStarvationRecoveryAlert(): Extract<ServerMessage, { type: 'alert' }> {
  return {
    type: 'alert',
    agentId: OPERATIONAL_ALERT_AGENT_ID,
    summary: 'Recovered: scheduled executions are flowing again',
    details:
      'Dead-man switch cleared: a scheduled execution was dispatched/completed ' +
      'and no enabled schedule shows a consecutive capacity/dispatch-failure tail.',
    severity: 'info',
    operationalAlert: {
      key: 'schedule:dead_man',
      metric: 'schedule_starvation',
      state: 'recovered',
    },
  };
}
