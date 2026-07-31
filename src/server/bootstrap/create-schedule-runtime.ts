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
}

export interface ScheduleRuntime {
  scheduleStore: ScheduleStore;
  scheduleValidator: ScheduleValidator;
  scheduleService: ScheduleService;
  scheduleRunner: ScheduleRunner;
  /** Durable JSONL sink recording dead-man (and future provider-health) transitions. */
  operationalAlertSink: OperationalAlertSink;
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
  const scheduleRunner = new ScheduleRunner({
    store: scheduleStore,
    service: scheduleService,
    validator: scheduleValidator,
    launcher: (opts) => launchTask(deps.launchServiceDeps, opts),
    getActiveCount: () => deps.taskStore.getActiveCount(),
    getMaxActiveTasks: deps.getMaxActiveTasks,
    ...(deps.isAccepting ? { isAccepting: deps.isAccepting } : {}),
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
    // issue #1526 Phase C: dead-man switch for scheduled-task starvation,
    // evaluated on the runner's existing tick. Alert-only.
    deadMan: new ScheduleDeadManSwitch({
      broadcast: deps.broadcastToAll,
      // issue #1709 (WS0.3): durable sink so a starvation fire→clear that
      // happens while no dashboard client is connected still leaves a trace.
      recordTransition: recordOperationalAlert,
      ...(deps.getDeadManScheduleMs ? { getDeadManMs: deps.getDeadManScheduleMs } : {}),
    }),
    // issue #1661: operational alert when a schedule's playbook stops resolving
    // in its (defaulted) tier — including one silently broken by the scope
    // migration. Fires within one validation cycle instead of only surfacing
    // as a ledger `dispatch_failed` on the next fire.
    resolutionAlerter: new ScheduleResolutionAlerter({
      broadcast: deps.broadcastToAll,
    }),
  });

  return { scheduleStore, scheduleValidator, scheduleService, scheduleRunner, operationalAlertSink };
}
