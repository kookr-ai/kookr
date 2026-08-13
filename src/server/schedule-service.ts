import { randomUUID } from 'node:crypto';
import type { TaskStore } from '../core/tasks.js';
import {
  type AgentSelection,
} from '../core/agent-types.js';
import {
  type CreateScheduleInput,
  type Schedule,
  type ScheduleExecutionDecision,
  type ScheduleExecutionLedgerEntry,
  type ScheduleExecutionOutcome,
  type ScheduleExecutionReasonCode,
  type ScheduleListResponse,
  type ScheduleLatestExecutionStatus,
  type ScheduleStatusSnapshot,
  type UpdateScheduleDefinitionInput,
  isTriggerLimitExhausted,
  pruneExecutionLedger,
  ScheduleStore,
  ScheduleValidationError,
} from '../core/schedule.js';
import type { ScheduleRollup } from '../core/schedule-rollup.js';
import type { TokenUsage } from '../core/usage-types.js';
import type { LaunchPhaseTimings } from '../core/launch-phase-timings.js';
import { decideTransientFailureRearm } from '../core/critical-schedule-rearm.js';
import type { ServerMessage } from '../shared/contracts/messages.js';
import { ScheduleValidator, validateCron } from './schedule-validator.js';
import { OPERATIONAL_ALERT_AGENT_ID } from './operational-alert-rules.js';

/**
 * Default per-schedule consecutive-failure alert + auto-pause threshold
 * (issue #1665 alert, issue #2353 fail-closed pause). One setting drives both:
 * the first time the streak crosses N the schedule alerts and is paused.
 */
export const DEFAULT_SCHEDULE_FAILURE_ALERT_THRESHOLD = 3;

/**
 * Next value of a schedule's `consecutiveFailures` counter (issue #1665) given
 * the terminal `lastRunStatus` just recorded. A `completed` run resets the
 * streak to 0; a genuine `failed` dispatch or a `cancelled` run increments it.
 * Overlap-skips (`skipped_active` / `previous_run_active`) never call this
 * helper — they are not failures (issue #2458). Pure so the counter transition
 * is unit testable without a store.
 */
export function nextConsecutiveFailures(
  previous: number | undefined,
  status: 'completed' | 'cancelled' | 'failed',
): number {
  if (status === 'completed') return 0;
  return (previous ?? 0) + 1;
}

/**
 * Whether a streak of consecutive failures should fail-closed pause the
 * schedule (issue #2353). Pure helper for tests and the service write paths.
 */
export function shouldAutoPauseForConsecutiveFailures(
  consecutiveFailures: number,
  threshold: number,
  currentlyEnabled: boolean,
): boolean {
  if (!currentlyEnabled) return false;
  if (!(threshold > 0) || !Number.isFinite(threshold)) return false;
  return consecutiveFailures >= Math.floor(threshold);
}

/**
 * Edge-triggered per-schedule failure alert (issue #1665): one `warning` alert
 * the moment the consecutive-failure streak crosses the threshold, one `info`
 * recovery alert when a later `completed` run clears a firing streak. Keyed per
 * schedule id so distinct failing schedules don't collide on one alert key.
 * When auto-pause is engaged (issue #2353) the details mention that the
 * schedule was disabled until an operator re-enables it.
 */
export function buildScheduleFailureAlert(
  schedule: Pick<Schedule, 'id' | 'name'>,
  consecutiveFailures: number,
  threshold: number,
  lastMessage?: string,
  autoPaused = false,
): Extract<ServerMessage, { type: 'alert' }> {
  const detail = lastMessage ? ` Last error: ${lastMessage}.` : '';
  const pauseNote = autoPaused
    ? ` The schedule has been auto-paused (enabled=false, stopReason=consecutive_failures) ` +
      'to stop thrashing capacity; re-enable it after inspecting the loop to clear the ' +
      'counter and resume fires.'
    : ' A run that completes successfully resets the counter and clears this alert. ' +
      'This alert is raised once per failing episode.';
  return {
    type: 'alert',
    agentId: OPERATIONAL_ALERT_AGENT_ID,
    summary: autoPaused
      ? `Schedule "${schedule.name}" auto-paused after ${consecutiveFailures} consecutive failures`
      : `Schedule "${schedule.name}" has failed ${consecutiveFailures} consecutive runs`,
    details:
      `Schedule "${schedule.name}" (${schedule.id}) has now failed ${consecutiveFailures} ` +
      `consecutive runs, crossing the threshold of ${threshold} ` +
      '(scheduleFailureAlertThreshold setting).' +
      `${detail}${pauseNote}`,
    severity: 'warning',
    operationalAlert: {
      key: `schedule:failures:${schedule.id}`,
      metric: 'schedule_consecutive_failures',
      state: 'fired',
    },
  };
}

export function buildScheduleFailureRecoveryAlert(
  schedule: Pick<Schedule, 'id' | 'name'>,
): Extract<ServerMessage, { type: 'alert' }> {
  return {
    type: 'alert',
    agentId: OPERATIONAL_ALERT_AGENT_ID,
    summary: `Recovered: schedule "${schedule.name}" completed a run again`,
    details:
      `Schedule "${schedule.name}" (${schedule.id}) completed a run, ` +
      'resetting its consecutive-failure counter to 0 and clearing the failure alert.',
    severity: 'info',
    operationalAlert: {
      key: `schedule:failures:${schedule.id}`,
      metric: 'schedule_consecutive_failures',
      state: 'recovered',
    },
  };
}

/**
 * Outcomes recorded by `markExecutionOutcome` that count as a genuine schedule
 * run failure and increment the consecutive-failure counter (issue #1665). Only
 * `dispatch_failed` — the launch pipeline actually failed to start the run —
 * qualifies. Every other outcome `markExecutionOutcome` handles is a benign
 * deferral, NOT a failure, and must carry the counter forward unchanged:
 * `skipped_active`/`skipped_coalesced` mean the previous run is still
 * running/pending (a healthy schedule whose task simply outlives its cron
 * interval, or one coalescing under capacity pressure — exactly when an
 * operator wants LESS noise); `skipped_draining` is an operator drain;
 * `skipped_server_restarting` is an intentional redeploy (issue #1983);
 * `skipped_safe_mode` is the automation kill-switch (issue #1710);
 * `skipped_manual`/`skipped_stale`/`skipped_capacity`/`deduplicated` are
 * intentional skips; `skipped_provider_paused` is a deliberate park when a
 * pinned agent is unavailable with no substitute (issue #1895); and
 * `unknown_after_restart` is unresolved rather than failed. Counting any of
 * those would mislabel healthy schedules as failing.
 */
const SCHEDULE_RUN_FAILURE_OUTCOMES: ReadonlySet<ScheduleExecutionOutcome> = new Set(['dispatch_failed']);

/** Outcomes that borrow the previous fire's taskId as a blocking pointer. */
const SKIP_POINTER_OUTCOMES: ReadonlySet<ScheduleExecutionOutcome> = new Set([
  'skipped_active',
  'skipped_coalesced',
]);

/**
 * Cost/tokens + artifact links joined onto a ledger row from its task at
 * write time (issue #1582). Both fields are optional and only ever populated
 * from real task state — a task with no `tokenUsage` yields no `tokenUsage`
 * here (no fabricated zero) and a task with no recorded artifacts yields no
 * `artifacts`.
 */
export interface ScheduleLedgerEnrichment {
  tokenUsage?: TokenUsage;
  artifacts?: string[];
  /** Merge commit SHA of the fire's merged delivery unit (issue #1596), when its PR merged. */
  mergeCommit?: string;
}

/** Minimal task shape the ledger join reads — decouples the service from the full task model. */
export interface LedgerEnrichmentTaskLike {
  tokenUsage?: TokenUsage;
  completionDigest?: { prUrls?: string[]; mergeCommit?: string };
}

/**
 * Derive a fire's ledger enrichment from its task (issue #1582). Pure: cost
 * comes from `task.tokenUsage` verbatim (absent when the task never measured
 * usage), artifact links come from the completion digest's PR URLs. Returns an
 * empty object for an absent task so callers can spread it unconditionally.
 */
export function deriveLedgerEnrichment(task: LedgerEnrichmentTaskLike | undefined): ScheduleLedgerEnrichment {
  if (!task) return {};
  const enrichment: ScheduleLedgerEnrichment = {};
  if (task.tokenUsage) enrichment.tokenUsage = task.tokenUsage;
  const artifacts = (task.completionDigest?.prUrls ?? []).filter((url) => typeof url === 'string' && url.length > 0);
  if (artifacts.length > 0) enrichment.artifacts = [...artifacts];
  const mergeCommit = task.completionDigest?.mergeCommit;
  if (typeof mergeCommit === 'string' && mergeCommit.length > 0) enrichment.mergeCommit = mergeCommit;
  return enrichment;
}

export interface ScheduleServiceDeps {
  store: ScheduleStore;
  validator: ScheduleValidator;
  broadcast?: (payload: ScheduleListResponse) => void;
  /**
   * Joins a fire's `taskId` to its cost/artifact enrichment at ledger-write
   * time (issue #1582). Optional: when absent, ledger rows write exactly as
   * before with no cost/artifacts. Kept as a narrow lookup rather than a full
   * `TaskStore` handle so the service stays decoupled and the join is trivially
   * stubbed in tests.
   */
  resolveLedgerEnrichment?: (taskId: string) => ScheduleLedgerEnrichment | undefined;
  /**
   * Sink for the per-schedule failure alert (issue #1665). Optional: when
   * absent, the `consecutiveFailures` counter is still maintained and surfaced,
   * but no alert is emitted. Wired to `broadcastToAll` in production.
   */
  emitAlert?: (message: Extract<ServerMessage, { type: 'alert' }>) => void;
  /**
   * Live getter for the consecutive-failure alert threshold (issue #1665).
   * Read per recorded run so a settings change applies immediately. Falls back
   * to {@link DEFAULT_SCHEDULE_FAILURE_ALERT_THRESHOLD} when absent.
   */
  getFailureAlertThreshold?: () => number;
  /**
   * Live getter for the operator-configured default coding agent
   * (`settings.defaultAgentType`). Used when a schedule has no agentType pin
   * (create omit, or pin cleared) so fires track the server default without
   * re-editing every schedule.
   */
  getDefaultAgentType?: () => AgentSelection;
  /**
   * Live daemon-healthy signal for leftover consecutive_failures re-arm
   * (issue #2459). True when startup phase is `ready`. Absent or false
   * leaves leftover holds in place.
   */
  getDaemonHealthy?: () => boolean;
  /**
   * ISO timestamp of when this process became ready. A leftover hold is
   * only lifted when its last fire predates this watermark, so a live
   * #2353 streak that happens after boot stays paused.
   */
  getReadyAt?: () => string | undefined;
}

export class ScheduleService {
  private readonly store: ScheduleStore;
  private readonly validator: ScheduleValidator;
  private readonly broadcast?: (payload: ScheduleListResponse) => void;
  private readonly resolveLedgerEnrichment?: (taskId: string) => ScheduleLedgerEnrichment | undefined;
  private readonly emitAlert?: (message: Extract<ServerMessage, { type: 'alert' }>) => void;
  private readonly getFailureAlertThreshold?: () => number;
  private readonly getDefaultAgentType?: () => AgentSelection;
  private readonly getDaemonHealthy?: () => boolean;
  private readonly getReadyAt?: () => string | undefined;
  private runnerStartedAt?: string;
  private lastTickCompletedAt?: string;
  private lastError?: string;
  private catchUpMode: 'auto' | 'manual' | 'off' = 'manual';
  private catchUpEnabled = false;
  private deadManSelfHeal?: {
    attempts: number;
    successes: number;
    escalated: boolean;
    class?: 'auth_expired';
  };

  constructor(deps: ScheduleServiceDeps) {
    this.store = deps.store;
    this.validator = deps.validator;
    this.broadcast = deps.broadcast;
    this.resolveLedgerEnrichment = deps.resolveLedgerEnrichment;
    this.emitAlert = deps.emitAlert;
    this.getFailureAlertThreshold = deps.getFailureAlertThreshold;
    this.getDefaultAgentType = deps.getDefaultAgentType;
    this.getDaemonHealthy = deps.getDaemonHealthy;
    this.getReadyAt = deps.getReadyAt;
  }

  /**
   * Emit the edge-triggered per-schedule failure alert (issue #1665) after a
   * terminal run has been persisted. `previous` is the schedule as it was
   * BEFORE this run (so `priorCount` is the real prior streak) and `nextCount`
   * is the freshly-persisted counter (from {@link nextConsecutiveFailures}).
   * Fires once on the healthy→failing edge (streak crosses the threshold) and
   * once on the failing→healthy edge (a `completed` run resets a firing streak).
   * `autoPaused` folds the issue #2353 fail-closed pause into the same edge
   * alert so operators get one signal, not two.
   */
  private emitFailureAlertOnEdge(
    previous: Schedule,
    nextCount: number,
    lastMessage?: string,
    autoPaused = false,
  ): void {
    if (!this.emitAlert) return;
    const priorCount = previous.consecutiveFailures ?? 0;
    const threshold = this.resolveFailureAlertThreshold();
    if (threshold <= 0) return;

    if (priorCount < threshold && nextCount >= threshold) {
      this.emitAlert(buildScheduleFailureAlert(previous, nextCount, threshold, lastMessage, autoPaused));
    } else if (priorCount >= threshold && nextCount === 0) {
      this.emitAlert(buildScheduleFailureRecoveryAlert(previous));
    } else if (autoPaused && priorCount >= threshold && nextCount >= threshold) {
      // Enforce path: schedule was already over threshold but still enabled
      // (e.g. pre-#2353 persisted state). Emit once so the operator learns it
      // was parked, even though the counter edge already fired historically.
      this.emitAlert(buildScheduleFailureAlert(previous, nextCount, threshold, lastMessage, true));
    }
  }

  private resolveFailureAlertThreshold(): number {
    const value = this.getFailureAlertThreshold?.();
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return Math.floor(value);
    }
    return DEFAULT_SCHEDULE_FAILURE_ALERT_THRESHOLD;
  }

  /**
   * Patch applied when a failure streak crosses the auto-pause threshold
   * (issue #2353). Parks the schedule (`enabled: false`) with
   * `stopReason: consecutive_failures` and `operatorHold: true` so critical
   * recovery re-arm cannot re-enable a known-dead loop. Empty when no pause.
   */
  private autoPausePatch(
    schedule: Schedule,
    consecutiveFailures: number,
  ): Partial<Pick<Schedule, 'enabled' | 'stopReason' | 'operatorHold'>> {
    const threshold = this.resolveFailureAlertThreshold();
    if (!shouldAutoPauseForConsecutiveFailures(consecutiveFailures, threshold, schedule.enabled)) {
      return {};
    }
    return {
      enabled: false,
      stopReason: 'consecutive_failures',
      operatorHold: true,
    };
  }

  listResponse(): ScheduleListResponse {
    return {
      revision: this.store.getRevision(),
      schedules: this.store.listWithComputed(),
      status: this.getStatusSnapshot(),
    };
  }

  /**
   * Materialized ROI rollup for one schedule (issue #1584). Reads ONLY the
   * in-memory materialized store — no tasks.json / hook-log scan on the request
   * path. `undefined` when the schedule id is unknown.
   */
  getRollup(id: string): ScheduleRollup | undefined {
    return this.store.getRollup(id);
  }

  /** Fleet-wide materialized ROI rollups (issue #1584). No on-request scan. */
  listRollups(): ScheduleRollup[] {
    return this.store.listRollups();
  }

  getStatusSnapshot(): ScheduleStatusSnapshot {
    const loadError = this.store.getLoadError();
    const lastTickCompletedAt = this.lastTickCompletedAt;
    const schedulerHealthy = !loadError && !this.lastError;
    const schedulesPausedByFailure = this.store.list()
      .filter((s) => s.stopReason === 'consecutive_failures' && !s.enabled)
      .map((s) => ({
        id: s.id,
        name: s.name,
        consecutiveFailures: s.consecutiveFailures ?? 0,
      }));
    return {
      timezone: currentTimezone(),
      ...(this.runnerStartedAt ? { runnerStartedAt: this.runnerStartedAt } : {}),
      ...(lastTickCompletedAt ? { lastTickCompletedAt } : {}),
      catchUpMode: this.catchUpMode,
      catchUpEnabled: this.catchUpEnabled,
      schedulerHealthy,
      ...(loadError ? { loadError } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
      ...(this.deadManSelfHeal ? { deadManSelfHeal: this.deadManSelfHeal } : {}),
      ...(schedulesPausedByFailure.length > 0 ? { schedulesPausedByFailure } : {}),
    };
  }

  /**
   * Record the dead-man switch's bounded self-heal counters (issue #1903) so
   * they surface on {@link getStatusSnapshot}. Pushed by the runner after each
   * `deadMan.check()`; a plain setter (no broadcast) since the surrounding
   * `recordTickCompleted()` already broadcasts the fresh snapshot.
   */
  setDeadManSelfHealStats(stats: {
    attempts: number;
    successes: number;
    escalated: boolean;
    class?: 'auth_expired';
  }): void {
    this.deadManSelfHeal = {
      attempts: stats.attempts,
      successes: stats.successes,
      escalated: stats.escalated,
      ...(stats.class ? { class: stats.class } : {}),
    };
  }

  recordRunnerStarted(catchUpMode: 'auto' | 'manual' | 'off'): void {
    this.runnerStartedAt = new Date().toISOString();
    this.catchUpMode = catchUpMode;
    this.catchUpEnabled = catchUpMode === 'auto';
    this.lastError = undefined;
    this.broadcastSchedules();
  }

  /**
   * Pause every still-enabled schedule whose `consecutiveFailures` is already
   * at/over the threshold (issue #2353). Covers pre-existing thrashing
   * schedules after deploy (counter was already high but auto-pause did not
   * yet exist) so the next cron tick cannot waste another slot.
   */
  async enforceFailureAutoPauses(): Promise<number> {
    const threshold = this.resolveFailureAlertThreshold();
    if (threshold <= 0) return 0;
    let paused = 0;
    for (const schedule of this.store.list()) {
      const count = schedule.consecutiveFailures ?? 0;
      if (!shouldAutoPauseForConsecutiveFailures(count, threshold, schedule.enabled)) continue;
      const now = new Date().toISOString();
      const patch = this.autoPausePatch(schedule, count);
      this.store.replace({
        ...schedule,
        ...patch,
        updatedAt: now,
      });
      // Synthesize a priorCount just under threshold so the edge alert fires
      // once for this enforce-driven pause (operator visibility).
      this.emitFailureAlertOnEdge(
        { ...schedule, consecutiveFailures: Math.max(0, threshold - 1) },
        count,
        'Auto-paused: consecutive failure threshold already reached',
        true,
      );
      paused += 1;
    }
    if (paused > 0) {
      await this.store.persist();
      this.broadcastSchedules();
    }
    return paused;
  }

  /**
   * Lift leftover `consecutive_failures` holds whose last reason was a
   * transient `launch_error` or overlap-skip, once the daemon is healthy
   * (issue #2459). Only holds whose last fire predates {@link getReadyAt}
   * (or {@link runnerStartedAt}) are lifted — a live streak that happens
   * after boot stays paused (#2353). Reuses {@link setEnabled} so the
   * counter, stopReason, and operatorHold clear the same way an operator
   * re-enable would.
   */
  async rearmTransientFailureHolds(healthOk?: boolean, readyAt?: string): Promise<{
    rearmed: Array<{ id: string; name: string; reasonCode?: string }>;
  }> {
    const healthy = healthOk ?? this.getDaemonHealthy?.() ?? false;
    const ready = readyAt ?? this.getReadyAt?.() ?? this.runnerStartedAt;
    const rearmed: Array<{ id: string; name: string; reasonCode?: string }> = [];
    for (const schedule of this.store.list()) {
      const reasonCode = schedule.latestExecution?.reasonCode;
      const decision = decideTransientFailureRearm(
        {
          id: schedule.id,
          name: schedule.name,
          enabled: schedule.enabled,
          stopReason: schedule.stopReason,
          latestReasonCode: reasonCode,
          lastEvaluatedAt: schedule.latestExecution?.evaluatedAt,
        },
        healthy,
        ready,
      );
      if (!decision.rearm) continue;
      // A pause that also exhausted maxTriggers cannot be re-enabled; isolate
      // that throw so one exhausted leftover cannot abort the rest of the scan.
      if (isTriggerLimitExhausted(schedule)) continue;
      try {
        await this.setEnabled(schedule.id, true);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          `[schedule] transient-failure re-arm failed for "${schedule.name}" `
          + `(${schedule.id}): ${message}`,
        );
        continue;
      }
      rearmed.push({
        id: schedule.id,
        name: schedule.name,
        ...(reasonCode ? { reasonCode } : {}),
      });
      console.log(
        `[schedule] re-armed consecutive_failures hold on "${schedule.name}" `
        + `(${schedule.id}) lastReason=${reasonCode ?? 'unknown'} (issue #2459)`,
      );
    }
    return { rearmed };
  }

  recordTickCompleted(): void {
    this.lastTickCompletedAt = new Date().toISOString();
    this.lastError = undefined;
    this.broadcastSchedules();
  }

  recordRunnerError(message: string): void {
    this.lastError = message;
    this.broadcastSchedules();
  }

  async createDefinition(input: CreateScheduleInput) {
    // Leave agentType unset when the client omits it so the schedule inherits
    // the live settings.defaultAgentType at each fire (not a baked pin).
    // Explicit pins (including round-robin) still pass through unchanged.
    await this.validator.validateCreate(input, this.getDefaultAgentType);
    const schedule = this.store.create(input);
    await this.store.persist();
    this.broadcastSchedules();
    return this.store.getWithComputed(schedule.id)!;
  }

  async updateDefinition(id: string, patch: UpdateScheduleDefinitionInput) {
    const existing = this.store.get(id);
    if (!existing) throw new ScheduleValidationError(`Schedule not found: ${id}`);
    await this.validator.validateDefinitionUpdate(existing, patch, this.getDefaultAgentType);
    this.store.updateDefinition(id, patch);
    await this.store.persist();
    this.broadcastSchedules();
    return this.store.getWithComputed(id)!;
  }

  async setEnabled(id: string, enabled: boolean, opts?: { operatorHold?: boolean }) {
    const schedule = this.requireSchedule(id);
    if (enabled && isTriggerLimitExhausted(schedule)) {
      throw new ScheduleValidationError('Schedule trigger limit has been exhausted', { maxTriggers: 'Increase or clear the trigger limit before resuming' });
    }
    this.store.setEnabled(id, enabled, opts);
    if (enabled) {
      // Operator re-enable after a consecutive-failure pause (issue #2353):
      // clear the failure counter and stopReason so the schedule starts clean.
      // Without this, the next tick would immediately re-pause (counter still
      // at/over threshold) and the operator could never resume.
      const after = this.store.get(id);
      if (after && (
        (after.consecutiveFailures ?? 0) > 0
        || after.stopReason === 'consecutive_failures'
      )) {
        const cleared: Schedule = {
          ...after,
          consecutiveFailures: 0,
          updatedAt: new Date().toISOString(),
        };
        if (cleared.stopReason === 'consecutive_failures') {
          delete cleared.stopReason;
        }
        this.store.replace(cleared);
      }
    }
    await this.store.persist();
    this.broadcastSchedules();
    return this.store.getWithComputed(id)!;
  }

  async delete(id: string): Promise<void> {
    if (!this.store.delete(id)) {
      throw new ScheduleValidationError('Schedule not found');
    }
    await this.store.persist();
    this.broadcastSchedules();
  }

  async reserveExecution(
    schedule: Schedule,
    trigger: 'cron' | 'manual',
    scheduledFor?: string,
    decision: ScheduleExecutionDecision = trigger === 'manual' ? 'manual_run' : 'cron_due',
  ) {
    const receiptId = randomUUID();
    const executionToken = randomUUID();
    const evaluatedAt = new Date().toISOString();
    const updated: Schedule = {
      ...schedule,
      ...(trigger === 'cron' && scheduledFor ? { lastScheduledFor: scheduledFor } : {}),
      ...(trigger === 'cron' ? { lastCronEvaluatedAt: evaluatedAt } : {}),
      currentExecution: {
        id: receiptId,
        scheduleId: schedule.id,
        executionToken,
        trigger,
        decision,
        ...(scheduledFor ? { scheduledFor } : {}),
        evaluatedAt,
        status: 'reserved',
      },
      updatedAt: evaluatedAt,
    };
    this.store.replace(updated);
    await this.store.persist();
    return updated.currentExecution!;
  }

  async markCronLimitExhausted(scheduleId: string): Promise<void> {
    const schedule = this.requireSchedule(scheduleId);
    if (!isTriggerLimitExhausted(schedule)) return;
    if (!schedule.enabled && schedule.stopReason === 'trigger_limit_reached') return;

    this.store.replace({
      ...schedule,
      enabled: false,
      stopReason: 'trigger_limit_reached',
      exhaustedAt: schedule.exhaustedAt ?? new Date().toISOString(),
    });
    await this.store.persist();
    this.broadcastSchedules();
  }

  async recordCatchUpSkipped(scheduleId: string, scheduledFor: string, message: string): Promise<void> {
    const schedule = this.requireSchedule(scheduleId);
    const evaluatedAt = new Date().toISOString();
    this.store.replace({
      ...schedule,
      lastScheduledFor: evaluatedAt,
      lastCronEvaluatedAt: evaluatedAt,
      latestExecution: {
        executionToken: ledgerKeyFor(schedule.id, 'cron', scheduledFor),
        scheduledFor,
        evaluatedAt,
        trigger: 'cron',
        outcome: 'skipped_stale',
        reasonCode: 'stale_catch_up',
        message,
      },
      executionLedger: upsertLedgerEntry(schedule.executionLedger, {
        id: ledgerKeyFor(schedule.id, 'cron', scheduledFor),
        scheduleId: schedule.id,
        trigger: 'cron',
        decision: 'stale_catch_up',
        scheduledFor,
        evaluatedAt,
        completedAt: evaluatedAt,
        outcome: 'skipped_stale',
        reasonCode: 'stale_catch_up',
        message,
      }),
    });
    await this.store.persist();
    this.broadcastSchedules();
  }

  async recordCatchUpDeferred(scheduleId: string, scheduledFor: string, message: string): Promise<void> {
    const schedule = this.requireSchedule(scheduleId);
    const evaluatedAt = new Date().toISOString();
    this.store.replace({
      ...schedule,
      lastScheduledFor: evaluatedAt,
      lastCronEvaluatedAt: evaluatedAt,
      latestExecution: {
        executionToken: ledgerKeyFor(schedule.id, 'cron', scheduledFor),
        scheduledFor,
        evaluatedAt,
        trigger: 'cron',
        outcome: 'skipped_manual',
        reasonCode: 'manual_catch_up_required',
        message,
      },
      executionLedger: upsertLedgerEntry(schedule.executionLedger, {
        id: ledgerKeyFor(schedule.id, 'cron', scheduledFor),
        scheduleId: schedule.id,
        trigger: 'cron',
        decision: 'manual_catch_up',
        scheduledFor,
        evaluatedAt,
        completedAt: evaluatedAt,
        outcome: 'skipped_manual',
        reasonCode: 'manual_catch_up_required',
        message,
      }),
    });
    await this.store.persist();
    this.broadcastSchedules();
  }

  /**
   * Record a startup catch-up fire withheld by the WS0.5 relaunch arbiter
   * (issue #1900 / #1699 WS2.2): another actuator holds the schedule's
   * relaunch lease, or its post-release backoff window is still live. Recorded
   * as `skipped_relaunch_locked` (decision `catch_up`) so the withheld fire is
   * operator-visible in the ledger rather than silently dropped. Advances the
   * cron watermark so the same missed slot is not re-evaluated next tick.
   */
  async recordCatchUpLeaseDenied(scheduleId: string, scheduledFor: string, message: string): Promise<void> {
    const schedule = this.requireSchedule(scheduleId);
    const evaluatedAt = new Date().toISOString();
    this.store.replace({
      ...schedule,
      lastScheduledFor: evaluatedAt,
      lastCronEvaluatedAt: evaluatedAt,
      latestExecution: {
        executionToken: ledgerKeyFor(schedule.id, 'cron', scheduledFor),
        scheduledFor,
        evaluatedAt,
        trigger: 'cron',
        outcome: 'skipped_relaunch_locked',
        reasonCode: 'relaunch_lease_held',
        message,
      },
      executionLedger: upsertLedgerEntry(schedule.executionLedger, {
        id: ledgerKeyFor(schedule.id, 'cron', scheduledFor),
        scheduleId: schedule.id,
        trigger: 'cron',
        decision: 'catch_up',
        scheduledFor,
        evaluatedAt,
        completedAt: evaluatedAt,
        outcome: 'skipped_relaunch_locked',
        reasonCode: 'relaunch_lease_held',
        message,
      }),
    });
    await this.store.persist();
    this.broadcastSchedules();
  }

  async suppressCatchUp(scheduleId: string): Promise<void> {
    const schedule = this.requireSchedule(scheduleId);
    const evaluatedAt = new Date().toISOString();
    this.store.replace({
      ...schedule,
      lastScheduledFor: evaluatedAt,
      lastCronEvaluatedAt: evaluatedAt,
      updatedAt: evaluatedAt,
    });
    await this.store.persist();
    this.broadcastSchedules();
  }

  /**
   * `queued` reports whether the launcher pended the task instead of
   * launching it immediately — for the schedule runner's launcher (which
   * routes through the normal task-submission path, issue #1526 Phase A /
   * FM8), that only ever happens because the node was at capacity, so it is
   * recorded as `queued_capacity` (reasonCode `capacity`) rather than the
   * legacy generic `queued`.
   *
   * `details.reasonCode` (issue #1895) lets the runner stamp an observability
   * code that is not implied by `queued` alone — e.g. `agent_substituted`
   * when a pinned-but-unavailable agent was rotated to a launchable one.
   * When omitted, the historical `capacity` / `none` mapping is preserved.
   */
  async markExecutionAccepted(
    scheduleId: string,
    receiptId: string,
    taskId: string,
    queued: boolean,
    details: { reasonCode?: ScheduleExecutionReasonCode; message?: string } = {},
  ): Promise<void> {
    const schedule = this.requireSchedule(scheduleId);
    const receipt = this.requireReceipt(schedule, receiptId);
    const triggeredAt = new Date().toISOString();
    const outcome = queued ? 'queued_capacity' : 'running';
    const reasonCode = details.reasonCode ?? (queued ? 'capacity' : 'none');
    const latestExecution: ScheduleLatestExecutionStatus = {
      receiptId,
      executionToken: receipt.executionToken,
      ...(receipt.scheduledFor ? { scheduledFor: receipt.scheduledFor } : {}),
      evaluatedAt: receipt.evaluatedAt,
      triggeredAt,
      trigger: receipt.trigger,
      taskId,
      outcome,
      reasonCode,
      ...(details.message ? { message: details.message } : {}),
    };
    this.store.replace({
      ...schedule,
      lastRunAt: triggeredAt,
      lastRunTaskId: taskId,
      ...consumeCronTrigger(schedule, receipt.trigger, true, triggeredAt),
      latestExecution,
      executionLedger: upsertLedgerEntry(schedule.executionLedger, ledgerEntryFromReceipt(
        schedule,
        receipt,
        latestExecution.outcome,
        reasonCode,
        {
          completedAt: triggeredAt,
          taskId,
          ...(details.message ? { message: details.message } : {}),
        },
      )),
      currentExecution: {
        ...receipt,
        taskId,
        status: 'accepted',
      },
    });
    await this.store.persist();
    this.broadcastSchedules();
  }

  async markExecutionOutcome(
    scheduleId: string,
    receiptId: string,
    outcome: Exclude<ScheduleExecutionOutcome, 'completed' | 'cancelled' | 'running' | 'queued' | 'queued_capacity'>,
    reasonCode: ScheduleExecutionReasonCode,
    message?: string,
    details: { blockingTaskId?: string; launchPhaseTimings?: LaunchPhaseTimings } = {},
  ): Promise<void> {
    const schedule = this.requireSchedule(scheduleId);
    const receipt = this.requireReceipt(schedule, receiptId);
    const evaluatedAt = new Date().toISOString();
    // issue #1526 Phase A: a skip receipt never carries its own taskId
    // (reserveExecution creates it before any launch attempt), so writing
    // `latestExecution.taskId` from `receipt.taskId` alone WIPES the blocking
    // pointer on every skip. fire() reads `schedule.latestExecution?.taskId`
    // as `blockingTaskId` on the NEXT tick — wiping it here means a second
    // skipped_coalesced/skipped_active in a row loses track of the still-
    // pending/active task and the following fire launches a duplicate
    // instead of skipping again. It also breaks recordTaskTerminalOutcome's
    // schedule lookup (`candidate.latestExecution?.taskId === taskId`), which
    // can no longer find this schedule once the pointer is gone. Falling back
    // to `details.blockingTaskId` (the task this skip was actually blocked
    // by) preserves the pointer across any number of consecutive skips.
    const preservedTaskId = receipt.taskId ?? details.blockingTaskId;
    // Failure-counter tracking (issue #1665). Only a genuine launch failure
    // (`dispatch_failed`) increments; the benign deferrals/skips this method
    // also records (previous run still active/pending, operator drain, manual/
    // stale/dedup skips, unresolved-after-restart) carry the counter forward
    // unchanged, so a healthy-but-slow or capacity-pressured schedule never
    // trips the failure alert. See SCHEDULE_RUN_FAILURE_OUTCOMES.
    const isFailure = SCHEDULE_RUN_FAILURE_OUTCOMES.has(outcome);
    const consecutiveFailures = isFailure
      ? nextConsecutiveFailures(schedule.consecutiveFailures, 'failed')
      : schedule.consecutiveFailures ?? 0;
    const autoPause = this.autoPausePatch(schedule, consecutiveFailures);
    this.store.replace({
      ...schedule,
      lastRunAt: receipt.evaluatedAt,
      lastRunTaskId: receipt.taskId,
      // Overlap-skips and other benign deferrals must not look like a failed
      // run (issue #2458). Only a genuine dispatch failure writes lastRunStatus.
      ...(isFailure ? { lastRunStatus: 'failed' as const } : {}),
      consecutiveFailures,
      ...consumeCronTrigger(schedule, receipt.trigger, outcome === 'dispatch_failed', evaluatedAt),
      // Auto-pause (issue #2353) wins over a still-enabled trigger-budget
      // residual: fail-closed parking stops further fires until re-enable.
      ...autoPause,
      latestExecution: {
        receiptId,
        executionToken: receipt.executionToken,
        ...(receipt.scheduledFor ? { scheduledFor: receipt.scheduledFor } : {}),
        evaluatedAt: receipt.evaluatedAt,
        trigger: receipt.trigger,
        ...(preservedTaskId ? { taskId: preservedTaskId } : {}),
        outcome,
        reasonCode,
        ...(message ? { message } : {}),
      },
      executionLedger: upsertLedgerEntry(schedule.executionLedger, ledgerEntryFromReceipt(
        schedule,
        receipt,
        outcome,
        reasonCode,
        {
          completedAt: evaluatedAt,
          ...(preservedTaskId ? { taskId: preservedTaskId } : {}),
          ...(details.blockingTaskId ? { blockingTaskId: details.blockingTaskId } : {}),
          ...(message ? { message } : {}),
          ...(details.launchPhaseTimings ? { launchPhaseTimings: details.launchPhaseTimings } : {}),
        },
      )),
      currentExecution: {
        ...receipt,
        status: outcome === 'unknown_after_restart' ? 'unknown_after_restart' : 'terminal',
      },
    });
    await this.store.persist();
    this.broadcastSchedules();
    this.emitFailureAlertOnEdge(schedule, consecutiveFailures, message, Object.keys(autoPause).length > 0);
  }

  async recordTaskTerminalOutcome(taskId: string, status: 'completed' | 'cancelled'): Promise<void> {
    const schedule = this.store.list().find((candidate) => candidate.latestExecution?.taskId === taskId);
    if (!schedule?.latestExecution || schedule.latestExecution.taskId !== taskId) return;

    const currentReceipt = schedule.currentExecution;
    if (currentReceipt?.taskId && currentReceipt.taskId !== taskId) return;

    // Join cost/artifacts onto the row at write time (issue #1582). A null
    // resolver or a task with no measured usage leaves the fields absent.
    const enrichment = this.resolveLedgerEnrichment?.(taskId) ?? {};

    // Issue #2458: after an overlap-skip, latestExecution.taskId still points
    // at the previous fire (the blocking pointer). When that previous task
    // later cancels, do not rewrite the skip as `cancelled` or increment
    // consecutiveFailures — that is what fail-closed residual fuses after
    // "Previous run still active". A later *completed* previous run still
    // promotes (the previous fire succeeded).
    const latestOutcome = schedule.latestExecution.outcome;
    if (status === 'cancelled' && SKIP_POINTER_OUTCOMES.has(latestOutcome)) {
      const now = new Date().toISOString();
      this.store.replace({
        ...schedule,
        executionLedger: closeMidFlightLedgerRowsForTask(schedule.executionLedger, taskId, {
          outcome: 'cancelled',
          reasonCode: 'none',
          completedAt: now,
          ...(enrichment.tokenUsage ? { tokenUsage: enrichment.tokenUsage } : {}),
          ...(enrichment.artifacts ? { artifacts: enrichment.artifacts } : {}),
          ...(enrichment.mergeCommit ? { mergeCommit: enrichment.mergeCommit } : {}),
        }),
        updatedAt: now,
      });
      await this.store.persist();
      this.broadcastSchedules();
      return;
    }

    const consecutiveFailures = nextConsecutiveFailures(schedule.consecutiveFailures, status);
    const autoPause = this.autoPausePatch(schedule, consecutiveFailures);

    this.store.replace({
      ...schedule,
      lastRunAt: new Date().toISOString(),
      lastRunTaskId: taskId,
      lastRunStatus: status,
      consecutiveFailures,
      ...autoPause,
      latestExecution: {
        ...schedule.latestExecution,
        outcome: status,
        reasonCode: 'none',
      },
      executionLedger: updateLedgerEntryForTask(schedule.executionLedger, taskId, {
        outcome: status,
        reasonCode: 'none',
        completedAt: new Date().toISOString(),
        ...(enrichment.tokenUsage ? { tokenUsage: enrichment.tokenUsage } : {}),
        ...(enrichment.artifacts ? { artifacts: enrichment.artifacts } : {}),
        ...(enrichment.mergeCommit ? { mergeCommit: enrichment.mergeCommit } : {}),
      }),
      ...(currentReceipt ? {
        currentExecution: {
          ...currentReceipt,
          status: 'terminal',
        },
      } : {}),
    });
    await this.store.persist();
    this.broadcastSchedules();
    this.emitFailureAlertOnEdge(schedule, consecutiveFailures, undefined, Object.keys(autoPause).length > 0);
  }

  async reconcileOnStartup(taskStore: TaskStore): Promise<void> {
    let changed = false;
    for (const listed of this.store.list()) {
      let schedule = listed;
      if (schedule.currentExecution && (schedule.currentExecution.status === 'reserved' || schedule.currentExecution.status === 'accepted')) {
        const latest = schedule.latestExecution;
        // A 'reserved' receipt never carries its own taskId (only
        // markExecutionAccepted sets one) — the launch died with the previous
        // process before being accepted (issue #1526 Phase C / #1528). Do NOT
        // let a PREVIOUS run's `latestExecution.taskId` mask that: falling
        // back to it here used to leave the wedged receipt 'reserved'
        // forever whenever the schedule had any prior accepted run. Only an
        // 'accepted' receipt may borrow the latest pointer, since for it
        // that pointer really is this execution's task.
        const taskId = schedule.currentExecution.status === 'accepted'
          ? schedule.currentExecution.taskId ?? latest?.taskId
          : schedule.currentExecution.taskId;
        if (!taskId) {
          this.store.replace({
            ...schedule,
            latestExecution: latest ?? {
              receiptId: schedule.currentExecution.id,
              executionToken: schedule.currentExecution.executionToken,
              ...(schedule.currentExecution.scheduledFor ? { scheduledFor: schedule.currentExecution.scheduledFor } : {}),
              evaluatedAt: schedule.currentExecution.evaluatedAt,
              trigger: schedule.currentExecution.trigger,
              outcome: 'unknown_after_restart',
              reasonCode: 'unknown_after_restart',
              message: 'Execution could not be reconciled after restart',
            },
            executionLedger: upsertLedgerEntry(schedule.executionLedger, ledgerEntryFromReceipt(
              schedule,
              schedule.currentExecution,
              'unknown_after_restart',
              'unknown_after_restart',
              {
                completedAt: new Date().toISOString(),
                message: 'Execution could not be reconciled after restart',
              },
            )),
            currentExecution: {
              ...schedule.currentExecution,
              status: 'unknown_after_restart',
            },
          });
          changed = true;
          // Fall through to the latestExecution reconciliation below with a
          // REFRESHED read: a stale reference here would let the second
          // replace clobber the ledger entry the replace above just wrote
          // (issue #1526 Phase C — a crash between reserveExecution and the
          // outcome can leave BOTH a dead 'reserved' receipt and a
          // 'running' latestExecution needing task-based reconciliation).
          const refreshed = this.store.get(schedule.id);
          if (!refreshed) continue;
          schedule = refreshed;
        }
      }

      const latest = schedule.latestExecution;
      if (!latest) continue;
      // 'queued' is legacy (issue #1526 Phase A retired it in favor of
      // 'queued_capacity') — both mean "mid-flight when the server
      // restarted" and need the same post-restart reconciliation.
      if (latest.outcome !== 'running' && latest.outcome !== 'queued' && latest.outcome !== 'queued_capacity') continue;
      if (!latest.taskId) continue;

      const task = taskStore.getTask(latest.taskId);
      if (!task) {
        this.store.replace({
          ...schedule,
          latestExecution: {
            ...latest,
            outcome: 'unknown_after_restart',
            reasonCode: 'unknown_after_restart',
            message: 'Task state could not be reconciled after restart',
          },
          executionLedger: updateLedgerEntryForTask(schedule.executionLedger, latest.taskId, {
            outcome: 'unknown_after_restart',
            reasonCode: 'unknown_after_restart',
            message: 'Task state could not be reconciled after restart',
            completedAt: new Date().toISOString(),
          }),
          ...(schedule.currentExecution ? {
            currentExecution: {
              ...schedule.currentExecution,
              status: 'unknown_after_restart',
            },
          } : {}),
        });
        changed = true;
        continue;
      }

      if (task.status === 'completed' || task.status === 'cancelled' || task.status === 'terminated') {
        // A 'terminated' task (timeout / sessions died without user ack — see
        // rfc-task-loss-prevention D1 and hung-task-reaper) is still a finished
        // run from the schedule's perspective so the schedule unblocks. Count
        // it as `cancelled` (not `completed`) so timeout thrash increments
        // consecutiveFailures and can fail-closed pause (issue #2353); treating
        // terminated as completed used to silently reset the streak.
        const scheduleOutcome: 'completed' | 'cancelled' =
          task.status === 'terminated' ? 'cancelled' : task.status;
        // Enrich the reconciled-completion row too (issue #1582) — the task is
        // already in hand here, so join its cost/artifacts directly.
        const enrichment = deriveLedgerEnrichment(task);
        // Keep the failure counter accurate across a restart-reconciled run and
        // evaluate the alert edge on it (issue #1665). Emitting here rather than
        // suppressing it closes a gap: a reconciled `cancelled` run that lands
        // exactly on the threshold would otherwise consume the crossing edge
        // silently, so a later live failure (already at/over threshold) could
        // never fire. The edge trigger caps this at one alert per crossing
        // schedule — bounded to schedules that had a mid-flight run at crash,
        // not a boot-wide storm. `completed` resets; `cancelled`/`terminated`
        // increment and may auto-pause (issue #2353).
        const reconciledFailures = nextConsecutiveFailures(schedule.consecutiveFailures, scheduleOutcome);
        const autoPause = this.autoPausePatch(schedule, reconciledFailures);
        this.store.replace({
          ...schedule,
          lastRunAt: task.updatedAt.toISOString(),
          lastRunTaskId: task.id,
          lastRunStatus: scheduleOutcome,
          consecutiveFailures: reconciledFailures,
          ...autoPause,
          latestExecution: {
            ...latest,
            outcome: scheduleOutcome,
            reasonCode: 'reconciled_after_restart',
          },
          executionLedger: updateLedgerEntryForTask(schedule.executionLedger, task.id, {
            outcome: scheduleOutcome,
            reasonCode: 'reconciled_after_restart',
            completedAt: task.updatedAt.toISOString(),
            ...(enrichment.tokenUsage ? { tokenUsage: enrichment.tokenUsage } : {}),
            ...(enrichment.artifacts ? { artifacts: enrichment.artifacts } : {}),
            ...(enrichment.mergeCommit ? { mergeCommit: enrichment.mergeCommit } : {}),
          }),
          ...(schedule.currentExecution ? {
            currentExecution: {
              ...schedule.currentExecution,
              status: 'terminal',
            },
          } : {}),
        });
        changed = true;
        // Evaluate the alert edge against the pre-reconcile snapshot (issue
        // #1665). `schedule` here is still the pre-`replace` value.
        this.emitFailureAlertOnEdge(
          schedule,
          reconciledFailures,
          undefined,
          Object.keys(autoPause).length > 0,
        );
      }
    }

    if (changed) {
      await this.store.persist();
      this.broadcastSchedules();
    }
  }

  async previewCron(cron: string) {
    if (!cron.trim()) {
      throw new ScheduleValidationError('Invalid cron expression', { cron: 'Required' });
    }
    const cronError = validateCron(cron);
    if (cronError) {
      throw new ScheduleValidationError('Invalid cron expression', { cron: cronError });
    }
    const { describeCron, nextRun } = await import('../core/cron.js');
    const nextRuns: string[] = [];
    let after = new Date();
    for (let i = 0; i < 3; i++) {
      const next = nextRun(cron, after);
      if (!next) break;
      nextRuns.push(next.toISOString());
      after = next;
    }
    return {
      cronDescription: describeCron(cron),
      nextRuns,
      timezone: currentTimezone(),
    };
  }

  private requireSchedule(id: string): Schedule {
    const schedule = this.store.get(id);
    if (!schedule) throw new ScheduleValidationError(`Schedule not found: ${id}`);
    return schedule;
  }

  private requireReceipt(schedule: Schedule, receiptId: string) {
    if (!schedule.currentExecution || schedule.currentExecution.id !== receiptId) {
      throw new ScheduleValidationError(`Execution receipt not found: ${receiptId}`);
    }
    return schedule.currentExecution;
  }

  private broadcastSchedules(): void {
    this.broadcast?.(this.listResponse());
  }
}

function currentTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function consumeCronTrigger(
  schedule: Schedule,
  trigger: 'cron' | 'manual',
  shouldConsume: boolean,
  now: string,
): Partial<Pick<Schedule, 'remainingTriggers' | 'enabled' | 'stopReason' | 'exhaustedAt'>> {
  if (!shouldConsume || trigger !== 'cron' || schedule.maxTriggers === undefined) {
    return {};
  }

  const remainingBefore = schedule.remainingTriggers ?? schedule.maxTriggers;
  const remainingTriggers = Math.max(remainingBefore - 1, 0);
  return {
    remainingTriggers,
    ...(remainingTriggers === 0 ? {
      enabled: false,
      stopReason: 'trigger_limit_reached' as const,
      exhaustedAt: schedule.exhaustedAt ?? now,
    } : {
      stopReason: undefined,
      exhaustedAt: undefined,
    }),
  };
}

function ledgerEntryFromReceipt(
  schedule: Schedule,
  receipt: NonNullable<Schedule['currentExecution']>,
  outcome: ScheduleExecutionOutcome,
  reasonCode: ScheduleExecutionReasonCode,
  details: {
    completedAt: string;
    taskId?: string;
    blockingTaskId?: string;
    message?: string;
    launchPhaseTimings?: LaunchPhaseTimings;
  },
): ScheduleExecutionLedgerEntry {
  return {
    id: ledgerKeyFor(schedule.id, receipt.trigger, receipt.scheduledFor ?? receipt.id),
    scheduleId: schedule.id,
    receiptId: receipt.id,
    executionToken: receipt.executionToken,
    trigger: receipt.trigger,
    decision: receipt.decision,
    ...(receipt.scheduledFor ? { scheduledFor: receipt.scheduledFor } : {}),
    evaluatedAt: receipt.evaluatedAt,
    completedAt: details.completedAt,
    outcome,
    reasonCode,
    ...(details.taskId ? { taskId: details.taskId } : {}),
    ...(details.blockingTaskId ? { blockingTaskId: details.blockingTaskId } : {}),
    ...(details.message ? { message: details.message } : {}),
    ...(details.launchPhaseTimings ? { launchPhaseTimings: details.launchPhaseTimings } : {}),
  };
}

function updateLedgerEntryForTask(
  ledger: ScheduleExecutionLedgerEntry[],
  taskId: string,
  patch: Pick<ScheduleExecutionLedgerEntry, 'outcome' | 'reasonCode' | 'completedAt'> & Partial<Pick<ScheduleExecutionLedgerEntry, 'message' | 'tokenUsage' | 'artifacts' | 'mergeCommit'>>,
): ScheduleExecutionLedgerEntry[] {
  let updated = false;
  const next = ledger.map((entry) => {
    if (entry.taskId !== taskId) return entry;
    updated = true;
    return { ...entry, ...patch };
  });
  return updated ? next : ledger;
}

/**
 * Close the original fire's mid-flight ledger row without rewriting overlap
 * skip rows that borrowed the same taskId as a blocking pointer (issue #2458).
 */
function closeMidFlightLedgerRowsForTask(
  ledger: ScheduleExecutionLedgerEntry[],
  taskId: string,
  patch: Pick<ScheduleExecutionLedgerEntry, 'outcome' | 'reasonCode' | 'completedAt'> & Partial<Pick<ScheduleExecutionLedgerEntry, 'message' | 'tokenUsage' | 'artifacts' | 'mergeCommit'>>,
): ScheduleExecutionLedgerEntry[] {
  let updated = false;
  const next = ledger.map((entry) => {
    if (entry.taskId !== taskId) return entry;
    if (SKIP_POINTER_OUTCOMES.has(entry.outcome)) return entry;
    updated = true;
    return { ...entry, ...patch };
  });
  return updated ? next : ledger;
}

function upsertLedgerEntry(
  ledger: ScheduleExecutionLedgerEntry[],
  entry: ScheduleExecutionLedgerEntry,
): ScheduleExecutionLedgerEntry[] {
  const index = ledger.findIndex((candidate) => candidate.id === entry.id);
  // Only an append grows the ledger, so it is the sole path that can breach the
  // cap (issue #1392) — prune the newest entry in, keeping pending rows a later
  // reconcile depends on. An in-place update never changes length, so it stays
  // untouched.
  if (index === -1) return pruneExecutionLedger([...ledger, entry]);
  return [
    ...ledger.slice(0, index),
    { ...ledger[index], ...entry },
    ...ledger.slice(index + 1),
  ];
}

function ledgerKeyFor(scheduleId: string, trigger: 'cron' | 'manual', key: string): string {
  return `${scheduleId}:${trigger}:${key}`;
}
