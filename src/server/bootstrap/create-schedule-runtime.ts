import type { TaskStore } from '../../core/tasks.js';
import { ScheduleStore } from '../../core/schedule.js';
import type { ServerMessage } from '../../shared/contracts/messages.js';
import { launchTask, type LaunchServiceDeps } from '../launch-service.js';
import { isTaskBlockingSchedule, ScheduleRunner } from '../schedule-runner.js';
import { ScheduleDeadManSwitch } from '../schedule-dead-man.js';
import { ScheduleResolutionAlerter } from '../schedule-resolution-alert.js';
import { deriveLedgerEnrichment, ScheduleService } from '../schedule-service.js';
import { ScheduleValidator } from '../schedule-validator.js';
import { bindOperationalAlertSink, OperationalAlertSink } from '../operational-alert-sink.js';

export interface ScheduleRuntimeDeps {
  kookrDir: string;
  taskStore: TaskStore;
  launchServiceDeps: LaunchServiceDeps;
  getMaxActiveTasks: () => number;
  broadcastToAll: (msg: ServerMessage) => void;
  /** Operator drain gate (issue #659): suppress schedule firing while draining. */
  isAccepting?: () => boolean;
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
   * Re-queue-after-reset scheduler (issue #1896 / #1699 WS1.4). When provided,
   * its `sweep()` runs once per schedule-runner tick so provider-paused issues
   * auto-resume at their reset time (jittered, token-bucket-bounded, lease-keyed
   * dedup). Absent means no auto-resume (back-compat for older wiring/tests).
   */
  resetScheduler?: { sweep(now?: number): unknown };
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
      taskStore.cancelTask(taskId);
      return;
    }
    taskStore.terminateTask(taskId, {
      reason: 'supervisor',
      detail: `catch-up duplicate unwound — ${detail}`,
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
  const recordOperationalAlert = bindOperationalAlertSink(operationalAlertSink);
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
    // issue #1665: raise a per-schedule failure alert through the same
    // dashboard alert channel the dead-man switch uses.
    emitAlert: (message) => deps.broadcastToAll(message),
    ...(deps.getScheduleFailureAlertThreshold
      ? { getFailureAlertThreshold: deps.getScheduleFailureAlertThreshold }
      : {}),
  });
  await scheduleService.reconcileOnStartup(deps.taskStore);

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
    launcher: (opts) => launchTask(deps.launchServiceDeps, opts),
    getActiveCount: () => deps.taskStore.getActiveCount(),
    getMaxActiveTasks: deps.getMaxActiveTasks,
    ...(deps.isAccepting ? { isAccepting: deps.isAccepting } : {}),
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
    ...(deps.launchServiceDeps.relaunchArbiter
      ? { relaunchArbiter: deps.launchServiceDeps.relaunchArbiter }
      : {}),
    // issue #1914: unwind a catch-up fire that lost the relaunch-lease CAS.
    terminateCatchUpDuplicate: (taskId, detail) =>
      unwindCatchUpDuplicate(deps.taskStore, taskId, detail),
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
    // issue #1661: operational alert when a schedule's playbook stops resolving
    // in its (defaulted) tier — including one silently broken by the scope
    // migration. Fires within one validation cycle instead of only surfacing
    // as a ledger `dispatch_failed` on the next fire.
    resolutionAlerter: new ScheduleResolutionAlerter({
      broadcast: deps.broadcastToAll,
    }),
    // issue #1896: auto-resume provider-paused issues on the runner's tick.
    ...(deps.resetScheduler ? { resetScheduler: deps.resetScheduler } : {}),
  });
  // Complete the late binding so the dead-man self-heal can kick this runner.
  scheduleRunnerRef = scheduleRunner;

  return { scheduleStore, scheduleValidator, scheduleService, scheduleRunner, operationalAlertSink };
}
