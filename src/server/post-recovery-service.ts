/**
 * Post-recovery critical-schedule re-arm + queue-fill kick (issue #2196).
 *
 * After multi-day outages / daemon restarts the fleet can return meta-only
 * while:
 *   1. Allowlisted residual schedules stay `enabled=false` (ops drift)
 *   2. Free slots sit idle with an empty queue and no product refill
 *
 * This service:
 *   A. Re-enables allowlisted critical schedules that lack an operator hold
 *   B. When free≥N + empty queue + healthy dispatch: at most one scout+batch
 *      kick per product repo per UTC day (skips when scout/batch already active).
 *      A create-then-`launch_error` (expired Grok session login) does not
 *      persist the UTC-day key or stamp `lastStarvationScoutAt`, so the next
 *      tick can retry (issue #2744). No pay-per-token API-key auth path.
 *
 * Eligibility decisions live in `core/critical-schedule-rearm` and
 * `core/post-recovery-queue-fill`. This module owns timer and retry
 * bookkeeping, durable day keys, audit rows, and launches (reusing starvation
 * scout/batch helpers).
 */

import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { atomicWriteFile } from '../core/persistence-utils.js';
import { appendAuditRow } from '../core/audit-log.js';
import {
  decideCriticalScheduleRearm,
  type CriticalRearmScheduleView,
} from '../core/critical-schedule-rearm.js';
import {
  decidePostRecoveryQueueFill,
  POST_RECOVERY_KICK_STATE_SCHEMA,
  POST_RECOVERY_MIN_FREE_SLOTS,
  postRecoveryKickIdempotencyKey,
  type PostRecoveryKickRepoState,
} from '../core/post-recovery-queue-fill.js';
import {
  defaultCheckoutGuess,
  isParallelIssueBatchInFlightForRepo,
  isParallelIssueBatchPlaybookId,
  isValidRepoFullName,
  repoToPlaybookSlug,
  STARVATION_SCOUT_LAUNCH_ERROR_RETRY_CAP,
} from '../core/pipeline-starvation.js';
import {
  countTerminatedAtLaunchIdeaScoutsForRepo,
  isIdeaScoutInFlightForRepo,
} from '../core/pipeline-starvation-ideation.js';
import { isTerminatedAtLaunch } from '../shared/contracts/task.js';
import {
  loadPipelineStarvationState,
  savePipelineStarvationState,
} from '../core/pipeline-starvation-state.js';
import { projectIdFromRepoSpecifier } from '../core/project-identity.js';
import type { Schedule } from '../core/schedule.js';
import type { Task, TaskStore } from '../core/tasks.js';
import type { CapacityLedger } from '../core/capacity-ledger.js';
import type { LaunchOpts, LaunchResult } from './launch-service.js';
import { preparePlaybookLaunchWithMetadata } from './use-cases/playbook-launch.js';

export const POST_RECOVERY_PROVENANCE = 'post-recovery' as const;

/** Default tick period — recovery is not urgent; 60s matches idle-refinery. */
export const DEFAULT_POST_RECOVERY_TICK_MS = 60_000;
/** Fixed delay keeps persistence retries sparse and predictable. */
const CRITICAL_REARM_RETRY_DELAY_MS = 60_000;
/** Initial attempt plus two later-tick retries. */
const CRITICAL_REARM_MAX_ATTEMPTS = 3;

export interface ProductBatchRepoCandidate {
  repo: string;
  localPath?: string;
}

export interface PostRecoveryServiceDeps {
  /** List all schedules (enabled + disabled). */
  listSchedules: () => readonly Schedule[];
  /** Persist-enabled toggle (clears hold on enable). */
  setEnabled: (id: string, enabled: boolean) => Promise<unknown> | unknown;
  taskStore: TaskStore;
  /** Same capacity ledger as health / idle-refinery. */
  getCapacityLedger: () => CapacityLedger;
  launcher: (opts: LaunchOpts) => Promise<LaunchResult>;
  /**
   * True when dispatch can launch product work (not fleet-wide auth_expired /
   * zero launchable agents). Defaults to true when omitted.
   */
  isDispatchHealthy?: () => boolean;
  /** Operator drain gate. */
  isAccepting?: () => boolean;
  /** Automation kill-switch (SAFE MODE). */
  isAutomationEnabled?: () => boolean;
  /** `~/.kookr` for audit.jsonl. */
  kookrDir?: string;
  /** Override durable post-recovery kick state dir (tests). */
  kickStateDir?: string;
  /** Override pipeline-starvation state dir when arming scout-complete kick. */
  starvationStateDir?: string;
  now?: () => number;
  log?: (line: string) => void;
  tickIntervalMs?: number;
  /** Free-slot floor (default {@link POST_RECOVERY_MIN_FREE_SLOTS}). */
  minFreeSlots?: number;
}

export interface RearmResult {
  rearmed: Array<{ id: string; name: string }>;
  skipped: Array<{ id: string; name: string; reason: string }>;
  auditFailed: Array<{ id: string; name: string; reason: string }>;
}

interface CriticalRearmRetryState {
  id: string;
  name: string;
  attempts: number;
  nextAttemptAt: number;
}

/**
 * Whether a launched scout's completion-trigger batch arm was durably persisted
 * (issue #2856). `'armed'` — the scout-complete kick state saved, so implement
 * re-enters the batch path when the scout finishes. `'failed'` — the scout is
 * live (slot + UTC day consumed, not retried) but persisting its batch arm
 * failed, so the queue-fill link is broken until the next kick window. It never
 * implies the future batch itself succeeded — only that arming it persisted.
 */
export type PostRecoveryBatchArmStatus = 'armed' | 'failed';

/** Internal outcome of {@link PostRecoveryService.armStarvationKickAfterScout}. */
type BatchArmOutcome =
  | { status: 'armed' }
  | { status: 'failed'; error: string };

/**
 * Max characters of arm-failure detail recorded in the degraded audit row
 * (issue #2856). Bounds a persistence stack trace / long fs error so it cannot
 * bloat audit.jsonl while preserving enough to diagnose the broken queue-fill
 * link.
 */
export const POST_RECOVERY_BATCH_ARM_ERROR_MAX = 500;

export function boundedBatchArmError(message: string): string {
  const trimmed = message.trim();
  return trimmed.length > POST_RECOVERY_BATCH_ARM_ERROR_MAX
    ? `${trimmed.slice(0, POST_RECOVERY_BATCH_ARM_ERROR_MAX)}…`
    : trimmed;
}

export interface QueueFillKickResult {
  repo: string;
  kicked: boolean;
  reason?: string;
  scoutTaskId?: string;
  utcDay?: string;
  /**
   * Present only when `kicked` is true: whether the scout-completion batch arm
   * was durably persisted (issue #2856). See {@link PostRecoveryBatchArmStatus}.
   * A `'failed'` value still means the scout launched and consumed its slot/day
   * — it is a degraded-success signal, not a launch failure.
   */
  batchArmStatus?: PostRecoveryBatchArmStatus;
}

export const POST_RECOVERY_QUEUE_FILL_HEALTH_SCHEMA = 'post-recovery-queue-fill.v1' as const;
/** Latest-evaluation rows only; prevents a large schedule fleet from bloating health. */
export const POST_RECOVERY_QUEUE_FILL_HEALTH_RESULT_LIMIT = 25;

export type PostRecoveryQueueFillHealthState =
  | 'not_started'
  | 'suppressed'
  | 'completed'
  | 'error';

export type PostRecoveryQueueFillTickReason =
  | 'operator_drain'
  | 'safe_mode'
  | 'tick_overlap'
  | 'tick_error';

export type PostRecoveryQueueFillResultReason =
  | 'scout_launched'
  | 'scout_launched_latch_persist_failed'
  | 'insufficient_free_slots'
  | 'queue_not_empty'
  | 'dispatch_unhealthy'
  | 'scout_or_batch_in_flight'
  | 'already_kicked_utc_day'
  | 'launch_error_retry_exhausted'
  | 'scout_terminated_at_launch'
  | 'scout_launch_failed';

export interface PostRecoveryQueueFillHealthResult {
  repository: string;
  utcDay: string;
  kicked: boolean;
  reason: PostRecoveryQueueFillResultReason;
  evaluatedAt: string;
  ageMs: number;
  scoutTaskId?: string;
}

export interface PostRecoveryQueueFillHealthSnapshot {
  schemaVersion: typeof POST_RECOVERY_QUEUE_FILL_HEALTH_SCHEMA;
  state: PostRecoveryQueueFillHealthState;
  evaluatedAt: string | null;
  ageMs: number | null;
  reason: PostRecoveryQueueFillTickReason | null;
  resultLimit: typeof POST_RECOVERY_QUEUE_FILL_HEALTH_RESULT_LIMIT;
  truncated: boolean;
  results: PostRecoveryQueueFillHealthResult[];
}

type StoredQueueFillHealthResult = Omit<PostRecoveryQueueFillHealthResult, 'ageMs'>;

interface StoredQueueFillHealthSnapshot {
  state: PostRecoveryQueueFillHealthState;
  evaluatedAtMs: number | null;
  reason: PostRecoveryQueueFillTickReason | null;
  truncated: boolean;
  results: StoredQueueFillHealthResult[];
}

export class PostRecoveryService {
  private interval: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private stopped = false;
  /**
   * The fleet-wide pass runs once per process lifetime. Only schedule IDs whose
   * persistence-backed enable failed remain eligible on bounded later ticks.
   * This avoids reprocessing successful schedules or fighting operator Pause.
   */
  private criticalRearmInitialPassDone = false;
  private readonly criticalRearmRetries = new Map<string, CriticalRearmRetryState>();
  private readonly deps: PostRecoveryServiceDeps;
  /** Latest queue-fill evaluation only; no history or request-time I/O. */
  private queueFillHealth: StoredQueueFillHealthSnapshot = {
    state: 'not_started',
    evaluatedAtMs: null,
    reason: null,
    truncated: false,
    results: [],
  };

  constructor(deps: PostRecoveryServiceDeps) {
    this.deps = deps;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private auditPath(): string | undefined {
    return this.deps.kookrDir ? join(this.deps.kookrDir, 'audit.jsonl') : undefined;
  }

  /** Cheap, detached process-local snapshot for GET `/api/health`. */
  getQueueFillHealthSnapshot(): PostRecoveryQueueFillHealthSnapshot {
    const evaluatedAtMs = this.queueFillHealth.evaluatedAtMs;
    const ageMs = evaluatedAtMs === null ? null : Math.max(0, this.now() - evaluatedAtMs);
    return {
      schemaVersion: POST_RECOVERY_QUEUE_FILL_HEALTH_SCHEMA,
      state: this.queueFillHealth.state,
      evaluatedAt: evaluatedAtMs === null ? null : new Date(evaluatedAtMs).toISOString(),
      ageMs,
      reason: this.queueFillHealth.reason,
      resultLimit: POST_RECOVERY_QUEUE_FILL_HEALTH_RESULT_LIMIT,
      truncated: this.queueFillHealth.truncated,
      results: this.queueFillHealth.results.map((result) => ({
        ...result,
        ageMs: ageMs ?? 0,
      })),
    };
  }

  private recordQueueFillTick(
    state: Exclude<PostRecoveryQueueFillHealthState, 'not_started' | 'completed'>,
    reason: PostRecoveryQueueFillTickReason,
  ): void {
    this.queueFillHealth = {
      state,
      evaluatedAtMs: this.now(),
      reason,
      truncated: false,
      results: [],
    };
  }

  private recordCompletedQueueFill(results: QueueFillKickResult[]): void {
    const evaluatedAtMs = this.now();
    const evaluatedAt = new Date(evaluatedAtMs).toISOString();
    const utcDay = evaluatedAt.slice(0, 10);
    this.queueFillHealth = {
      state: 'completed',
      evaluatedAtMs,
      reason: null,
      truncated: results.length > POST_RECOVERY_QUEUE_FILL_HEALTH_RESULT_LIMIT,
      results: results
        .slice(0, POST_RECOVERY_QUEUE_FILL_HEALTH_RESULT_LIMIT)
        .map((result) => queueFillHealthResult(result, evaluatedAt, utcDay)),
    };
  }

  private kickStateDir(): string {
    if (this.deps.kickStateDir) return this.deps.kickStateDir;
    // When kookrDir is set (prod `~/.kookr` or test temp), keep kick state under it.
    if (this.deps.kookrDir) {
      return join(this.deps.kookrDir, 'playbook-state', 'post-recovery-queue-fill');
    }
    return join(homedir(), '.kookr', 'playbook-state', 'post-recovery-queue-fill');
  }

  start(): void {
    if (this.interval) return;
    const period = this.deps.tickIntervalMs ?? DEFAULT_POST_RECOVERY_TICK_MS;
    this.interval = setInterval(() => {
      void this.tick();
    }, period);
    this.interval.unref?.();
    // Deferred first pass (not sync-on-listen): lets startup recovery finish
    // and avoids competing with boot hooks under test load. Still well inside
    // one schedule tick after daemon start.
    const firstDelayMs = Math.min(5_000, period);
    const first = setTimeout(() => {
      void this.tick();
    }, firstDelayMs);
    first.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /**
   * One recovery pass: re-arm critical schedules, then queue-fill kicks for
   * product batch repos. Exposed for tests. Never throws.
   */
  async tick(): Promise<{ rearm: RearmResult; kicks: QueueFillKickResult[] }> {
    const empty: { rearm: RearmResult; kicks: QueueFillKickResult[] } = {
      rearm: { rearmed: [], skipped: [], auditFailed: [] },
      kicks: [],
    };
    if (this.stopped) return empty;
    if (this.ticking) {
      this.recordQueueFillTick('suppressed', 'tick_overlap');
      return empty;
    }
    this.ticking = true;
    try {
      if (this.deps.isAccepting && !this.deps.isAccepting()) {
        this.recordQueueFillTick('suppressed', 'operator_drain');
        return empty;
      }
      if (this.deps.isAutomationEnabled && !this.deps.isAutomationEnabled()) {
        this.recordQueueFillTick('suppressed', 'safe_mode');
        return empty;
      }

      let rearm: RearmResult = { rearmed: [], skipped: [], auditFailed: [] };
      if (!this.criticalRearmInitialPassDone || this.criticalRearmRetries.size > 0) {
        rearm = await this.rearmCriticalSchedules();
      }
      const kicks = await this.runQueueFillKicks();
      this.recordCompletedQueueFill(kicks);
      return { rearm, kicks };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.log?.(`[post-recovery] tick failed: ${message}`);
      this.recordQueueFillTick('error', 'tick_error');
      return empty;
    } finally {
      this.ticking = false;
    }
  }

  /** Re-enable allowlisted critical schedules without operator hold. */
  async rearmCriticalSchedules(): Promise<RearmResult> {
    const rearmed: RearmResult['rearmed'] = [];
    const skipped: RearmResult['skipped'] = [];
    const auditFailed: RearmResult['auditFailed'] = [];
    const initialPass = !this.criticalRearmInitialPassDone;
    const candidates: Array<{ id: string; retry?: CriticalRearmRetryState }> = [];

    if (initialPass) {
      for (const schedule of this.deps.listSchedules()) {
        candidates.push({ id: schedule.id });
      }
      this.criticalRearmInitialPassDone = true;
    } else {
      for (const retry of this.criticalRearmRetries.values()) {
        candidates.push({ id: retry.id, retry });
      }
    }
    candidates.sort((a, b) => a.id.localeCompare(b.id));

    for (const candidate of candidates) {
      const retry = candidate.retry;
      if (retry && this.now() < retry.nextAttemptAt) continue;

      // Read immediately before each attempt. Earlier persistence calls in
      // this loop may yield long enough for an operator to hold, remove, or
      // exhaust a later schedule.
      const live = this.deps
        .listSchedules()
        .find((schedule) => schedule.id === candidate.id);
      if (!live) {
        if (retry) {
          const reason = 'schedule_removed';
          this.criticalRearmRetries.delete(retry.id);
          skipped.push({
            id: retry.id,
            name: retry.name,
            reason: `retry_cancelled:${reason}`,
          });
          this.deps.log?.(
            `[post-recovery] re-arm retry cancelled for "${retry.name}" (${retry.id}): ${reason}`,
          );
        }
        continue;
      }
      const schedule: CriticalRearmScheduleView = {
        id: live.id,
        name: live.name,
        enabled: live.enabled,
        operatorHold: live.operatorHold,
        holdSource: live.holdSource,
        stopReason: live.stopReason,
        maxTriggers: live.maxTriggers,
        remainingTriggers: live.remainingTriggers,
        playbook: { path: live.playbook.path },
      };
      // A rejected ScheduleService persistence call may already have mutated
      // the in-memory row to enabled=true. Retry provenance is authoritative
      // for that one ID, while every other live eligibility field is re-read.
      const decision = decideCriticalScheduleRearm(
        retry ? { ...schedule, enabled: false } : schedule,
      );
      if (!decision.rearm) {
        if (retry) {
          this.criticalRearmRetries.delete(schedule.id);
          const reason = `retry_cancelled:${decision.reason}`;
          skipped.push({ id: retry.id, name: retry.name, reason });
          this.deps.log?.(
            `[post-recovery] re-arm retry cancelled for "${retry.name}" (${retry.id}): ${decision.reason}`,
          );
          continue;
        }
        // Only audit/skip-log allowlisted holds so noise stays low.
        if (decision.reason === 'operator_hold') {
          skipped.push({ id: schedule.id, name: schedule.name, reason: decision.reason });
        }
        continue;
      }

      const attempt = (retry?.attempts ?? 0) + 1;
      const maxAttempts = CRITICAL_REARM_MAX_ATTEMPTS;
      try {
        await this.deps.setEnabled(schedule.id, true);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (attempt >= maxAttempts) {
          this.criticalRearmRetries.delete(schedule.id);
          skipped.push({
            id: schedule.id,
            name: schedule.name,
            reason: `retry_exhausted:attempt_${attempt}_of_${maxAttempts}:${message}`,
          });
          this.deps.log?.(
            `[post-recovery] re-arm retry exhausted for "${schedule.name}" (${schedule.id}) after ${attempt} attempts: ${message}`,
          );
        } else {
          this.criticalRearmRetries.set(schedule.id, {
            id: schedule.id,
            name: schedule.name,
            attempts: attempt,
            nextAttemptAt: this.now() + CRITICAL_REARM_RETRY_DELAY_MS,
          });
          skipped.push({
            id: schedule.id,
            name: schedule.name,
            reason: `retry_scheduled:attempt_${attempt}_of_${maxAttempts}:${message}`,
          });
          this.deps.log?.(
            `[post-recovery] re-arm failed for "${schedule.name}" (${schedule.id}) on attempt ${attempt}/${maxAttempts}: ${message}; retrying in ${CRITICAL_REARM_RETRY_DELAY_MS}ms`,
          );
        }
        continue;
      }

      this.criticalRearmRetries.delete(schedule.id);
      rearmed.push({ id: schedule.id, name: schedule.name });
      this.deps.log?.(
        `[post-recovery] re-armed critical schedule "${schedule.name}" (${schedule.id})`,
      );
      const rearmedAt = this.now();
      let auditDidFail = false;
      let auditError: unknown;
      await appendAuditRow(
        this.auditPath(),
        {
          action: 'critical_schedule_rearm',
          provenance: POST_RECOVERY_PROVENANCE,
          scheduleId: schedule.id,
          scheduleName: schedule.name,
          playbookPath: schedule.playbook.path,
          at: new Date(rearmedAt).toISOString(),
        },
        {
          onError: (error) => {
            auditDidFail = true;
            auditError = error;
          },
        },
      );
      if (auditDidFail) {
        const message = auditError instanceof Error ? auditError.message : String(auditError);
        auditFailed.push({ id: schedule.id, name: schedule.name, reason: message });
        this.deps.log?.(
          `[post-recovery] re-arm audit failed for "${schedule.name}" (${schedule.id}) after enable succeeded: ${message}`,
        );
      }
    }

    return { rearmed, skipped, auditFailed };
  }

  /** Capacity-gated, per-repo, once-per-UTC-day scout kicks. */
  async runQueueFillKicks(): Promise<QueueFillKickResult[]> {
    const ledger = this.deps.getCapacityLedger();
    const effectiveFree = Math.min(
      ledger.free,
      ledger.freeForGeneralSources ?? ledger.free,
    );
    const dispatchHealthy = this.deps.isDispatchHealthy?.() ?? true;
    const tasks = this.deps.taskStore.listTasks();
    const candidates = collectProductBatchRepos(this.deps.listSchedules());
    const results: QueueFillKickResult[] = [];
    const nowMs = this.now();
    const minFree = this.deps.minFreeSlots ?? POST_RECOVERY_MIN_FREE_SLOTS;
    // Local free budget so multi-repo product fleets cannot over-spawn in one
    // tick against a frozen ledger snapshot (W1).
    let freeBudget = effectiveFree;

    for (const candidate of candidates) {
      const priorKick = await loadKickState(candidate.repo, this.kickStateDir());
      const scoutInFlight = isIdeaScoutInFlightForRepo(candidate.repo, tasks);
      const batchInFlight = isParallelIssueBatchInFlightForRepo(candidate.repo, tasks);
      const decision = decidePostRecoveryQueueFill({
        free: freeBudget,
        pendingQueueDepth: ledger.pendingQueueDepth,
        dispatchHealthy,
        scoutOrBatchInFlight: scoutInFlight || batchInFlight,
        lastKickUtcDay: priorKick?.lastKickUtcDay ?? null,
        repo: candidate.repo,
        minFreeSlots: minFree,
        nowMs,
      });

      if (!decision.kick) {
        results.push({
          repo: candidate.repo,
          kicked: false,
          reason: decision.reason,
          utcDay: decision.utcDay,
        });
        continue;
      }

      const utcDayStartMs = Date.parse(`${decision.utcDay}T00:00:00.000Z`);
      const launchErrorRetries = Number.isFinite(utcDayStartMs)
        ? countTerminatedAtLaunchIdeaScoutsForRepo(candidate.repo, tasks, utcDayStartMs)
        : 0;
      if (launchErrorRetries >= STARVATION_SCOUT_LAUNCH_ERROR_RETRY_CAP) {
        const message =
          `scout launch_error retry budget exhausted (${launchErrorRetries} today)`;
        this.deps.log?.(
          `[post-recovery] queue-fill kick skipped for ${candidate.repo}: ${message}`,
        );
        await appendAuditRow(this.auditPath(), {
          action: 'post_recovery_queue_fill_kick_failed',
          provenance: POST_RECOVERY_PROVENANCE,
          repo: candidate.repo,
          utcDay: decision.utcDay,
          error: message,
          at: new Date(nowMs).toISOString(),
        });
        results.push({
          repo: candidate.repo,
          kicked: false,
          reason: `error:${message}`,
          utcDay: decision.utcDay,
        });
        continue;
      }

      try {
        const launch = await this.spawnRecoveryScout(
          candidate,
          decision.utcDay,
          nowMs,
          launchErrorRetries,
        );
        const launched = this.deps.taskStore.getTask(launch.task.id) ?? launch.task;
        if (isTerminatedAtLaunch(launched)) {
          const detail = launched.disposition?.detail?.trim()
            || launched.disposition?.reason
            || 'launch_error';
          const message = `scout died at launch (${detail})`;
          this.deps.log?.(
            `[post-recovery] queue-fill kick failed for ${candidate.repo}: ${message}`
            + ' — not stamping lastStarvationScoutAt',
          );
          await appendAuditRow(this.auditPath(), {
            action: 'post_recovery_queue_fill_kick_failed',
            provenance: POST_RECOVERY_PROVENANCE,
            repo: candidate.repo,
            utcDay: decision.utcDay,
            scoutTaskId: launched.id,
            error: message,
            disposition: launched.disposition?.reason ?? 'launch_error',
            at: new Date(nowMs).toISOString(),
          });
          results.push({
            repo: candidate.repo,
            kicked: false,
            reason: `error:${message}`,
            scoutTaskId: launched.id,
            utcDay: decision.utcDay,
          });
          continue;
        }
        const scoutTaskId = launched.id;

        // Arm starvation scout-complete batch kick so implement re-enters when
        // the scout finishes (reuses #1715 R5 path when KOOKR_PIPELINE_BATCH_KICK
        // is on; still records lastStarvationScoutTaskId for open-episode match).
        // The scout is already live: a persistence failure here degrades the kick
        // (the completion→batch link is broken) but does NOT unlaunch it — the
        // slot/day are still consumed and it is not retried (issue #2856).
        const batchArm = await this.armStarvationKickAfterScout(
          candidate.repo,
          scoutTaskId,
          nowMs,
        );

        const nextState: PostRecoveryKickRepoState = {
          schemaVersion: POST_RECOVERY_KICK_STATE_SCHEMA,
          repo: candidate.repo,
          lastKickUtcDay: decision.utcDay,
          lastKickAt: new Date(nowMs).toISOString(),
          lastKickScoutTaskId: scoutTaskId,
          updatedAt: new Date(nowMs).toISOString(),
        };
        try {
          await saveKickState(nextState, this.kickStateDir());
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.deps.log?.(
            `[post-recovery] scout ${scoutTaskId} launched for ${candidate.repo}`
            + ` but the daily kick latch could not be persisted: ${message}`,
          );
          await appendAuditRow(this.auditPath(), {
            action: 'post_recovery_queue_fill_kick_failed',
            provenance: POST_RECOVERY_PROVENANCE,
            repo: candidate.repo,
            utcDay: decision.utcDay,
            scoutTaskId,
            error: `daily kick latch persistence failed: ${message}`,
            at: new Date(nowMs).toISOString(),
          });
          // The scout consumed capacity even though the daily latch failed.
          freeBudget = Math.max(0, freeBudget - 1);
          results.push({
            repo: candidate.repo,
            kicked: true,
            reason: 'error:daily kick latch persistence failed',
            scoutTaskId,
            utcDay: decision.utcDay,
            batchArmStatus: batchArm.status,
          });
          continue;
        }

        // Ordinary launch audit is always written (retains #2196 launch-count
        // telemetry); `batchArmStatus` is an additive field, so existing
        // consumers that count `post_recovery_queue_fill_kick` rows are
        // unaffected (issue #2856).
        await appendAuditRow(this.auditPath(), {
          action: 'post_recovery_queue_fill_kick',
          provenance: POST_RECOVERY_PROVENANCE,
          repo: candidate.repo,
          utcDay: decision.utcDay,
          scoutTaskId,
          queued: launch.queued === true,
          free: freeBudget,
          pendingQueueDepth: ledger.pendingQueueDepth,
          batchArmStatus: batchArm.status,
          at: new Date(nowMs).toISOString(),
        });

        if (batchArm.status === 'failed') {
          // Distinct degraded audit + log so operators can tell a launched-but-
          // unarmed scout from a healthy kick, with bounded error detail. The
          // scout still counts as kicked and consumed its slot/day (issue #2856).
          await appendAuditRow(this.auditPath(), {
            action: 'post_recovery_batch_arm_failed',
            provenance: POST_RECOVERY_PROVENANCE,
            repo: candidate.repo,
            utcDay: decision.utcDay,
            scoutTaskId,
            error: boundedBatchArmError(batchArm.error),
            at: new Date(nowMs).toISOString(),
          });
          this.deps.log?.(
            `[post-recovery] queue-fill kick for ${candidate.repo} → scout ${scoutTaskId}`
            + ' launched but batch-arm persistence FAILED — scout will not re-enter'
            + ` the batch path this kick window: ${batchArm.error}`,
          );
        } else {
          this.deps.log?.(
            `[post-recovery] queue-fill kick for ${candidate.repo} → scout ${scoutTaskId}`
            + `${launch.queued ? ' (queued)' : ''}`,
          );
        }

        // One successful kick consumes a free slot from this tick's budget.
        // A failed batch-arm does not change this: the scout is live either way.
        freeBudget = Math.max(0, freeBudget - 1);

        results.push({
          repo: candidate.repo,
          kicked: true,
          scoutTaskId,
          utcDay: decision.utcDay,
          batchArmStatus: batchArm.status,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.deps.log?.(
          `[post-recovery] queue-fill kick failed for ${candidate.repo}: ${message}`,
        );
        await appendAuditRow(this.auditPath(), {
          action: 'post_recovery_queue_fill_kick_failed',
          provenance: POST_RECOVERY_PROVENANCE,
          repo: candidate.repo,
          utcDay: decision.utcDay,
          error: message,
          at: new Date(nowMs).toISOString(),
        });
        results.push({
          repo: candidate.repo,
          kicked: false,
          reason: `error:${message}`,
          utcDay: decision.utcDay,
        });
      }
    }

    return results;
  }

  private async spawnRecoveryScout(
    candidate: ProductBatchRepoCandidate,
    utcDay: string,
    nowMs: number,
    launchErrorRetries = 0,
  ): Promise<LaunchResult> {
    const localPath = candidate.localPath?.trim() || '';
    const projectId = projectIdFromRepoSpecifier(candidate.repo) ?? undefined;
    const taskTargetCwd = localPath || defaultCheckoutGuess(candidate.repo);

    const prepared = await preparePlaybookLaunchWithMetadata({
      cwd: taskTargetCwd,
      playbookPath: 'repository-idea-scout.md',
      scope: 'plugin',
      parameterValues: {
        repoFullName: candidate.repo,
        localPath: localPath || '',
        workProfile: 'balanced',
        workloadSize: 'quick-shortlist',
        publishBehavior: 'publish-safe',
        minimumIssueScan: '100',
        useKnowledgeBase: 'auto',
        extraInstruction:
          `Post-recovery queue-fill kick (issue #2196, provenance=${POST_RECOVERY_PROVENANCE}, `
          + `utcDay=${utcDay}). Free capacity returned with an empty queue after outage/restart. `
          + `Prefer single-PR-safe leaves; do not invent low-product work.`,
      },
      taskTargetCwd,
      taskTargetCwdExplicit: true,
    });

    const launchOpts: LaunchOpts = {
      ...prepared.launchOpts,
      playbookId: prepared.launchOpts.playbookId ?? 'repository-idea-scout.md',
      projectId: prepared.launchOpts.projectId ?? projectId,
      // First-class autonomous source (issue #2899): SAFE MODE is re-checked at
      // the launch boundary AFTER this asynchronous playbook preparation, so a
      // kill-switch engaged mid-preparation still rejects the recovery scout.
      // Stays spawn-budget-capped (only `schedule` is budget-exempt).
      launchSource: 'post-recovery',
      disableDedup: true,
      autoCloseOnSignal: true,
      idempotencyKey: postRecoveryKickIdempotencyKey(
        candidate.repo,
        utcDay,
        launchErrorRetries,
      ),
      name: `Idea scout (post-recovery fill): ${candidate.repo}`,
    };

    return this.deps.launcher(launchOpts);
  }

  /**
   * Persist the scout-complete batch-kick arm. Returns `{status:'armed'}` on
   * success and `{status:'failed', error}` when loading or saving the durable
   * starvation state throws — the caller keeps the scout kicked and records a
   * degraded audit/result (issue #2856). This helper never throws.
   */
  private async armStarvationKickAfterScout(
    repo: string,
    scoutTaskId: string,
    nowMs: number,
  ): Promise<BatchArmOutcome> {
    try {
      const prior = await loadPipelineStarvationState(repo, {
        stateDir: this.deps.starvationStateDir,
        nowMs,
      });
      const nowIso = new Date(nowMs).toISOString();
      const next = {
        ...prior,
        lastStarvationScoutAt: nowIso,
        lastStarvationScoutTaskId: scoutTaskId,
        kickBatchWhenScoutCompletes: true,
        kickBatchWhenScoutCompletesAt: nowIso,
        updatedAt: nowIso,
      };
      await savePipelineStarvationState(next, { stateDir: this.deps.starvationStateDir });
      return { status: 'armed' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.log?.(
        `[post-recovery] failed to arm starvation batch kick for ${repo}: ${message}`,
      );
      return { status: 'failed', error: message };
    }
  }
}

function queueFillHealthResult(
  result: QueueFillKickResult,
  evaluatedAt: string,
  fallbackUtcDay: string,
): StoredQueueFillHealthResult {
  return {
    repository: result.repo,
    utcDay: result.utcDay ?? fallbackUtcDay,
    kicked: result.kicked,
    reason: stableQueueFillResultReason(result),
    evaluatedAt,
    ...(result.scoutTaskId ? { scoutTaskId: result.scoutTaskId } : {}),
  };
}

function stableQueueFillResultReason(
  result: QueueFillKickResult,
): PostRecoveryQueueFillResultReason {
  if (result.reason === 'error:daily kick latch persistence failed') {
    return 'scout_launched_latch_persist_failed';
  }
  if (result.kicked) return 'scout_launched';
  switch (result.reason) {
    case 'insufficient_free_slots':
    case 'queue_not_empty':
    case 'dispatch_unhealthy':
    case 'scout_or_batch_in_flight':
    case 'already_kicked_utc_day':
      return result.reason;
    default:
      if (result.reason?.startsWith('error:scout launch_error retry budget exhausted')) {
        return 'launch_error_retry_exhausted';
      }
      if (result.reason?.startsWith('error:scout died at launch')) {
        return 'scout_terminated_at_launch';
      }
      return 'scout_launch_failed';
  }
}

/**
 * Product repos to consider for post-recovery fill: unique repoFullName from
 * parallel-issue-batch schedules (enabled or disabled). Disabled experimental
 * batches still name the product repo so recovery can refill after outage;
 * per-day + in-flight gates prevent thrash.
 */
export function collectProductBatchRepos(
  schedules: readonly Schedule[],
): ProductBatchRepoCandidate[] {
  const byRepo = new Map<string, ProductBatchRepoCandidate>();
  for (const schedule of schedules) {
    if (!isParallelIssueBatchPlaybookId(schedule.playbook.path)) continue;
    const repo = (
      schedule.playbook.parameters?.repoFullName
      ?? schedule.playbook.parameters?.repo
      ?? ''
    ).trim();
    if (!isValidRepoFullName(repo)) continue;
    const localPath = (schedule.playbook.parameters?.localPath ?? '').trim() || undefined;
    const key = repo.toLowerCase();
    const existing = byRepo.get(key);
    // Prefer enabled schedule's localPath when merging duplicates.
    if (!existing) {
      byRepo.set(key, { repo, localPath });
    } else if (schedule.enabled && localPath) {
      byRepo.set(key, { repo, localPath });
    } else if (!existing.localPath && localPath) {
      byRepo.set(key, { repo, localPath });
    }
  }
  return [...byRepo.values()].sort((a, b) => a.repo.localeCompare(b.repo));
}

function kickStatePath(stateDir: string, repo: string): string {
  return join(stateDir, `${repoToPlaybookSlug(repo)}.json`);
}

async function loadKickState(
  repo: string,
  stateDir: string,
): Promise<PostRecoveryKickRepoState | null> {
  try {
    const raw = await readFile(kickStatePath(stateDir, repo), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<PostRecoveryKickRepoState>;
    if (parsed.schemaVersion !== POST_RECOVERY_KICK_STATE_SCHEMA) return null;
    if (typeof parsed.repo !== 'string') return null;
    return {
      schemaVersion: POST_RECOVERY_KICK_STATE_SCHEMA,
      repo: parsed.repo,
      lastKickUtcDay: typeof parsed.lastKickUtcDay === 'string' ? parsed.lastKickUtcDay : undefined,
      lastKickAt: typeof parsed.lastKickAt === 'string' ? parsed.lastKickAt : undefined,
      lastKickScoutTaskId:
        typeof parsed.lastKickScoutTaskId === 'string' ? parsed.lastKickScoutTaskId : undefined,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}

async function saveKickState(
  state: PostRecoveryKickRepoState,
  stateDir: string,
): Promise<void> {
  const path = kickStatePath(stateDir, state.repo);
  await mkdir(dirname(path), { recursive: true });
  // lastKickScoutTaskId is operator-private — match sibling secret stores
  // (settings.json, share-grants) with owner-only mode via fchmod after umask.
  await atomicWriteFile(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}
