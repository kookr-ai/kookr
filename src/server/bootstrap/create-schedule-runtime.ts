import type { TaskStore } from '../../core/tasks.js';
import type { AgentSelection } from '../../core/agent-types.js';
import { ScheduleStore, type Schedule } from '../../core/schedule.js';
import type { ServerMessage } from '../../shared/contracts/messages.js';
import { launchTask, type LaunchServiceDeps } from '../launch-service.js';
import { isTaskBlockingSchedule, ScheduleRunner } from '../schedule-runner.js';
import { ScheduleDeadManSwitch } from '../schedule-dead-man.js';
import { ScheduleStaleAlarm } from '../schedule-liveness.js';
import { ScheduleResolutionAlerter } from '../schedule-resolution-alert.js';
import { deriveLedgerEnrichment, deriveScheduleTerminalReason, ScheduleService } from '../schedule-service.js';
import { ScheduleValidator } from '../schedule-validator.js';
import { bindOperationalAlertSink, OperationalAlertSink } from '../operational-alert-sink.js';
import type { RalphLoopService } from '../ralph-loop-service.js';
import { launchLoopedPlaybook } from '../use-cases/looped-playbook-launch.js';
import { isServerRestartingActive } from '../server-restart-marker.js';

export interface ScheduleRuntimeDeps {
  kookrDir: string;
  taskStore: TaskStore;
  launchServiceDeps: LaunchServiceDeps;
  getMaxActiveTasks: () => number;
  broadcastToAll: (msg: ServerMessage) => void;
  /** Operator drain gate (issue #659): suppress schedule firing while draining. */
  isAccepting?: () => boolean;
  /**
   * Live getter for `settings.defaultAgentType`. When a create payload omits
   * `agentType`, the schedule service pins the schedule to this value rather
   * than the code constant `DEFAULT_AGENT_TYPE` (`claude-code`).
   */
  getDefaultAgentType?: () => AgentSelection;
  /**
   * Record one provider fallback substitution for the WS1.5 health counter
   * (issue #1895 / #1699 WS1.3). Typically `providerHealthTracker.recordSubstitution`.
   */
  recordAgentSubstitution?: () => void;
  /**
   * Automation kill-switch (issue #1710): suppress schedule firing while SAFE
   * MODE is engaged. Manual launches remain accepted.
   */
  isAutomationEnabled?: () => boolean;
  /**
   * Live getter for the scheduled-task starvation dead-man window, in ms
   * (issue #1526 Phase C, `deadManScheduleMinutes` setting). Absent falls
   * back to the module default (120m).
   */
  getDeadManScheduleMs?: () => number;
  /**
   * Live getter for the per-schedule liveness stale-alarm floor, in ms (issue
   * #2694). A schedule is flagged dark when it has left no ledger activity for
   * longer than max(cadence × multiplier, this floor). Absent falls back to the
   * module default (6h); a value <= 0 disables the alarm.
   */
  getStaleScheduleFloorMs?: () => number;
  /**
   * Live getter for the per-schedule consecutive-failure alert threshold
   * (issue #1665, `scheduleFailureAlertThreshold` setting). Absent falls back
   * to the schedule service default.
   */
  getScheduleFailureAlertThreshold?: () => number;
  /**
   * Optional durable sink for operational-alert fire/clear transitions (issue
   * #1709, WS0.3). When omitted, one is created under `kookrDir`. Provided
   * (shared) so future emitters — e.g. WS1 provider-health — record through the
   * same sink.
   */
  operationalAlertSink?: OperationalAlertSink;
  /**
   * Optional side-effect for every operational-alert transition the schedule
   * runtime records (issue #1995 ops-status card). Invoked after the durable
   * JSONL sink is queued; must not throw.
   */
  onOperationalAlert?: (alert: Extract<ServerMessage, { type: 'alert' }>) => void;
  /**
   * Re-queue-after-reset scheduler (issue #1896 / #1699 WS1.4). When provided,
   * its `sweep()` runs once per schedule-runner tick so provider-paused issues
   * auto-resume at their reset time (jittered, token-bucket-bounded, lease-keyed
   * dedup). Absent means no auto-resume (back-compat for older wiring/tests).
   */
  resetScheduler?: { sweep(now?: number): unknown };
  /**
   * Ralph loop service used to arm always-running loops from a schedule with
   * a loop config (issue #1899 / #1699 WS2.1). When provided, the runner wires
   * `launchLoopedPlaybook` as its `loopedLauncher`. Absent means loop-configured
   * schedules fail dispatch with a clear ledger error (no silent one-shot fallthrough).
   */
  ralphLoopService?: RalphLoopService;
  /** Test seam for verifying composition-root forwarding into looped launches. */
  launchLoopedPlaybookFn?: typeof launchLoopedPlaybook;
  /**
   * Cleanup hook for a looped-playbook launch that partially fails after task
   * creation (issue #1899). Typically `cancelTask` from agent-lifecycle.
   */
  cleanupFailedTask?: (taskId: string) => Promise<void>;
  /**
   * Live daemon-healthy signal for leftover consecutive_failures re-arm
   * (issue #2459). True when startup phase is `ready`. Absent leaves
   * transient holds in place until an operator PATCH.
   */
  isHealthy?: () => boolean;
  /**
   * ISO timestamp of when this process became ready. Leftover holds are
   * only lifted when their last fire predates this watermark.
   */
  getReadyAt?: () => string | undefined;
  /**
   * ISO timestamp of the running build (issue #2520, `buildInfo.buildTimestamp`).
   * When present, a one-line post-deploy diagnostic lists `consecutive_failures`
   * holds established before this build — candidates a just-deployed fix may
   * have cleared. Absent (dev build) skips the diagnostic.
   */
  getBuildTimestamp?: () => string | undefined;
}

export interface ScheduleRuntime {
  scheduleStore: ScheduleStore;
  scheduleValidator: ScheduleValidator;
  scheduleService: ScheduleService;
  scheduleRunner: ScheduleRunner;
  /** Durable JSONL sink recording dead-man (and future provider-health) transitions. */
  operationalAlertSink: OperationalAlertSink;
}

/**
 * Best-effort unwind of a catch-up fire that launched but then LOST the
 * relaunch-lease CAS (issue #1914). Wired as the schedule runner's
 * {@link ScheduleRunnerDeps.terminateCatchUpDuplicate} hook.
 *
 * The just-fired duplicate is `inProgress` (launched below capacity) or
 * `pending` (queued at capacity, #1526 Phase A). `terminated` is not a valid
 * transition FROM `pending` — only `inProgress`/`open` may be terminated (see
 * VALID_TRANSITIONS in src/core/tasks.ts) — so a pending duplicate, which never
 * attached a session, is `cancelled` instead. Both are deliberate,
 * non-recoverable terminal states: crash-recovery skips a `supervisor`
 * termination (crash-recovery.ts) and never sees a session-less pending/cancelled
 * task, so neither is relaunched; a terminated in-session duplicate has its
 * session reclaimed by the terminal-task session reaper (#1720) on the next tick.
 *
 * Wrapped best-effort (mirrors the launch-service rollback guard): a losing
 * transition — e.g. the task went terminal between the status read and the write
 * — must never abort the once-per-boot catch-up loop this unwind protects.
 */
export function unwindCatchUpDuplicate(
  taskStore: Pick<TaskStore, 'getTask' | 'cancelTask' | 'terminateTask'>,
  taskId: string,
  detail: string,
): void {
  try {
    const task = taskStore.getTask(taskId);
    if (!task) return;
    if (task.status === 'pending') {
      taskStore.cancelTask(taskId, {
        source: 'schedule',
        reason: 'supervisor',
        workDisposition: 'superseded',
        detail: `catch-up duplicate unwound — ${detail}`,
      });
      return;
    }
    taskStore.terminateTask(taskId, {
      reason: 'supervisor',
      detail: `catch-up duplicate unwound — ${detail}`,
    }, {
      source: 'schedule',
      workDisposition: 'superseded',
    });
  } catch (err) {
    console.error(`[schedule] Failed to unwind catch-up duplicate ${taskId}:`, err);
  }
}

export async function createScheduleRuntime(deps: ScheduleRuntimeDeps): Promise<ScheduleRuntime> {
  const scheduleStore = new ScheduleStore(deps.kookrDir);
  await scheduleStore.load();
  const operationalAlertSink =
    deps.operationalAlertSink ?? new OperationalAlertSink({ kookrDir: deps.kookrDir });
  const recordOperationalAlert = bindOperationalAlertSink(
    operationalAlertSink,
    deps.onOperationalAlert,
  );
  const scheduleValidator = new ScheduleValidator();
  const scheduleService = new ScheduleService({
    store: scheduleStore,
    validator: scheduleValidator,
    broadcast: (payload) => {
      deps.broadcastToAll({ type: 'schedules', ...payload });
    },
    // issue #1582: join cost/artifacts onto ledger rows at write time by
    // reading the completed fire's task from the live store.
    resolveLedgerEnrichment: (taskId) => deriveLedgerEnrichment(deps.taskStore.getTask(taskId)),
    // issue #2877: join the fire's classified terminal reason onto its schedule
    // execution receipt at the terminal transition, by reading the task's
    // structured terminal receipt (#2847). Legacy/absent tasks classify as
    // explicit unknowns rather than being guessed.
    resolveTerminalReason: (taskId) => deriveScheduleTerminalReason(deps.taskStore.getTask(taskId)),
    // issue #1665: raise a per-schedule failure alert through the same
    // dashboard alert channel the dead-man switch uses.
    emitAlert: (message) => deps.broadcastToAll(message),
    ...(deps.getScheduleFailureAlertThreshold
      ? { getFailureAlertThreshold: deps.getScheduleFailureAlertThreshold }
      : {}),
    ...(deps.getDefaultAgentType ? { getDefaultAgentType: deps.getDefaultAgentType } : {}),
    ...(deps.isHealthy ? { getDaemonHealthy: deps.isHealthy } : {}),
    ...(deps.getReadyAt ? { getReadyAt: deps.getReadyAt } : {}),
    // Issue #2512: lets reconcileOnStartup excuse a boot-reconciled `unknown`
    // session-death as restart churn only when a graceful redeploy actually
    // caused the stop (same marker the runner uses for skipped_server_restarting).
    isServerRestarting: () => isServerRestartingActive(deps.kookrDir),
  });
  await scheduleService.reconcileOnStartup(deps.taskStore);
  // Issue #2520: post-deploy diagnostic — list consecutive_failures holds older
  // than the running build so an operator can see which dark schedules a just-
  // deployed fix may have cleared. Pure logging; no auto-flip.
  scheduleService.logConsecutiveFailureHoldsAfterDeploy(deps.getBuildTimestamp?.());

  const activeStatuses = new Set(['open', 'pending', 'inProgress']);
  // Late-bound reference so the dead-man's self-heal action can drive re-fires
  // on the runner that owns it (issue #1903). The runner is constructed with the
  // switch, so the switch cannot capture the runner directly — this holder is
  // assigned immediately below and is always set before any tick (and thus any
  // self-heal re-fire, which only ever originates from within a tick).
  let scheduleRunnerRef: ScheduleRunner | undefined;
  const scheduleRunner = new ScheduleRunner({
    store: scheduleStore,
    service: scheduleService,
    validator: scheduleValidator,
    launcher: (opts, serverOpts) => launchTask(deps.launchServiceDeps, opts, serverOpts),
    getActiveCount: () => deps.taskStore.getActiveCount(),
    getMaxActiveTasks: deps.getMaxActiveTasks,
    ...(deps.isAccepting ? { isAccepting: deps.isAccepting } : {}),
    // Issue #1983: distinguish pre-stop redeploy drain from a manual cordon
    // via the short-lived marker written by scripts/prod-restart.sh.
    isServerRestarting: () => isServerRestartingActive(deps.kookrDir),
    ...(deps.isAutomationEnabled ? { isAutomationEnabled: deps.isAutomationEnabled } : {}),
    isTaskBlockingSchedule: (taskId) => {
      const task = deps.taskStore.getTask(taskId);
      const blocking = isTaskBlockingSchedule(task);
      if (task && !blocking && activeStatuses.has(task.status)) {
        const ageHours = (Date.now() - task.updatedAt.getTime()) / 3_600_000;
        console.warn(
          `[schedule] Task ${taskId} treated as abandoned (${ageHours.toFixed(1)}h since update); allowing next run`,
        );
      }
      return blocking;
    },
    // issue #1526 Phase A: split isTaskBlockingSchedule's boolean into a
    // status the runner uses to distinguish skipped_coalesced (still
    // pending) from skipped_active (actively running).
    getBlockingTaskStatus: (taskId) => deps.taskStore.getTask(taskId)?.status,
    // issue #1900 / #1699 WS2.2: gate startup catch-up fires behind the same
    // WS0.5 relaunch arbiter the launch path uses, so a missed run cannot
    // duplicate a concurrent actuator relaunching the schedule's work.
    // Also gates schedule loop-arming (issue #1899 / WS2.1).
    ...(deps.launchServiceDeps.relaunchArbiter
      ? { relaunchArbiter: deps.launchServiceDeps.relaunchArbiter }
      : {}),
    // issue #1914: unwind a catch-up / loop-arm fire that lost the relaunch-lease CAS.
    terminateCatchUpDuplicate: (taskId, detail) =>
      unwindCatchUpDuplicate(deps.taskStore, taskId, detail),
    // issue #1899 / #1699 WS2.1: arm always-running Ralph loops from schedules
    // that carry a loop config. Routes through launchLoopedPlaybook so the
    // playbook's loopable tag + effectiveLoop apply, and the in-process
    // duplicate-loop check runs as a second line of defence behind the arbiter.
    ...(deps.ralphLoopService
      ? {
          loopedLauncher: (schedule: Schedule) =>
            (deps.launchLoopedPlaybookFn ?? launchLoopedPlaybook)(
              {
                taskStore: deps.taskStore,
                ralphLoopService: deps.ralphLoopService!,
                launchTask: (opts, serverOpts) => launchTask(deps.launchServiceDeps, opts, serverOpts),
                getMaxActiveTasks: deps.getMaxActiveTasks,
                ...(deps.cleanupFailedTask ? { cleanupFailedTask: deps.cleanupFailedTask } : {}),
              },
              {
                playbookPath: schedule.playbook.path,
                parameterValues: schedule.playbook.parameters,
                playbookSourceCwd: schedule.playbook.sourceCwd ?? schedule.cwd,
                taskTargetCwd: schedule.cwd,
                taskTargetCwdExplicit: schedule.playbook.sourceCwd !== undefined,
                ...(schedule.playbook.scope ? { scope: schedule.playbook.scope } : {}),
                agentType: schedule.agentType,
                launchSource: 'schedule',
                scheduleId: schedule.id,
                ...(schedule.effort ? { effort: schedule.effort } : {}),
                ...(schedule.model ? { model: schedule.model } : {}),
                ...(schedule.modelTier ? { modelTier: schedule.modelTier } : {}),
              },
            ),
        }
      : {}),
    // issue #1526 Phase C: dead-man switch for scheduled-task starvation,
    // evaluated on the runner's existing tick. Bounded self-heal (issue #1903).
    deadMan: new ScheduleDeadManSwitch({
      broadcast: deps.broadcastToAll,
      // issue #1709 (WS0.3): durable sink so a starvation fire→clear that
      // happens while no dashboard client is connected still leaves a trace.
      recordTransition: recordOperationalAlert,
      // issue #1903 (WS2.5): bounded self-heal — force the starving schedule(s)
      // to re-fire (one attempt per dead-man tick), capped per episode; on cap
      // exhaustion the switch escalates to a standing durable alert (see
      // ScheduleDeadManSwitch).
      selfHeal: (scheduleIds) => scheduleRunnerRef?.selfHealRefire(scheduleIds),
      ...(deps.getDeadManScheduleMs ? { getDeadManMs: deps.getDeadManScheduleMs } : {}),
    }),
    // issue #2694: per-schedule liveness / stale-alarm. Catches a single
    // enabled schedule that has gone dark (no ledger activity for far longer
    // than its cadence warrants) — the blind spot the fleet-wide dead-man
    // misses when healthy sibling schedules mask it. Alert-only, durable sink.
    staleAlarm: new ScheduleStaleAlarm({
      broadcast: deps.broadcastToAll,
      recordTransition: recordOperationalAlert,
      ...(deps.getStaleScheduleFloorMs ? { getStaleFloorMs: deps.getStaleScheduleFloorMs } : {}),
    }),
    // issue #1661: operational alert when a schedule's playbook stops resolving
    // in its (defaulted) tier — including one silently broken by the scope
    // migration. Fires within one validation cycle instead of only surfacing
    // as a ledger `dispatch_failed` on the next fire.
    resolutionAlerter: new ScheduleResolutionAlerter({
      broadcast: deps.broadcastToAll,
    }),
    // issue #1896: auto-resume provider-paused issues on the runner's tick.
    ...(deps.resetScheduler ? { resetScheduler: deps.resetScheduler } : {}),
    // issue #1895 / #1699 WS1.3: schedule-level pinned-agent fallback.
    // issue #2194: Grok auth usability is applied inside resolveScheduleAgent
    // (filterLaunchableAgentTypes) so registered-but-auth-expired grok-build
    // is not treated as launchable when a non-Grok substitute exists.
    getAvailableAgentTypes: () => deps.launchServiceDeps.adapterRegistry.getTypes(),
    // Unpinned schedules inherit the live server default at fire time.
    ...(deps.getDefaultAgentType ? { getDefaultAgentType: deps.getDefaultAgentType } : {}),
    ...(deps.launchServiceDeps.getDeprioritizedAgentTypes
      ? { getDeprioritizedAgentTypes: deps.launchServiceDeps.getDeprioritizedAgentTypes }
      : {}),
    // Issue #2001: same fallback policy as launch-service plan-quota rotation.
    ...(deps.launchServiceDeps.getAgentFallbackPolicy
      ? { getAgentFallbackPolicy: deps.launchServiceDeps.getAgentFallbackPolicy }
      : {}),
    // Issue #2194: share the launch-service Grok auth gate with the schedule runner.
    ...(deps.launchServiceDeps.isGrokAuthUsable
      ? { isGrokAuthUsable: deps.launchServiceDeps.isGrokAuthUsable }
      : {}),
    ...(deps.launchServiceDeps.refreshGrokAuthAvailability
      ? { refreshGrokAuthAvailability: deps.launchServiceDeps.refreshGrokAuthAvailability }
      : {}),
    ...(deps.recordAgentSubstitution
      ? { recordAgentSubstitution: deps.recordAgentSubstitution }
      : {}),
  });
  // Complete the late binding so the dead-man self-heal can kick this runner.
  scheduleRunnerRef = scheduleRunner;

  return { scheduleStore, scheduleValidator, scheduleService, scheduleRunner, operationalAlertSink };
}
