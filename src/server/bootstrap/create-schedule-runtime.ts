import type { TaskStore } from '../../core/tasks.js';
import { ScheduleStore } from '../../core/schedule.js';
import type { ServerMessage } from '../../shared/contracts/messages.js';
import { launchTask, type LaunchServiceDeps } from '../launch-service.js';
import { isTaskBlockingSchedule, ScheduleRunner } from '../schedule-runner.js';
import { ScheduleDeadManSwitch } from '../schedule-dead-man.js';
import { deriveLedgerEnrichment, ScheduleService } from '../schedule-service.js';
import { ScheduleValidator } from '../schedule-validator.js';

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
}

export interface ScheduleRuntime {
  scheduleStore: ScheduleStore;
  scheduleValidator: ScheduleValidator;
  scheduleService: ScheduleService;
  scheduleRunner: ScheduleRunner;
}

export async function createScheduleRuntime(deps: ScheduleRuntimeDeps): Promise<ScheduleRuntime> {
  const scheduleStore = new ScheduleStore(deps.kookrDir);
  await scheduleStore.load();
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
      ...(deps.getDeadManScheduleMs ? { getDeadManMs: deps.getDeadManScheduleMs } : {}),
    }),
  });

  return { scheduleStore, scheduleValidator, scheduleService, scheduleRunner };
}
