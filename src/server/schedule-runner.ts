import { existsSync } from 'node:fs';
import type { ScheduleStore, Schedule } from '../core/schedule.js';
import { nextRun } from '../core/cron.js';
import { ScheduleValidationError, isTriggerLimitExhausted, scheduleResolutionSignature } from '../core/schedule.js';
import { ScheduleService } from './schedule-service.js';
import { ScheduleValidator, resolveSchedulePlaybookSync } from './schedule-validator.js';
import { isPendingQueueFullError, launchPhaseTimingsOf, type LaunchOpts, type LaunchResult } from './launch-service.js';
import { withTimeout } from '../core/with-timeout.js';
import {
  crossTierResolutionHint,
  type ScheduleResolutionProbe,
  type UnresolvableScheduleInfo,
} from './schedule-resolution-alert.js';
import type { TaskStatus } from '../core/types.js';
import type { ClaimKey } from '../core/issue-claim-types.js';
import type { RelaunchArbiter } from './relaunch-arbiter.js';

/**
 * Synthetic relaunch-arbiter identity for a schedule's startup catch-up fire
 * (issue #1900 / #1699 WS2.2). The arbiter keys on issue-claim identity
 * (`repo` + `number`); a catch-up fire has no issue at fire time, so it keys on
 * the schedule instead — giving the catch-up path its own mutual-exclusion +
 * backoff slot without colliding with the real `github.com/...` issue keys the
 * launch-path lease gate uses. Coordinates catch-up against any other actuator
 * that adopts the same schedule-scoped key (a future WS2 loop-arming caller).
 */
function catchUpClaimKey(schedule: Schedule): ClaimKey {
  return { repo: `schedule:${schedule.id}`, number: 0 };
}

/**
 * Cross-tier resolution probe for {@link crossTierResolutionHint} (#1661).
 * Wraps the hardened sync resolver into a never-null boolean; the caller wraps
 * throws, but keep this total for defence in depth.
 */
const scheduleResolutionProbe: ScheduleResolutionProbe = (playbookPath, scope, cwd) => {
  try {
    return resolveSchedulePlaybookSync(playbookPath, scope, cwd) !== undefined;
  } catch {
    return false;
  }
};

/**
 * Schedule-runner tick cadence. Also the unit for the GET `/api/ready`
 * `schedulerTick` staleness threshold (issue #1707): not-ready after
 * `SCHEDULER_TICK_STALE_INTERVALS` × this interval without a completed tick.
 */
export const SCHEDULE_TICK_INTERVAL_MS = 60_000;
const TICK_INTERVAL_MS = SCHEDULE_TICK_INTERVAL_MS;
const CATCHUP_MAX_STALENESS_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Wall-clock cap for a single `fire()` (issue #1708). One hung launcher (the
 * motivating case: grok-build stalling 90s+) must not be able to freeze the
 * tick. Past this cap the fire is left to settle in the background — its own
 * try/catch still records the ledger outcome if/when it finally settles — and
 * the tick moves on. Kept below `TICK_INTERVAL_MS` so a stalled fire can never
 * bleed one tick into the next, and well below the launcher's own
 * `launchTimeoutSeconds` (default 180s) so the scheduler is not held hostage to
 * the launch pipeline's slower internal deadline.
 */
export const FIRE_WALL_CLOCK_CAP_MS = 45_000;

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
  /**
   * Automation kill-switch (issue #1710 / #1699 WS0.4). When provided and
   * returning false, schedule firing is suppressed (SAFE MODE) while manual
   * launches remain accepted. Absent means automation enabled (back-compat).
   */
  isAutomationEnabled?: () => boolean;
  /**
   * Resolve a blocking task's current status (issue #1526 Phase A). Used
   * ONLY to split `isTaskBlockingSchedule`'s single boolean into two distinct
   * ledger outcomes: `pending` → coalesce (`skipped_coalesced`, at most one
   * outstanding queued fire per schedule); anything else (still active,
   * e.g. `inProgress`) → the existing `skipped_active` behavior, unchanged.
   * Absent means every block is reported as `skipped_active` (back-compat).
   */
  getBlockingTaskStatus?: (taskId: string) => TaskStatus | undefined;
  /**
   * Scheduled-task starvation dead-man switch (issue #1526 Phase C). When
   * provided, evaluated once per tick — piggybacking the existing 60s
   * interval, no timer of its own. `check` must never throw (it only reads
   * ledger state and broadcasts); it is still called inside the tick's
   * tracked-work error envelope. Absent means no dead-man (back-compat for
   * older wiring/tests).
   */
  deadMan?: { check(schedules: Schedule[]): void };
  /**
   * Unresolvable-playbook operational alerter (issue #1661). When provided,
   * fed the current set of unresolvable schedules on every validation cycle
   * (the runner's existing tick + the pre-broadcast seed) so an already-broken
   * schedule — including one silently broken by the scope migration — raises
   * an operational alert within one cycle, not only when an operator re-enables
   * it and reads the ledger. `check` must never throw. Absent means no
   * unresolvable-playbook alerting (back-compat for older wiring/tests).
   */
  resolutionAlerter?: { check(unresolvable: UnresolvableScheduleInfo[], resolvedIds: string[]): void };
  /**
   * Re-queue-after-reset sweep (issue #1896 / #1699 WS1.4). When provided,
   * evaluated once per tick — piggybacking the existing 60s interval, no timer
   * of its own — so a provider-paused issue whose `resetsAt` has elapsed is
   * auto-re-dispatched (jittered + token-bucket-bounded, lease-keyed dedup)
   * without operator action. `sweep` must never throw; it is still wrapped in
   * the tick's defensive envelope. Absent means no auto-resume (back-compat for
   * older wiring/tests).
   */
  resetScheduler?: { sweep(now?: number): unknown };
  /**
   * Per-fire wall-clock cap in ms (issue #1708). Parameterized for tests;
   * defaults to {@link FIRE_WALL_CLOCK_CAP_MS}. A launcher that hangs past this
   * cap is left to settle in the background so the tick is never frozen.
   */
  fireTimeoutMs?: number;
  /**
   * WS0.5 relaunch arbiter (issue #1900 / #1711 / #1699 WS2.2). When provided,
   * startup catch-up fires are gated behind it: a missed run is admitted only
   * when the schedule's relaunch lease is free (no concurrent actuator holds
   * it and no post-release backoff is live), then held under the fired task so
   * it cannot be duplicated for that task's lifetime. Absent means catch-up
   * fires ungated (back-compat for older wiring/tests). Only the catch-up path
   * consults it — the umbrella specifies catch-up runs "after the lease gate".
   */
  relaunchArbiter?: Pick<RelaunchArbiter, 'evaluate' | 'tryAcquire'>;
  /**
   * Unwind a catch-up fire that launched but then LOST the relaunch-lease CAS
   * (issue #1914). The catch-up path evaluates the lease before firing, but the
   * `await fire()` between that evaluate and the post-fire `tryAcquire` is a
   * window in which another actuator (or a post-release backoff) can take the
   * schedule's lease. When that happens the just-launched `catch_up` task is a
   * duplicate of work the lease holder already owns; this callback terminates
   * it (best-effort) so the arbiter's mutual-exclusion invariant is enforced by
   * code rather than left to the single-serial-actuator assumption. Given a
   * fired `taskId` and a short operator-facing `detail`. Absent (older
   * wiring/tests) means a lost acquire is only logged (the prior behavior);
   * only the catch-up path invokes it.
   */
  terminateCatchUpDuplicate?: (taskId: string, detail: string) => void;
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
  /**
   * Schedule ids whose `fire()` is still in flight (issue #1708). A fire that
   * exceeds {@link FIRE_WALL_CLOCK_CAP_MS} releases the tick but keeps its id
   * here until it TRULY settles, so the next tick does not re-fire — and
   * duplicate-launch — a schedule whose launcher is still stuck. Bounded in
   * practice by the launcher's own launch timeout; if a launcher never
   * settles, one stuck fire is held per schedule (no duplicate zombies) and
   * the dead-man switch flags the resulting starvation.
   */
  private inFlightFires = new Set<string>();

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
      // Dead-man starvation self-check (issue #1526 Phase C) runs FIRST, fully
      // decoupled from the fires below (issue #1708). Previously it ran AFTER
      // the `for…await fire()` loop so it could see this tick's outcomes — but
      // that also meant a single hung `fire()` (grok-build stalling 90s+)
      // froze the dead-man along with every other fire, defeating the very
      // watchdog meant to notice the freeze. It reads accumulated ledger state
      // (prior ticks' reservations and outcomes), so at worst it now lags one
      // 60s tick — negligible against the multi-minute starvation window — and
      // in exchange it is guaranteed to run every tick regardless of a stalled
      // launcher. Wrapped defensively (like refreshPlaybookResolution's alerter
      // call): the contract says `check` never throws, but a throw here must
      // not abort the fire loop it exists to protect.
      try {
        this.deps.deadMan?.check(this.deps.store.list());
      } catch (err) {
        console.error('[schedule] dead-man check failed:', err);
      }

      // Re-queue-after-reset sweep (issue #1896): auto-resume provider-paused
      // issues whose reset time has elapsed. Decoupled from the fire loop for
      // the same reason as the dead-man (issue #1708) — a hung fire must not
      // delay a due resume — and wrapped defensively even though `sweep` is
      // contractually non-throwing. Suppressed under SAFE MODE (kill-switch)
      // like schedule fires: the resume replays as a `schedule` launch, so
      // launchTask would reject it anyway; gating here avoids burning a resume
      // token + logging a spurious failure on every disabled tick.
      if (this.deps.isAutomationEnabled?.() ?? true) {
        try {
          this.deps.resetScheduler?.sweep();
        } catch (err) {
          console.error('[schedule] reset-scheduler sweep failed:', err);
        }
      }

      const now = new Date();
      const fires: Array<Promise<void>> = [];
      for (const schedule of this.deps.store.list()) {
        if (!schedule.enabled) continue;
        if (isTriggerLimitExhausted(schedule)) {
          await this.deps.service.markCronLimitExhausted(schedule.id);
          continue;
        }
        const scheduledNextRun = computeNextRunFor(schedule);
        if (!scheduledNextRun || scheduledNextRun > now) continue;
        if (this.inFlightFires.has(schedule.id)) {
          // A previous fire for this schedule is still in flight past its
          // wall-clock cap (issue #1708). Skip rather than launch a duplicate:
          // reserveExecution already advanced `lastScheduledFor`, so without
          // this guard the now-released `firing` gate would let the next tick
          // re-fire the same occurrence (disableDedup is set) and spawn a
          // second task. It clears when the stuck fire finally settles.
          console.warn(`[schedule] Skipping "${schedule.name}" — previous fire still in flight past its wall-clock cap (issue #1708)`);
          continue;
        }
        // Fire concurrently and wall-clock-bound each (issue #1708): a single
        // hung fire() no longer blocks the other due schedules, and each fire
        // is capped so the tick as a whole settles within the cap. Fires touch
        // only their own schedule's ledger, so concurrency is safe; the
        // launcher still serializes capacity decisions (queues at capacity).
        fires.push(this.fireBounded(schedule, 'cron', scheduledNextRun));
      }
      await Promise.allSettled(fires);
      this.deps.service.recordTickCompleted();
    } finally {
      this.firing = false;
    }
  }

  /**
   * Run one cron `fire()` under a wall-clock cap (issue #1708). If the fire
   * settles within the cap, its result flows through as normal. If it hangs
   * past the cap, this resolves anyway and leaves the underlying `fire()` to
   * settle in the background — while its schedule id stays in
   * {@link inFlightFires} so the next tick will not re-fire (and duplicate) it.
   *
   * The in-flight marker is cleared, and any error surfaced, only when the
   * underlying `fire()` TRULY settles. `fire()` handles its own launcher
   * errors internally (recording the ledger outcome), so the reject branch
   * here catches only the pre-launcher failures ahead of that try/catch (e.g.
   * reserveExecution throwing). Because the settlement promise is consumed by
   * `withTimeout`'s race, a late settlement after the cap cannot surface as an
   * unhandled rejection. Never rejects, so `Promise.allSettled` in the tick
   * always resolves promptly.
   */
  private async fireBounded(
    schedule: Schedule,
    trigger: 'cron',
    scheduledNextRun: Date,
  ): Promise<void> {
    const cap = this.deps.fireTimeoutMs ?? FIRE_WALL_CLOCK_CAP_MS;
    this.inFlightFires.add(schedule.id);
    const settled = this.fire(schedule, trigger, scheduledNextRun).then(
      () => {
        this.inFlightFires.delete(schedule.id);
      },
      (err) => {
        this.inFlightFires.delete(schedule.id);
        // A fire that rejects BEFORE its own launcher try/catch (e.g.
        // reserveExecution throwing). Surface it so a broken fire is never
        // silent; isolate it so it cannot abort the other fires.
        const message = err instanceof Error ? err.message : String(err);
        this.deps.service.recordRunnerError(`[schedule] Fire error for "${schedule.name}": ${message}`);
        console.error(`[schedule] Fire error for "${schedule.name}":`, err);
      },
    );
    const timedOut = await withTimeout(settled.then(() => false), cap, true);
    if (timedOut) {
      console.warn(
        `[schedule] fire() for "${schedule.name}" exceeded the ${Math.round(cap / 1000)}s `
        + 'wall-clock cap — leaving it to settle in the background so the tick is not frozen; '
        + 'the schedule will not re-fire until it settles (issue #1708)',
      );
    }
  }

  async runNow(id: string): Promise<{ taskId?: string; error?: string; queued?: boolean }> {
    const schedule = this.deps.store.get(id);
    if (!schedule) return { error: 'Schedule not found' };
    return this.fire(schedule, 'manual');
  }

  /**
   * Compute and cache playbook resolution health for every schedule (R9). Uses
   * the same hardened schedule playbook resolver as launch, never on the
   * broadcast hot path. Emits a `warn` on a true→false transition (greppable
   * without a dashboard visit), using seeded baseline semantics (see
   * `lastResolution`).
   */
  refreshPlaybookResolution(): void {
    const unresolvable: UnresolvableScheduleInfo[] = [];
    const resolvedIds: string[] = [];
    for (const schedule of this.deps.store.list()) {
      const scope = schedule.playbook.scope ?? 'project';
      const cwdExists = existsSync(schedule.cwd);
      let resolvable = false;
      if (cwdExists) {
        try {
          resolvable = resolveSchedulePlaybookSync(schedule.playbook.path, scope, schedule.cwd) !== undefined;
        } catch {
          resolvable = false;
        }
      }
      const signature = scheduleResolutionSignature(schedule);
      this.deps.store.setPlaybookResolution(schedule.id, signature, resolvable);

      const prev = this.lastResolution.get(schedule.id);
      if (prev && prev.signature === signature && prev.resolvable && !resolvable) {
        console.warn(
          `[schedule] Playbook for "${schedule.name}" became unresolvable in ${scope} tier: ${schedule.playbook.path}`,
        );
      }
      this.lastResolution.set(schedule.id, { signature, resolvable });

      // Collect unresolvable schedules for the operational alerter (#1661).
      // Scoped to `cwd exists but playbook does not resolve` — a missing cwd is
      // a distinct config error handled elsewhere, and folding it in here would
      // mislabel it as an unresolvable *playbook*. The cross-tier hint probes
      // the other tiers so the alert can say "pin scope: plugin" (the exact fix
      // for the 68e9cb52 legacy-schedule incident).
      if (cwdExists && !resolvable) {
        const resolvableInTier = crossTierResolutionHint(schedule, scheduleResolutionProbe);
        unresolvable.push({
          id: schedule.id,
          name: schedule.name,
          playbookPath: schedule.playbook.path,
          scope,
          legacy: schedule.playbook.scope === undefined,
          ...(resolvableInTier ? { resolvableInTier } : {}),
        });
      } else if (resolvable) {
        // `resolvable` is only ever true when cwd exists (guarded above), so
        // this is the "genuinely resolves now" set the alerter uses to gate
        // recovery alerts — see ScheduleResolutionAlerter.check.
        resolvedIds.push(schedule.id);
      }
    }
    // Wrap the alerter call: unlike the dead-man (only invoked from the
    // tracked-work-wrapped tick), refreshPlaybookResolution also runs on the
    // unwrapped startup seed, so a throwing broadcast here must not abort
    // runner startup.
    try {
      this.deps.resolutionAlerter?.check(unresolvable, resolvedIds);
    } catch (err) {
      console.error('[schedule] resolution alerter check failed:', err);
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
      // Coalesce (issue #1526 Phase A): the previous fire's task never got
      // past `pending` (queued_capacity) — skip this fire rather than
      // stacking a second pending task behind the first, so at most one
      // outstanding queued fire per schedule ever exists. A blocking task in
      // any OTHER active status (e.g. `inProgress`) keeps the existing
      // skipped_active behavior exactly as before.
      if (this.deps.getBlockingTaskStatus?.(blockingTaskId) === 'pending') {
        console.warn(`[schedule] Coalescing "${schedule.name}" — previous fire's task is still pending (task ${blockingTaskId})`);
        await this.deps.service.markExecutionOutcome(
          schedule.id,
          receipt.id,
          'skipped_coalesced',
          'previous_run_pending',
          'Previous fire is still pending launch',
          { blockingTaskId },
        );
        return { error: 'Previous fire is still pending launch' };
      }
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

    if (this.deps.isAutomationEnabled && !this.deps.isAutomationEnabled()) {
      console.warn(`[schedule] Skipping "${schedule.name}" — automation kill-switch engaged (issue #1710)`);
      await this.deps.service.markExecutionOutcome(
        schedule.id,
        receipt.id,
        'skipped_safe_mode',
        'safe_mode',
        'SAFE MODE — automation kill-switch engaged; schedule fires halted',
      );
      return { error: 'SAFE MODE — automation kill-switch engaged' };
    }

    // #1526 Phase A / FM8: no capacity pre-check here anymore. At capacity,
    // the launcher (the normal task-submission path) pends the task instead
    // of launching it — same as any other over-cap POST /api/tasks — so a
    // scheduled fire is queued rather than silently dropped. The scheduler's
    // own promotion loop launches it once a slot frees. See
    // markExecutionAccepted for the resulting `queued_capacity` outcome.
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
        // #1518: forward schedule-level effort/model pins into the spawned
        // task. launchTask still validates them against the resolved agent.
        ...(schedule.effort ? { effort: schedule.effort } : {}),
        ...(schedule.model ? { model: schedule.model } : {}),
        disableDedup: true,
        // issue #1526 Phase C / C3: mark schedule provenance. This (a)
        // exempts the fire from the per-source spawn burst budget — schedules
        // have their own coalescing + dead-man alerting — and (b) stamps
        // metadata.launchSource so the promotion posture guard treats a
        // queued fire as self-releasing.
        launchSource: 'schedule',
        // issue #1583: carry the scheduleId so the created task's immutable
        // `schedule` provenance points back to this schedule for rollups.
        scheduleId: schedule.id,
      });

      await this.deps.service.markExecutionAccepted(schedule.id, receipt.id, result.task.id, result.queued);
      console.log(
        `[schedule] Fired "${schedule.name}" → task ${result.task.id}`
        + `${result.queued ? ` (queued — at capacity ${this.deps.getActiveCount()}/${this.deps.getMaxActiveTasks()})` : ''}`,
      );
      return { taskId: result.task.id, queued: result.queued };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const reasonCode = mapErrorToReasonCode(err);
      // issue #1589: a launch that reached the adapter and then timed out/threw
      // carries its per-phase timings on the error. Stamp them onto the
      // dispatch_failed ledger row so the failed fire is diagnosable straight
      // from the ledger — the row would otherwise have no taskId link, since a
      // failed fire never calls markExecutionAccepted.
      const launchPhaseTimings = launchPhaseTimingsOf(err);
      console.error(`[schedule] Error firing "${schedule.name}":`, message);
      await this.deps.service.markExecutionOutcome(
        schedule.id,
        receipt.id,
        'dispatch_failed',
        reasonCode,
        message,
        launchPhaseTimings ? { launchPhaseTimings } : {},
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
          await this.catchUpFire(schedule, scheduledNext);
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

  /**
   * Fire a single missed run for `schedule`, gated behind the WS0.5 relaunch
   * arbiter when one is wired (issue #1900 / #1699 WS2.2).
   *
   * The umbrella specifies startup catch-up runs "after the lease gate": a
   * missed run must not duplicate a concurrent actuator (crash recovery,
   * re-dispatch, a future loop-arming caller) already relaunching this
   * schedule's work. Following the launch-service CAS shape (issue #1711):
   * evaluate before firing so a denied catch-up creates no task, then acquire
   * the lease under the fired task id so the schedule is excluded for that
   * task's lifetime — orphan-reclaim (via the arbiter's `isHolderLive` probe)
   * starts the post-release backoff when the task goes terminal, so an
   * immediate second catch-up is refused too.
   *
   * The `await fire()` between the pre-fire evaluate and the post-fire acquire
   * is a window in which another actuator (or a post-release backoff) can take
   * the schedule's lease, so the acquire can lose *after* a `catch_up` task has
   * already launched (issue #1914). The launcher cannot pre-create the task the
   * way launch-service's synchronous CAS does, so the window cannot be closed
   * here; instead the invariant is enforced on the losing side — mirroring the
   * launch-service rollback — by unwinding the just-launched duplicate via
   * {@link ScheduleRunnerDeps.terminateCatchUpDuplicate} (best-effort) so it
   * cannot run alongside the lease holder. Absent that callback, a lost acquire
   * is only logged (the prior behavior).
   *
   * Absent an arbiter this is exactly the previous behavior: a single
   * `catch_up`-tagged fire.
   */
  private async catchUpFire(schedule: Schedule, scheduledNext: Date): Promise<void> {
    const arbiter = this.deps.relaunchArbiter;
    if (arbiter) {
      const key = catchUpClaimKey(schedule);
      const decision = arbiter.evaluate(key);
      if (!decision.admit) {
        const message = decision.reason === 'backoff'
          ? `Catch-up withheld — relaunch lease in backoff for ${Math.ceil(decision.retryAfterMs / 1000)}s`
          : `Catch-up withheld — relaunch lease held by ${decision.lease.holderId}`;
        console.log(`[schedule] Skipping catch-up for "${schedule.name}" (was due ${scheduledNext.toISOString()}) — ${message}`);
        await this.deps.service.recordCatchUpLeaseDenied(schedule.id, scheduledNext.toISOString(), message);
        return;
      }
    }

    console.log(`[schedule] Catching up "${schedule.name}" (was due ${scheduledNext.toISOString()})`);
    const result = await this.fire(schedule, 'cron', scheduledNext, 'catch_up');

    // Hold the relaunch lease under the fired task so a concurrent actuator is
    // excluded for its lifetime. A failed fire (no taskId) leaves the lease
    // free — nothing was launched to protect.
    if (arbiter && result.taskId) {
      const acquire = arbiter.tryAcquire(catchUpClaimKey(schedule), result.taskId);
      if (!acquire.ok) {
        // Lost the lease CAS (issue #1914): a concurrent actuator took the
        // schedule's relaunch lease (or a post-release backoff opened) during
        // the `await fire()` window, so the task we just launched duplicates
        // work the lease holder already owns. Unwind it (best-effort) rather
        // than letting the duplicate run — the terminal transition flips the
        // task's record and the terminal-task session reaper (#1720) reclaims
        // its session. Absent the unwind hook, keep the prior log-only behavior.
        const detail =
          acquire.reason === 'backoff'
            ? `relaunch lease entered backoff mid-fire (retry in ${Math.ceil(acquire.retryAfterMs / 1000)}s)`
            : `relaunch lease taken mid-fire by ${acquire.lease.holderId}`;
        console.warn(
          `[schedule] Catch-up for "${schedule.name}" launched task ${result.taskId} but lost the relaunch lease (${acquire.reason}); unwinding the duplicate — ${detail}`,
        );
        this.deps.terminateCatchUpDuplicate?.(result.taskId, detail);
      }
    }
  }
}

/**
 * Resolve the startup catch-up mode (issue #1900 / #1699 WS2.2).
 *
 * Default is `auto`: a schedule that missed its window while the process was
 * down performs exactly one `catch_up`-tagged run per boot on restart (gated
 * behind the relaunch arbiter — see {@link ScheduleRunner.catchUpFire}). This
 * is the flip from the previous `manual` default, so an unsupervised node
 * self-catches-up without operator action.
 *
 * Escape hatches, in precedence order:
 * - `KOOKR_NO_CATCHUP` — disables catch-up entirely (missed runs suppressed;
 *   the cron watermark still advances). The retained legacy kill switch.
 * - `KOOKR_MANUAL_CATCHUP` — records missed startup runs for manual Run Now
 *   recovery instead of auto-firing (the pre-#1900 default behavior).
 * - `KOOKR_AUTO_CATCHUP` — now redundant (auto is the default); still honored
 *   so existing opt-in configs keep working.
 */
function getCatchUpMode(): 'auto' | 'manual' | 'off' {
  if (process.env.KOOKR_NO_CATCHUP) return 'off';
  if (process.env.KOOKR_MANUAL_CATCHUP) return 'manual';
  return 'auto';
}

function mapErrorToReasonCode(err: unknown): import('../core/schedule.js').ScheduleExecutionReasonCode {
  if (err instanceof ScheduleValidationError) {
    if (err.fieldErrors?.cwd) return 'missing_cwd' as const;
    if (err.fieldErrors?.playbook) return 'missing_playbook' as const;
    return 'validation' as const;
  }
  // issue #1526 Phase C / C3: a fire refused by the pending-queue depth limit
  // is recorded as dispatch_failed with its own reason code — never silently
  // dropped, and distinguishable from a broken launcher in the ledger.
  if (isPendingQueueFullError(err)) return 'pending_queue_full' as const;
  // Defense-in-depth: if a fire reaches the launcher while SAFE MODE is on
  // (the pre-fire gate above should have short-circuited), map to safe_mode.
  if (err instanceof Error && err.name === 'AutomationKillSwitchError') return 'safe_mode' as const;
  return 'launch_error' as const;
}

function computeNextRunFor(schedule: Schedule): Date | null {
  const after = schedule.lastScheduledFor
    ? new Date(schedule.lastScheduledFor)
    : new Date(schedule.createdAt);
  return nextRun(schedule.cron, after);
}
