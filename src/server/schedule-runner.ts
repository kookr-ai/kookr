import { existsSync } from 'node:fs';
import type { ScheduleStore, Schedule } from '../core/schedule.js';
import { nextRun } from '../core/cron.js';
import { ScheduleValidationError, isTriggerLimitExhausted, scheduleResolutionSignature } from '../core/schedule.js';
import { resolvePlaybookInScope } from '../core/playbook-paths.js';
import { ScheduleService } from './schedule-service.js';
import { ScheduleValidator } from './schedule-validator.js';
import type { LaunchOpts, LaunchResult } from './launch-service.js';
import type { TaskStatus } from '../core/types.js';

const TICK_INTERVAL_MS = 60_000;
const CATCHUP_MAX_STALENESS_MS = 24 * 60 * 60 * 1000; // 24 hours

// A task is treated as still blocking its schedule only if its `updatedAt` is
// within this window. Beyond it, the prior run is presumed abandoned and the
// next cron tick is allowed to fire — preventing a hung task from permanently
// blocking the schedule (see PR description for the codex-rebase incident).
// Calibrated for schedules with daily-or-longer cadence; sub-daily schedules
// will tolerate up to 12h of "previous run still active" before recovery.
export const SCHEDULE_GATE_MAX_TASK_AGE_MS = 12 * 60 * 60 * 1000;

const SCHEDULE_GATE_ACTIVE_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'open',
  'pending',
  'inProgress',
]);

/**
 * Returns true iff `task` should still block its schedule's next firing.
 *
 * A task blocks only when it is BOTH in an active status AND its `updatedAt`
 * is within `staleAfterMs`. The freshness check is what prevents a hung task
 * from permanently blocking the schedule.
 *
 * `now` and `staleAfterMs` are parameterized for tests.
 */
export function isTaskBlockingSchedule(
  task: { status: TaskStatus; updatedAt: Date } | undefined,
  now: Date = new Date(),
  staleAfterMs: number = SCHEDULE_GATE_MAX_TASK_AGE_MS,
): boolean {
  if (!task || !SCHEDULE_GATE_ACTIVE_STATUSES.has(task.status)) return false;
  const ageMs = Math.max(0, now.getTime() - task.updatedAt.getTime());
  return ageMs < staleAfterMs;
}

export interface ScheduleRunnerDeps {
  store: ScheduleStore;
  service: ScheduleService;
  validator: ScheduleValidator;
  launcher: (opts: LaunchOpts) => Promise<LaunchResult>;
  getActiveCount: () => number;
  getMaxActiveTasks: () => number;
  isTaskBlockingSchedule: (taskId: string) => boolean;
  /**
   * Operator drain gate (issue #659). When provided and returning false, the
   * node is draining and schedule firing is suppressed so the scheduler can't
   * re-launch work behind an operator's back during a cordon. Absent means
   * always-accepting (back-compat).
   */
  isAccepting?: () => boolean;
}

export class ScheduleRunner {
  private tickInterval: ReturnType<typeof setInterval> | null = null;
  private pendingWork = new Set<Promise<void>>();
  private firing = false;
  private deps: ScheduleRunnerDeps;
  /**
   * Last observed resolution-health per schedule, for seeded transition `warn`
   * (R9). The first observation (or one after a path/cwd/scope edit, which
   * changes the signature) seeds the baseline silently; `warn` fires only on a
   * true→false transition between two observed ticks — so an already-broken
   * schedule does not emit a spurious `warn` on every process restart.
   */
  private lastResolution = new Map<string, { signature: string; resolvable: boolean }>();

  constructor(deps: ScheduleRunnerDeps) {
    this.deps = deps;
  }

  start(): void {
    const catchUpMode = getCatchUpMode();
    // Seed resolution health BEFORE the first broadcast (recordRunnerStarted
    // broadcasts) so that broadcast already carries health rather than a full
    // tick of `unknown`, and so the first observation seeds the transition
    // baseline silently (no spurious warn on restart).
    this.refreshPlaybookResolution();
    this.deps.service.recordRunnerStarted(catchUpMode);

    if (catchUpMode === 'auto') {
      this.trackBackgroundWork('Catch-up', this.catchUp());
    } else if (catchUpMode === 'manual') {
      console.log('[schedule] Automatic catch-up disabled; missed runs are recorded for manual Run Now recovery');
      this.trackBackgroundWork('Catch-up', this.catchUp({ manualOnly: true }));
    } else {
      console.log('[schedule] Catch-up disabled (KOOKR_NO_CATCHUP)');
      this.trackBackgroundWork('Catch-up', this.catchUp({ suppressOnly: true }));
    }

    this.tickInterval = setInterval(() => {
      this.trackBackgroundWork('Tick', this.tick());
    }, TICK_INTERVAL_MS);

    console.log(`[schedule] Runner started (${this.deps.store.list().length} schedule(s), tick=${TICK_INTERVAL_MS / 1000}s)`);
  }

  async stop(): Promise<void> {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }

    if (this.pendingWork.size > 0) {
      await Promise.allSettled([...this.pendingWork]);
    }
  }

  private trackBackgroundWork(label: 'Catch-up' | 'Tick', work: Promise<void>): void {
    const tracked = work.catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.service.recordRunnerError(`[schedule] ${label} error: ${message}`);
      console.error(`[schedule] ${label} error:`, err);
    }).finally(() => {
      this.pendingWork.delete(tracked);
    });

    this.pendingWork.add(tracked);
  }

  async tick(): Promise<void> {
    // Resolution health is computed for ALL schedules (including disabled and
    // trigger-exhausted ones), independent of the fire-eligibility gate below,
    // so a disabled-because-broken schedule is still visibly broken (R9).
    this.refreshPlaybookResolution();
    if (this.firing) return;
    this.firing = true;
    try {
      const now = new Date();
      for (const schedule of this.deps.store.list()) {
        if (!schedule.enabled) continue;
        if (isTriggerLimitExhausted(schedule)) {
          await this.deps.service.markCronLimitExhausted(schedule.id);
          continue;
        }
        const scheduledNextRun = computeNextRunFor(schedule);
        if (!scheduledNextRun || scheduledNextRun > now) continue;
        await this.fire(schedule, 'cron', scheduledNextRun);
      }
      this.deps.service.recordTickCompleted();
    } finally {
      this.firing = false;
    }
  }

  async runNow(id: string): Promise<{ taskId?: string; error?: string; queued?: boolean }> {
    const schedule = this.deps.store.get(id);
    if (!schedule) return { error: 'Schedule not found' };
    return this.fire(schedule, 'manual');
  }

  /**
   * Compute and cache playbook resolution health for every schedule (R9). One
   * `resolvePlaybookInScope` per schedule per tick — never on the broadcast hot
   * path. Emits a `warn` on a true→false transition (greppable without a
   * dashboard visit), using seeded baseline semantics (see `lastResolution`).
   */
  refreshPlaybookResolution(): void {
    for (const schedule of this.deps.store.list()) {
      const scope = schedule.playbook.scope ?? 'project';
      const resolvable = existsSync(schedule.cwd)
        && resolvePlaybookInScope(schedule.playbook.path, scope, schedule.cwd) !== undefined;
      const signature = scheduleResolutionSignature(schedule);
      this.deps.store.setPlaybookResolution(schedule.id, signature, resolvable);

      const prev = this.lastResolution.get(schedule.id);
      if (prev && prev.signature === signature && prev.resolvable && !resolvable) {
        console.warn(
          `[schedule] Playbook for "${schedule.name}" became unresolvable in ${scope} tier: ${schedule.playbook.path}`,
        );
      }
      this.lastResolution.set(schedule.id, { signature, resolvable });
    }
  }

  private async fire(
    schedule: Schedule,
    trigger: 'cron' | 'manual',
    scheduledNextRun?: Date,
    decision: 'cron_due' | 'manual_run' | 'catch_up' = trigger === 'manual' ? 'manual_run' : 'cron_due',
  ): Promise<{ taskId?: string; error?: string; queued?: boolean }> {
    if (trigger === 'cron' && isTriggerLimitExhausted(schedule)) {
      await this.deps.service.markCronLimitExhausted(schedule.id);
      return { error: 'Schedule trigger limit reached' };
    }

    const receipt = await this.deps.service.reserveExecution(
      schedule,
      trigger,
      scheduledNextRun?.toISOString(),
      decision,
    );

    const blockingTaskId = schedule.latestExecution?.taskId;
    if (blockingTaskId && this.deps.isTaskBlockingSchedule(blockingTaskId)) {
      console.warn(`[schedule] Skipping "${schedule.name}" — previous run still active (task ${blockingTaskId})`);
      await this.deps.service.markExecutionOutcome(
        schedule.id,
        receipt.id,
        'skipped_active',
        'previous_run_active',
        'Previous run still active',
        { blockingTaskId },
      );
      return { error: 'Previous run still active' };
    }

    if (this.deps.isAccepting && !this.deps.isAccepting()) {
      console.warn(`[schedule] Skipping "${schedule.name}" — server draining (issue #659)`);
      await this.deps.service.markExecutionOutcome(
        schedule.id,
        receipt.id,
        'skipped_draining',
        'draining',
        'Server draining — not accepting new launches',
      );
      return { error: 'Server draining' };
    }

    if (this.deps.getActiveCount() >= this.deps.getMaxActiveTasks()) {
      console.warn(`[schedule] Skipping "${schedule.name}" — at max active tasks (${this.deps.getMaxActiveTasks()})`);
      await this.deps.service.markExecutionOutcome(
        schedule.id,
        receipt.id,
        'skipped_capacity',
        'capacity',
        'Max active tasks reached',
      );
      return { error: 'Max active tasks reached' };
    }

    try {
      const launch = await this.deps.validator.resolveLaunch(schedule);
      const result = await this.deps.launcher({
        prompt: launch.prompt,
        cwd: launch.cwd,
        criteria: launch.criteria,
        name: launch.name,
        playbookId: launch.playbookId,
        projectId: launch.projectId,
        agentType: schedule.agentType,
        disableDedup: true,
      });

      await this.deps.service.markExecutionAccepted(schedule.id, receipt.id, result.task.id, result.queued);
      console.log(`[schedule] Fired "${schedule.name}" → task ${result.task.id}${result.queued ? ' (queued)' : ''}`);
      return { taskId: result.task.id, queued: result.queued };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const reasonCode = mapErrorToReasonCode(err);
      console.error(`[schedule] Error firing "${schedule.name}":`, message);
      await this.deps.service.markExecutionOutcome(
        schedule.id,
        receipt.id,
        'dispatch_failed',
        reasonCode,
        message,
      );
      return { error: message };
    }
  }

  private async catchUp(options: { manualOnly?: boolean; suppressOnly?: boolean } = {}): Promise<void> {
    const now = new Date();
    const cutoff = new Date(now.getTime() - CATCHUP_MAX_STALENESS_MS);

    for (const schedule of this.deps.store.list()) {
      if (!schedule.enabled) continue;
      if (isTriggerLimitExhausted(schedule)) {
        await this.deps.service.markCronLimitExhausted(schedule.id);
        continue;
      }

      const scheduledNext = computeNextRunFor(schedule);
      if (!scheduledNext) continue;

      if (scheduledNext < now && scheduledNext >= cutoff) {
        if (options.suppressOnly) {
          console.log(`[schedule] Suppressing missed run for "${schedule.name}" (due ${scheduledNext.toISOString()}); catch-up is disabled`);
          await this.deps.service.suppressCatchUp(schedule.id);
        } else if (options.manualOnly) {
          const message = `Missed startup run due ${scheduledNext.toISOString()} was recorded for manual Run Now recovery`;
          console.log(`[schedule] Recording missed run for "${schedule.name}" (due ${scheduledNext.toISOString()}); use Run Now to recover`);
          await this.deps.service.recordCatchUpDeferred(schedule.id, scheduledNext.toISOString(), message);
        } else {
          console.log(`[schedule] Catching up "${schedule.name}" (was due ${scheduledNext.toISOString()})`);
          await this.fire(schedule, 'cron', scheduledNext, 'catch_up');
        }
      } else if (scheduledNext < cutoff) {
        if (options.suppressOnly) {
          console.log(`[schedule] Suppressing stale missed run for "${schedule.name}" (due ${scheduledNext.toISOString()}); catch-up is disabled`);
          await this.deps.service.suppressCatchUp(schedule.id);
          continue;
        }
        const message = `Due ${scheduledNext.toISOString()} is outside the 24h catch-up window`;
        console.log(`[schedule] Skipping stale catch-up for "${schedule.name}" (due ${scheduledNext.toISOString()}, > 24h ago)`);
        await this.deps.service.recordCatchUpSkipped(schedule.id, scheduledNext.toISOString(), message);
      }
    }
  }
}

function getCatchUpMode(): 'auto' | 'manual' | 'off' {
  if (process.env.KOOKR_NO_CATCHUP) return 'off';
  if (process.env.KOOKR_AUTO_CATCHUP) return 'auto';
  return 'manual';
}

function mapErrorToReasonCode(err: unknown) {
  if (err instanceof ScheduleValidationError) {
    if (err.fieldErrors?.cwd) return 'missing_cwd' as const;
    if (err.fieldErrors?.playbook) return 'missing_playbook' as const;
    return 'validation' as const;
  }
  return 'launch_error' as const;
}

function computeNextRunFor(schedule: Schedule): Date | null {
  const after = schedule.lastScheduledFor
    ? new Date(schedule.lastScheduledFor)
    : new Date(schedule.createdAt);
  return nextRun(schedule.cron, after);
}
