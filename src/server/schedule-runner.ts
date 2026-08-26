import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { nextRun } from '../core/cron.js';
import {
  type ScheduleStore,
  type Schedule,
  ScheduleValidationError,
  hasScheduleLoopConfig,
  isTriggerLimitExhausted,
  scheduleResolutionSignature,
  resolveScheduleAgentSelection,
} from '../core/schedule.js';
import {
  isAgentType,
  isValidEffortForAgent,
  isValidModelForAgent,
  ROUND_ROBIN_AGENT_TYPE,
  resolvePinnedAgentFallback,
  type AgentFallbackPolicy,
  type AgentSelection,
  type AgentType,
  type PinnedAgentResolution,
} from '../core/agent-types.js';
import type { AgentSubstitutionHop } from '../shared/contracts/task.js';
import { filterLaunchableAgentTypes } from '../adapters/grok-auth-availability.js';
import { ScheduleService } from './schedule-service.js';
import { ScheduleValidator, resolveSchedulePlaybookSync } from './schedule-validator.js';
import { isPendingQueueFullError, launchPhaseTimingsOf, type LaunchOpts, type LaunchResult, type LaunchTaskServerOptions } from './launch-service.js';
import { isSafeModeExemptSchedule } from '../core/automation-kill-switch.js';
import { withTimeout } from '../core/with-timeout.js';
import {
  crossTierResolutionHint,
  type ScheduleResolutionProbe,
  type UnresolvableScheduleInfo,
} from './schedule-resolution-alert.js';
import type { ScheduleDeadManStats } from './schedule-dead-man.js';
import type { TaskStatus } from '../core/types.js';
import type { TaskLaunchAdmission } from '../shared/contracts/task.js';
import { isNoSlotDependencyAdmission } from '../core/launch-dependency-task-admission.js';
import type { ClaimKey } from '../core/issue-claim-types.js';
import type { RelaunchArbiter } from './relaunch-arbiter.js';
import { expandConfiguredCwd } from './cwd-paths.js';
import { parsePlaybook } from '../core/playbook-parser.js';
import type { PlaybookProbe } from '../core/playbook.js';
import {
  probeReceiptLine,
  resolveScheduleProbe,
  shouldEscalateProbe,
  type ProbeExecResult,
  type ResolvedScheduleProbe,
} from '../core/schedule-probe.js';

/**
 * Synthetic relaunch-arbiter identity for a schedule unit (issue #1900 catch-up
 * / #1899 loop-arming / #1699 WS2). The arbiter keys on issue-claim identity
 * (`repo` + `number`); schedule actuators have no GitHub issue at fire time, so
 * they key on the schedule instead — giving catch-up and loop-arming a shared
 * mutual-exclusion + backoff slot without colliding with the real
 * `github.com/...` issue keys the launch-path lease gate uses.
 */
export function scheduleRelaunchClaimKey(schedule: Pick<Schedule, 'id'>): ClaimKey {
  return { repo: `schedule:${schedule.id}`, number: 0 };
}

/** @deprecated Prefer {@link scheduleRelaunchClaimKey}; alias retained for older call sites. */
const catchUpClaimKey = scheduleRelaunchClaimKey;

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

export interface ScheduleRunResult {
  taskId?: string;
  error?: string;
  queued?: boolean;
  /** True when admission parked the task without consuming a worker slot. */
  parked?: boolean;
  /** Safe scheduled-execution classification for API and CLI consumers. */
  outcome?: 'parked_dependency';
  reasonCode?: 'dependency_degraded';
}

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
  task: { status: TaskStatus; updatedAt: Date; launchAdmission?: TaskLaunchAdmission } | undefined,
  now: Date = new Date(),
  staleAfterMs: number = SCHEDULE_GATE_MAX_TASK_AGE_MS,
): boolean {
  if (!task || !SCHEDULE_GATE_ACTIVE_STATUSES.has(task.status)) return false;
  // Dependency-blocked tasks are intentionally durable until recovery; age
  // does not make the original scheduled work obsolete. Letting this marker
  // fall through the generic 12h abandonment gate would create a second task
  // because schedule launches intentionally disable submission dedup.
  if (isNoSlotDependencyAdmission(task.launchAdmission)) return true;
  const ageMs = Math.max(0, now.getTime() - task.updatedAt.getTime());
  return ageMs < staleAfterMs;
}

export interface ScheduleRunnerDeps {
  store: ScheduleStore;
  service: ScheduleService;
  validator: ScheduleValidator;
  launcher: (opts: LaunchOpts, serverOpts?: LaunchTaskServerOptions) => Promise<LaunchResult>;
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
   * Intentional process-restart signal (issue #1983). When provided and true
   * *while* the drain gate is closed, the skip is recorded as
   * `skipped_server_restarting` instead of generic `skipped_draining` so the
   * operator UI can distinguish redeploy from a manual cordon. Typically
   * backed by the short-lived `server-restarting.json` marker that
   * `prod-restart` writes before pre-stop drain. Absent means every drain skip
   * is recorded as `skipped_draining` (back-compat).
   */
  isServerRestarting?: () => boolean;
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
   *
   * Optional `stats()` (issue #1903) exposes the bounded self-heal
   * attempt/success counters; when present they are pushed onto the schedule
   * status snapshot each tick so an operator can observe self-heal activity via
   * /api/health.
   */
  deadMan?: { check(schedules: Schedule[]): void; stats?(): ScheduleDeadManStats };
  /**
   * Per-schedule liveness / stale-alarm (issue #2694). When provided, evaluated
   * once per tick right after {@link ScheduleRunnerDeps.deadMan}, on the same
   * 60s interval (no timer of its own). Catches a single enabled schedule that
   * has gone dark — left no ledger activity for far longer than its cadence
   * warrants — which the fleet-wide dead-man switch misses when healthy sibling
   * schedules mask it. `check` must never throw; it is still called inside the
   * tick's tracked-work error envelope. Absent means no liveness alarm
   * (back-compat for older wiring/tests).
   */
  staleAlarm?: { check(schedules: Schedule[]): void };
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
   * Currently registered (launchable) agent types (issue #1895 / #1699 WS1.3).
   * When provided, a schedule pinned to an unavailable agent substitutes to an
   * available one (or parks via `provider_paused`) instead of dispatching into
   * a known-missing adapter and recording `dispatch_failed`. Absent means the
   * historical pass-through (back-compat for older wiring/tests).
   *
   * Issue #2194: this list is further filtered by {@link isGrokAuthUsable} so
   * a registered-but-auth-expired `grok-build` is not treated as launchable.
   */
  getAvailableAgentTypes?: () => readonly AgentType[];
  /**
   * Boot-reliability deprioritization (issue #1898) consulted when resolving a
   * pinned schedule agent. Same shape as launch-service's dep. Absent means no
   * deprioritization (pin is only unavailable when not registered).
   */
  getDeprioritizedAgentTypes?: (available: readonly AgentType[]) => readonly AgentType[];
  /**
   * Automatic fallback policy (issue #2001). Applied when substituting an
   * unavailable pin so a disallowed agent (default: codex-cli) is never a
   * silent landing. Absent ⇒ no filter (back-compat).
   */
  getAgentFallbackPolicy?: () => AgentFallbackPolicy;
  /**
   * Grok session/OIDC usability for schedule agent resolution (issue #2194).
   * When this returns `false`, `grok-build` is stripped from the launchable
   * set so non-Grok backends (or healthy substitutes) still fire. Absent ⇒
   * no auth filter (back-compat). Never consults API-key auth.
   */
  isGrokAuthUsable?: () => boolean;
  /**
   * Optional pre-fire refresh of the Grok auth usability cache (issue #2194).
   * Awaited once per `fire()` so a re-login is visible within a schedule tick
   * without reading auth.json on every synchronous getter call. Absent ⇒
   * resolution uses the last cached (or fail-open) verdict only.
   */
  refreshGrokAuthAvailability?: () => Promise<void>;
  /**
   * Live `settings.defaultAgentType` getter. Used when a schedule has no
   * agentType pin so availability substitution and launch use the same default
   * the rest of the server would pick.
   */
  getDefaultAgentType?: () => AgentSelection;
  /**
   * Record one provider fallback substitution (issue #1895 → WS1.5 counter).
   * Wired to {@link ProviderHealthTracker.recordSubstitution} in production.
   * Fire-and-forget; must not throw. Absent means substitution still happens
   * and is ledger-stamped, but the pool-health counter is not incremented.
   */
  recordAgentSubstitution?: () => void;
  /**
   * Optional cheap-probe runner (issue #2569). Injected for tests. Default
   * execs the resolved argv with `execFile` (no shell). A probe that does not
   * escalate completes the fire without launching an agent.
   */
  runProbe?: (spec: ResolvedScheduleProbe, cwd: string) => Promise<ProbeExecResult>;
  /**
   * Per-fire wall-clock cap in ms (issue #1708). Parameterized for tests;
   * defaults to {@link FIRE_WALL_CLOCK_CAP_MS}. A launcher that hangs past this
   * cap is left to settle in the background so the tick is never frozen.
   */
  fireTimeoutMs?: number;
  /**
   * WS0.5 relaunch arbiter (issue #1900 / #1711 / #1699 WS2 / #1899). When
   * provided:
   * - startup catch-up fires are gated behind it (a missed run is admitted
   *   only when the schedule's relaunch lease is free);
   * - loop-configured schedules arming a Ralph loop via
   *   {@link loopedLauncher} are gated the same way so two actuators cannot
   *   arm duplicate always-running loops for the same unit.
   * In both cases the lease is held under the fired task for that task's
   * lifetime. Absent means those paths fire ungated (back-compat for older
   * wiring/tests).
   */
  relaunchArbiter?: Pick<RelaunchArbiter, 'evaluate' | 'tryAcquire'>;
  /**
   * Unwind a catch-up / loop-arm fire that launched but then LOST the
   * relaunch-lease CAS (issue #1914 / #1899). The path evaluates the lease
   * before launching, but the `await launch` between that evaluate and the
   * post-fire `tryAcquire` is a window in which another actuator (or a
   * post-release backoff) can take the schedule's lease. When that happens the
   * just-launched task is a duplicate of work the lease holder already owns;
   * this callback terminates it (best-effort) so the arbiter's mutual-exclusion
   * invariant is enforced by code. Given a fired `taskId` and a short
   * operator-facing `detail`. Absent (older wiring/tests) means a lost acquire
   * is only logged (the prior behavior).
   */
  terminateCatchUpDuplicate?: (taskId: string, detail: string) => void;
  /**
   * Launch an always-running Ralph loop for a schedule that carries a loop
   * config (issue #1899 / #1699 WS2.1). Wired to `launchLoopedPlaybook` in
   * production. When a schedule has {@link Schedule.loop} set and this is
   * absent, the fire records `dispatch_failed` rather than falling through to
   * a one-shot launch (a one-shot would silently drop the loop intent).
   */
  loopedLauncher?: (schedule: Schedule) => Promise<LaunchResult>;
}

export class ScheduleRunner {
  private tickInterval: ReturnType<typeof setInterval> | null = null;
  private pendingWork = new Set<Promise<void>>();
  private firing = false;
  /** Set by {@link stop}; makes a late {@link selfHealRefire} a no-op (#1903). */
  private stopped = false;
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

  /**
   * Latches true once the bounded self-heal has acted at least once (issue
   * #1903). Before that, the snapshot's `deadManSelfHeal` field stays absent
   * (its documented "absent until acted" contract). After it, the runner pushes
   * the counters every tick so a recovery — attempts reset to 0, `escalated`
   * cleared, `successes` incremented — overwrites the stale in-episode value
   * instead of freezing it (e.g. a cap=0 escalate→recover previously left
   * `escalated:true` standing forever).
   */
  private selfHealStatsSurfaced = false;

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

    // Fail-closed auto-pause (issue #2353) MUST complete before catch-up so a
    // schedule already at consecutiveFailures ≥ N cannot re-dispatch on the
    // first post-deploy catch-up pass. Enforce is awaited inside the same
    // background work unit as catch-up (start itself stays sync).
    // Label stays "Catch-up" (trackBackgroundWork union); enforce runs first
    // so pre-existing thrash schedules cannot fire on the catch-up pass.
    this.trackBackgroundWork('Catch-up', (async () => {
      await this.deps.service.enforceFailureAutoPauses();
      // After enforce, lift leftover transient launch_error / overlap holds
      // once the daemon is healthy (issue #2459). Must run before catch-up
      // so a recovered residual fuse can fire the missed slot.
      await this.deps.service.rearmTransientFailureHolds();
      if (catchUpMode === 'auto') {
        await this.catchUp();
      } else if (catchUpMode === 'manual') {
        console.log('[schedule] Automatic catch-up disabled; missed runs are recorded for manual Run Now recovery');
        await this.catchUp({ manualOnly: true });
      } else {
        console.log('[schedule] Catch-up disabled (KOOKR_NO_CATCHUP)');
        await this.catchUp({ suppressOnly: true });
      }
    })());

    this.tickInterval = setInterval(() => {
      this.trackBackgroundWork('Tick', this.tick());
    }, TICK_INTERVAL_MS);

    console.log(`[schedule] Runner started (${this.deps.store.list().length} schedule(s), tick=${TICK_INTERVAL_MS / 1000}s)`);
  }

  async stop(): Promise<void> {
    this.stopped = true;
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
        // Surface the bounded self-heal counters on the status snapshot (issue
        // #1903) so attempt/success activity is observable via /api/health. Only
        // once self-heal has actually acted — keeps the snapshot field absent
        // for unconfigured/never-run switches, matching its documented contract.
        const deadManStats = this.deps.deadMan?.stats?.();
        if (deadManStats) {
          if (
            deadManStats.attempts > 0 ||
            deadManStats.successes > 0 ||
            deadManStats.escalated ||
            // issue #2195: auth class escalates with 0 self-heal attempts —
            // still surface so health shows `auth_expired` without thrash.
            deadManStats.class === 'auth_expired'
          ) {
            this.selfHealStatsSurfaced = true;
          }
          // Absent until self-heal has acted; once surfaced, keep it in sync
          // every tick so a recovery (attempts→0, escalated cleared, successes
          // incremented) overwrites the stale in-episode value instead of
          // freezing it.
          if (this.selfHealStatsSurfaced) {
            this.deps.service.setDeadManSelfHealStats(deadManStats);
          }
        }
      } catch (err) {
        console.error('[schedule] dead-man check failed:', err);
      }

      // Per-schedule liveness / stale-alarm (issue #2694). Runs alongside the
      // dead-man on accumulated ledger state — same decoupling from the fire
      // loop, same defensive wrapper. Catches a single enabled schedule that
      // has gone dark (no ledger activity for far longer than its cadence),
      // which the fleet-wide dead-man misses when healthy siblings mask it.
      try {
        this.deps.staleAlarm?.check(this.deps.store.list());
      } catch (err) {
        console.error('[schedule] stale-alarm check failed:', err);
      }

      // Issue #2459: leftover consecutive_failures holds from a transient
      // launch wedge stay dark after the daemon recovers. Scan each tick
      // (idempotent) so a long-running healthy process re-arms without a
      // restart. Wrapped so a re-arm error cannot abort the fire loop.
      try {
        await this.deps.service.rearmTransientFailureHolds();
      } catch (err) {
        console.error('[schedule] transient-failure re-arm failed:', err);
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

  async runNow(id: string): Promise<ScheduleRunResult> {
    const schedule = this.deps.store.get(id);
    if (!schedule) return { error: 'Schedule not found' };
    return this.fire(schedule, 'manual');
  }

  /**
   * Dead-man bounded self-heal actuator (issue #1903): force the named starving
   * schedules to re-fire out of cron cadence. A schedule caught by the
   * consecutive-failure condition has already fired (and failed) and its next
   * cron run is in the future, so re-running the normal due-only fire loop would
   * do nothing — the remediation has to be a forced (manual-trigger) re-fire of
   * the specific schedule.
   *
   * Deliberately does NOT route through {@link tick} / `deadMan.check()`. A
   * self-heal that re-ran the dead-man check would re-arm itself and consume the
   * entire per-episode attempt cap in a sub-millisecond burst (escalating almost
   * immediately, giving no transient stall time to clear). Because `check()`
   * runs once per interval tick, driving the re-fire straight from there keeps
   * attempts one tick apart.
   *
   * Deferred to a macrotask so it runs after the current tick's synchronous
   * fire dispatch. To avoid a double-launch when a schedule is both due this
   * tick AND starving, {@link forceRefire} skips any schedule whose cron
   * `fire()` is still in flight (see there) — the coalesce guard in {@link fire}
   * alone is insufficient, because a due schedule's accepted `taskId` is not
   * written until its launcher resolves, which can be after this deferred
   * re-fire runs. Each re-fire reuses the same drain / SAFE MODE gates as any
   * other fire (it cannot launch work an operator has cordoned) and the same
   * tracked-work error envelope. No-op once stopped or when no ids are given.
   */
  selfHealRefire(scheduleIds: string[]): void {
    if (this.stopped || scheduleIds.length === 0) return;
    setTimeout(() => {
      if (this.stopped) return;
      for (const id of scheduleIds) {
        this.trackBackgroundWork('Tick', this.forceRefire(id));
      }
    }, 0);
  }

  private async forceRefire(id: string): Promise<void> {
    const schedule = this.deps.store.get(id);
    if (!schedule) return;
    // Don't stack a manual re-fire on top of a cron fire that is still in
    // flight for this schedule (issue #1903). That cron fire hasn't yet
    // recorded its accepted task, so fire()'s coalesce guard would not catch
    // the overlap and both could launch a task for the same occurrence. Once
    // the cron fire settles, either its accepted task lets a later re-fire
    // coalesce, or it failed and a re-fire is legitimately needed next tick.
    if (this.inFlightFires.has(id)) {
      console.warn(
        `[schedule] dead-man self-heal: skipping re-fire of "${schedule.name}" — a fire is already in flight (issue #1903)`,
      );
      return;
    }
    console.warn(`[schedule] dead-man self-heal: forcing re-fire of "${schedule.name}" (issue #1903)`);
    await this.fire(schedule, 'manual');
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
  ): Promise<ScheduleRunResult> {
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
      // Issue #1983: when pre-stop drain is part of an intentional restart
      // (marker present), record a distinct last-miss reason so operators do
      // not treat redeploy as an outage. Generic operator drain keeps the
      // original skipped_draining outcome. Never fire either way.
      const restarting = this.deps.isServerRestarting?.() === true;
      if (restarting) {
        console.warn(`[schedule] Skipping "${schedule.name}" — server restarting (issue #1983)`);
        await this.deps.service.markExecutionOutcome(
          schedule.id,
          receipt.id,
          'skipped_server_restarting',
          'server_restarting',
          'Server restarting — not accepting new launches during redeploy',
        );
        return { error: 'Server restarting' };
      }
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

    // SAFE MODE pre-fire gate (issue #1710). The cross-repo orchestrator
    // schedule is exempt (issue #2672): it must keep ticking while paused so
    // the fleet can auto-resume after a quota window resets — it snapshots,
    // honors the pause, and spawns nothing. Its own agent launch is let through
    // the launch-service gate via `serverOpts.safeModeExempt` below. Every
    // other autonomous schedule (queue-feeder, Parallel Issue Batch,
    // idea-scout, merge-watchdog) stays halted.
    const safeModeExempt = isSafeModeExemptSchedule({
      playbookPath: schedule.playbook?.path,
    });
    if (this.deps.isAutomationEnabled && !this.deps.isAutomationEnabled() && !safeModeExempt) {
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

    // issue #2569: cheap probe first. Converged / probe-blip ticks complete
    // here with no agent and no fleet slot. Exit 2 (or a declared escalate
    // code) falls through to the existing playbook launch for heal + P0.
    const probe = this.resolveProbeForSchedule(schedule);
    if (probe) {
      const runProbe = this.deps.runProbe ?? defaultExecScheduleProbe;
      let probeResult: ProbeExecResult;
      try {
        probeResult = await runProbe(probe.spec, probe.cwd);
      } catch (err) {
        probeResult = {
          exitCode: 1,
          stdout: '',
          stderr: err instanceof Error ? err.message : String(err),
        };
      }
      if (!shouldEscalateProbe(probe.spec, probeResult.exitCode)) {
        const message = probeReceiptLine(probeResult.stdout)
          || probeResult.stderr.trim()
          || `probe exit ${probeResult.exitCode}`;
        const reasonCode = probeResult.exitCode === 1 ? 'probe_blip' : 'probe_quiet';
        await this.deps.service.markProbeCompleted(schedule.id, receipt.id, {
          reasonCode,
          message,
        });
        console.log(
          `[schedule] Probe "${schedule.name}" completed without agent `
          + `(exit ${probeResult.exitCode}, ${reasonCode})`,
        );
        return {};
      }
      console.log(
        `[schedule] Probe "${schedule.name}" exit ${probeResult.exitCode} — escalating to agent`,
      );
    }

    // issue #2194: refresh Grok session-auth cache before agent resolution so
    // a re-login is visible within one tick and expired auth does not keep
    // selecting grok-build when a healthy non-Grok backend is registered.
    await this.refreshGrokAuthGate();

    // Always-running (Ralph) loop arming (issue #1899 / #1699 WS2.1): a
    // schedule with a loop config routes through launchLoopedPlaybook, gated
    // behind the WS0.5 relaunch arbiter so concurrent actuators cannot arm
    // duplicate loops for the same schedule unit.
    if (hasScheduleLoopConfig(schedule)) {
      return this.fireLooped(schedule, receipt);
    }

    // issue #1895 / #1699 WS1.3: pinned-agent availability. Round-robin is
    // resolved inside launchTask; a concrete pin must not pass through to a
    // missing/paused adapter and surface as dispatch_failed.
    // issue #2194: Grok auth expiry is treated as "not launchable" here so
    // substitution can pick a non-Grok backend instead of fail-closing.
    const agentResolution = this.resolveScheduleAgent(schedule);
    if (agentResolution?.kind === 'unavailable') {
      return this.parkUnavailableAgent(schedule, receipt, agentResolution.from);
    }

    // #1526 Phase A / FM8: no capacity pre-check here anymore. At capacity,
    // the launcher (the normal task-submission path) pends the task instead
    // of launching it — same as any other over-cap POST /api/tasks — so a
    // scheduled fire is queued rather than silently dropped. The scheduler's
    // own promotion loop launches it once a slot frees. See
    // markExecutionAccepted for the resulting `queued_capacity` outcome.
    try {
      const launch = await this.deps.validator.resolveLaunch(schedule);
      const agentType =
        agentResolution?.agentType
        ?? resolveScheduleAgentSelection(schedule, this.deps.getDefaultAgentType);
      const substituted = agentResolution?.kind === 'substituted';
      // Issue #2001: carry the schedule hop into launch so plan-quota rotation
      // can append a second hop and stamp the full chain on the task.
      const priorAgentSubstitutions: AgentSubstitutionHop[] | undefined =
        agentResolution?.kind === 'substituted'
          ? [{
              reason: 'schedule_sub',
              from: agentResolution.from,
              to: agentResolution.agentType,
            }]
          : undefined;
      // Preserve each opaque pin independently when the substitute accepts it.
      // A pin that the replacement cannot honor is dropped on its own; model
      // and effort must never be treated as one shared vocabulary.
      const result = await this.deps.launcher({
        prompt: launch.prompt,
        cwd: launch.cwd,
        criteria: launch.criteria,
        name: launch.name,
        playbookId: launch.playbookId,
        projectId: launch.projectId,
        ...(launch.dependencies ? { dependencies: [...launch.dependencies] } : {}),
        agentType,
        // #1518: forward schedule-level effort/model pins into the spawned
        // task. launchTask still validates them against the resolved agent.
        ...(schedule.effort !== undefined && (!substituted || isValidEffortForAgent(agentType as AgentType, schedule.effort))
          ? { effort: schedule.effort }
          : {}),
        ...(schedule.model !== undefined && (!substituted || isValidModelForAgent(agentType as AgentType, schedule.model))
          ? { model: schedule.model }
          : {}),
        ...(priorAgentSubstitutions ? { priorAgentSubstitutions } : {}),
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
      }, safeModeExempt ? { safeModeExempt: true } : undefined);

      const acceptDetails = buildSubstitutionAcceptDetails(
        agentResolution,
        result.agentSubstitutionChain,
      );
      if (substituted || (result.agentSubstitutionChain?.length ?? 0) > 0) {
        try {
          // Count every hop (schedule_sub + any quota_rotate) for the pool-health counter.
          const hopCount = Math.max(
            1,
            result.agentSubstitutionChain?.length
              ?? (substituted ? 1 : 0),
          );
          for (let i = 0; i < hopCount; i++) {
            this.deps.recordAgentSubstitution?.();
          }
        } catch (err) {
          console.error('[schedule] recordAgentSubstitution failed:', err);
        }
        const chainMsg = formatSubstitutionChain(
          result.agentSubstitutionChain
            ?? (agentResolution?.kind === 'substituted'
              ? [{ reason: 'schedule_sub' as const, from: agentResolution.from, to: agentResolution.agentType }]
              : []),
        );
        console.warn(
          `[schedule] Substituted unavailable agent for "${schedule.name}": ${chainMsg}`,
        );
      }
      await this.deps.service.markExecutionAccepted(
        schedule.id,
        receipt.id,
        result.task.id,
        result.queued,
        { ...acceptDetails, ...(result.parked ? { dependencyParked: true } : {}) },
      );
      console.log(
        `[schedule] Fired "${schedule.name}" → task ${result.task.id}`
        + `${result.parked
          ? ' (parked — launch dependency unavailable)'
          : result.queued
            ? ` (queued — at capacity ${this.deps.getActiveCount()}/${this.deps.getMaxActiveTasks()})`
            : ''}`,
      );
      return {
        taskId: result.task.id,
        queued: result.queued,
        ...(result.parked
          ? { parked: true, outcome: 'parked_dependency' as const, reasonCode: 'dependency_degraded' as const }
          : {}),
      };
    } catch (err) {
      return this.recordFireFailure(schedule, receipt, err);
    }
  }

  /**
   * Arm an always-running Ralph loop for a loop-configured schedule (issue
   * #1899 / #1699 WS2.1).
   *
   * Admission is gated behind the WS0.5 relaunch arbiter when one is wired:
   * evaluate before launching so a denied arm creates no task, then acquire
   * the lease under the fired task so a concurrent catch-up / re-dispatch /
   * second cron tick cannot arm a duplicate loop for this schedule unit.
   * Mirrors {@link catchUpFire}'s CAS shape (including the mid-fire lose
   * unwind via {@link ScheduleRunnerDeps.terminateCatchUpDuplicate}).
   */
  private async fireLooped(
    schedule: Schedule,
    receipt: { id: string },
  ): Promise<ScheduleRunResult> {
    const arbiter = this.deps.relaunchArbiter;
    const claimKey = scheduleRelaunchClaimKey(schedule);

    if (arbiter) {
      const decision = arbiter.evaluate(claimKey);
      if (!decision.admit) {
        const message = decision.reason === 'backoff'
          ? `Loop arm withheld — relaunch lease in backoff for ${Math.ceil(decision.retryAfterMs / 1000)}s`
          : `Loop arm withheld — relaunch lease held by ${decision.lease.holderId}`;
        console.log(`[schedule] Skipping loop arm for "${schedule.name}" — ${message}`);
        await this.deps.service.markExecutionOutcome(
          schedule.id,
          receipt.id,
          'skipped_relaunch_locked',
          'relaunch_lease_held',
          message,
        );
        return { error: message };
      }
    }

    if (!this.deps.loopedLauncher) {
      const message = 'Schedule carries a loop config but no looped launcher is wired';
      console.error(`[schedule] Error arming loop for "${schedule.name}":`, message);
      await this.deps.service.markExecutionOutcome(
        schedule.id,
        receipt.id,
        'dispatch_failed',
        'launch_error',
        message,
      );
      return { error: message };
    }

    // issue #1895: same pinned-agent fallback as one-shot fire — loop arming
    // must not dispatch into a missing adapter either. Preserve each pin only
    // when the replacement accepts it, so an incompatible model cannot make
    // the fire fail while an independent compatible effort pin is retained.
    const agentResolution = this.resolveScheduleAgent(schedule);
    if (agentResolution?.kind === 'unavailable') {
      return this.parkUnavailableAgent(schedule, receipt, agentResolution.from);
    }
    let scheduleForLaunch: Schedule = schedule;
    if (agentResolution?.kind === 'substituted') {
      const { effort, model, ...rest } = schedule;
      scheduleForLaunch = {
        ...rest,
        agentType: agentResolution.agentType,
        ...(effort !== undefined && isValidEffortForAgent(agentResolution.agentType, effort) ? { effort } : {}),
        ...(model !== undefined && isValidModelForAgent(agentResolution.agentType, model) ? { model } : {}),
      };
    } else if (agentResolution?.kind === 'available') {
      scheduleForLaunch = { ...schedule, agentType: agentResolution.agentType };
    }

    try {
      const result = await this.deps.loopedLauncher(scheduleForLaunch);
      // Looped launcher may not surface substitution chains; ledger at least
      // the schedule hop (issue #2001).
      const scheduleChain: AgentSubstitutionHop[] | undefined =
        agentResolution?.kind === 'substituted'
          ? [{
              reason: 'schedule_sub',
              from: agentResolution.from,
              to: agentResolution.agentType,
            }]
          : undefined;
      const acceptDetails = buildSubstitutionAcceptDetails(agentResolution, scheduleChain);
      if (agentResolution?.kind === 'substituted') {
        try {
          this.deps.recordAgentSubstitution?.();
        } catch (err) {
          console.error('[schedule] recordAgentSubstitution failed:', err);
        }
        console.warn(
          `[schedule] Substituted unavailable agent for loop arm "${schedule.name}": `
          + `${formatSubstitutionChain(scheduleChain ?? [])}`,
        );
      }
      await this.deps.service.markExecutionAccepted(
        schedule.id,
        receipt.id,
        result.task.id,
        result.queued,
        { ...acceptDetails, ...(result.parked ? { dependencyParked: true } : {}) },
      );
      console.log(
        `[schedule] Armed loop for "${schedule.name}" → task ${result.task.id}`
        + `${result.parked
          ? ' (parked — launch dependency unavailable)'
          : result.queued
            ? ` (queued — at capacity ${this.deps.getActiveCount()}/${this.deps.getMaxActiveTasks()})`
            : ''}`,
      );

      // Hold the relaunch lease under the fired task so a concurrent actuator
      // (catch-up, re-dispatch, second cron tick) is excluded for its lifetime.
      if (arbiter && result.task.id) {
        const acquire = arbiter.tryAcquire(claimKey, result.task.id);
        if (!acquire.ok) {
          const detail =
            acquire.reason === 'backoff'
              ? `relaunch lease entered backoff mid-fire (retry in ${Math.ceil(acquire.retryAfterMs / 1000)}s)`
              : `relaunch lease taken mid-fire by ${acquire.lease.holderId}`;
          console.warn(
            `[schedule] Loop arm for "${schedule.name}" launched task ${result.task.id} but lost the relaunch lease (${acquire.reason}); unwinding the duplicate — ${detail}`,
          );
          this.deps.terminateCatchUpDuplicate?.(result.task.id, detail);
        }
      }

      return {
        taskId: result.task.id,
        queued: result.queued,
        ...(result.parked
          ? { parked: true, outcome: 'parked_dependency' as const, reasonCode: 'dependency_degraded' as const }
          : {}),
      };
    } catch (err) {
      return this.recordFireFailure(schedule, receipt, err);
    }
  }

  private async recordFireFailure(
    schedule: Schedule,
    receipt: { id: string },
    err: unknown,
  ): Promise<{ error: string }> {
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

  /**
   * Refresh the Grok auth usability cache when wired (issue #2194). Never
   * throws — a probe fault must not fail a schedule fire that would otherwise
   * launch on a non-Grok backend.
   */
  private async refreshGrokAuthGate(): Promise<void> {
    if (!this.deps.refreshGrokAuthAvailability) return;
    try {
      await this.deps.refreshGrokAuthAvailability();
    } catch (err) {
      console.warn(
        '[schedule] Grok auth availability refresh failed (continuing with last known verdict):',
        err instanceof Error ? err.message : err,
      );
    }
  }

  /**
   * Resolve a concrete pinned schedule agent against the registered adapter
   * set (issue #1895 / #1699 WS1.3). Returns `null` when availability is not
   * wired (back-compat) or the schedule uses the round-robin sentinel (resolved
   * inside launchTask).
   *
   * Issue #2194: when Grok session auth is unusable, `grok-build` is stripped
   * from the launchable set so substitution can land on a healthy non-Grok
   * backend instead of dispatching into a known auth failure.
   */
  private resolveScheduleAgent(schedule: Schedule): PinnedAgentResolution | null {
    if (!this.deps.getAvailableAgentTypes) return null;
    // Unpinned schedules inherit the live server default before availability
    // substitution — same agent launchTask would pick if agentType were omitted.
    const selection = resolveScheduleAgentSelection(schedule, this.deps.getDefaultAgentType);
    if (selection === ROUND_ROBIN_AGENT_TYPE) return null;
    if (!isAgentType(selection)) return null;
    const registered = this.deps.getAvailableAgentTypes();
    const available = filterLaunchableAgentTypes(registered, {
      grokAuthUsable: this.deps.isGrokAuthUsable?.() ?? true,
    });
    const deprioritized = this.deps.getDeprioritizedAgentTypes?.(available) ?? [];
    const policy = this.deps.getAgentFallbackPolicy?.();
    return resolvePinnedAgentFallback(selection, available, deprioritized, policy);
  }

  /**
   * Park a fire whose pinned agent is unavailable and has no substitute
   * (issue #1895). Uses the WS0 `provider_paused` reason so the operator sees
   * an explicit pause rather than a `dispatch_failed` launch error.
   *
   * Issue #2194: when the pin/default is `grok-build` and Grok session auth is
   * known unusable, record `dispatch_failed` / `auth_expired` instead — a
   * distinct, operator-actionable class (run `grok login`) rather than a
   * generic provider pause or thrashing `launch_error`.
   */
  private async parkUnavailableAgent(
    schedule: Schedule,
    receipt: { id: string },
    from: AgentType,
  ): Promise<{ error: string }> {
    if (from === 'grok-build' && this.deps.isGrokAuthUsable && !this.deps.isGrokAuthUsable()) {
      const message =
        'Grok authentication expired or unusable and no non-Grok substitute is launchable — '
        + 'run `grok login --device-code` (or `grok login --oauth`) and retry. '
        + '(reasonCode: auth_expired)';
      console.warn(`[schedule] Auth-expired park for "${schedule.name}": ${message}`);
      await this.deps.service.markExecutionOutcome(
        schedule.id,
        receipt.id,
        'dispatch_failed',
        'auth_expired',
        message,
      );
      return { error: message };
    }
    const message =
      `Pinned agent ${from} is unavailable and no substitute is registered — `
      + 'fire parked (provider_paused)';
    console.warn(`[schedule] Parking "${schedule.name}": ${message}`);
    await this.deps.service.markExecutionOutcome(
      schedule.id,
      receipt.id,
      'skipped_provider_paused',
      'provider_paused',
      message,
    );
    return { error: message };
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

  /**
   * Resolve a cheap probe for this fire. Frontmatter `probe.command` wins;
   * otherwise a well-known playbook path (kookr/lucy deploy-convergence)
   * supplies the argv. Returns null for ordinary playbooks.
   */
  private resolveProbeForSchedule(schedule: Schedule): { spec: ResolvedScheduleProbe; cwd: string } | null {
    let declared: PlaybookProbe | undefined;
    let cwd = schedule.cwd;
    const parameterDefaults: Record<string, string> = {};
    try {
      const scope = schedule.playbook.scope ?? 'project';
      const resolved = resolveSchedulePlaybookSync(schedule.playbook.path, scope, schedule.cwd);
      if (resolved) {
        const raw = readFileSync(resolved.filePath, 'utf-8');
        const playbook = parsePlaybook(raw, schedule.playbook.path, schedule.cwd, scope);
        declared = playbook.probe;
        if (playbook.cwd) cwd = expandConfiguredCwd(playbook.cwd);
        for (const param of playbook.parameters) {
          if (param.default !== undefined) parameterDefaults[param.name] = param.default;
        }
      }
    } catch {
      // Path fallback still applies when the playbook cannot be parsed.
    }
    const spec = resolveScheduleProbe({
      playbookPath: schedule.playbook.path,
      probe: declared,
      parameters: { ...parameterDefaults, ...schedule.playbook.parameters },
    });
    if (!spec) return null;
    return { spec, cwd };
  }
}

/** Default probe exec — `execFile` with array args, no shell (issue #2569). */
export function defaultExecScheduleProbe(
  spec: ResolvedScheduleProbe,
  cwd: string,
): Promise<ProbeExecResult> {
  return new Promise((resolve) => {
    const [cmd, ...args] = spec.argv;
    if (!cmd) {
      resolve({ exitCode: 1, stdout: '', stderr: 'probe command is empty' });
      return;
    }
    execFile(cmd, args, {
      cwd,
      timeout: spec.timeoutMs,
      maxBuffer: 1024 * 1024,
      env: process.env,
    }, (err, stdout, stderr) => {
      const out = typeof stdout === 'string' ? stdout : '';
      const errOut = typeof stderr === 'string' ? stderr : '';
      if (!err) {
        resolve({ exitCode: 0, stdout: out, stderr: errOut });
        return;
      }
      const code = typeof err.code === 'number' ? err.code : 1;
      resolve({
        exitCode: code,
        stdout: out,
        stderr: errOut || err.message,
      });
    });
  });
}

/**
 * Build ledger accept details for an agent substitution chain (issue #2001).
 * Prefers the full chain (schedule_sub + quota_rotate) when the launcher
 * returned one; falls back to the schedule-only hop.
 */
function buildSubstitutionAcceptDetails(
  agentResolution: PinnedAgentResolution | null | undefined,
  chain: readonly AgentSubstitutionHop[] | undefined,
): { reasonCode: 'agent_substituted'; message: string } | Record<string, never> {
  const hops = chain && chain.length > 0
    ? chain
    : agentResolution?.kind === 'substituted'
      ? [{
          reason: 'schedule_sub' as const,
          from: agentResolution.from,
          to: agentResolution.agentType,
        }]
      : [];
  if (hops.length === 0) return {};
  return {
    reasonCode: 'agent_substituted' as const,
    message: `Substituted unavailable agent ${formatSubstitutionChain(hops)}`,
  };
}

/** Format hops as `a → b → c` (with reason tags when multi-hop). */
function formatSubstitutionChain(hops: readonly AgentSubstitutionHop[]): string {
  if (hops.length === 0) return '';
  if (hops.length === 1) {
    return `${hops[0]!.from} → ${hops[0]!.to}`;
  }
  const parts: string[] = [hops[0]!.from];
  for (const hop of hops) {
    parts.push(`${hop.to} (${hop.reason})`);
  }
  return parts.join(' → ');
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
  // issue #2194: Grok session/OIDC preflight refusal is a distinct auth class,
  // not a generic launcher thrash — readable from GET /api/schedules ledger.
  if (isGrokAuthPreflightError(err)) return 'auth_expired' as const;
  return 'launch_error' as const;
}

/**
 * Detect the GrokBuildAdapter auth preflight refusal without a hard import
 * cycle (schedule-runner ↔ adapters). Matches the structured `code` field and
 * the well-known message prefix as defense in depth.
 */
function isGrokAuthPreflightError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  if (code === 'grok_auth_preflight') return true;
  if (err instanceof Error) {
    return (
      err.name === 'GrokAuthPreflightError'
      || /Grok authentication (expired|unavailable)/i.test(err.message)
    );
  }
  return false;
}

function computeNextRunFor(schedule: Schedule): Date | null {
  const after = schedule.lastScheduledFor
    ? new Date(schedule.lastScheduledFor)
    : new Date(schedule.createdAt);
  return nextRun(schedule.cron, after);
}
