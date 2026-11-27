import { cpus, loadavg } from 'node:os';
import type { Task } from '../../core/tasks.js';
import type { ServerMessage } from '../../shared/contracts/messages.js';
import {
  FleetVitalsService,
  type FleetVitalsGpuSource,
  type FleetVitalsLiveTask,
} from '../fleet-vitals-service.js';
import { GpuProbe } from '../gpu-probe.js';

export interface CreateFleetVitalsServiceDeps {
  taskStore: { viewLiveTasks(): readonly Task[] };
  monitor: { getFleetSubagentCount(): number };
  broadcastToAll: (msg: ServerMessage) => void;
  /**
   * Whether a dashboard is connected. `nvidia-smi` is only run while someone is
   * watching; everything else in the sample is read from memory and stays on,
   * so the trend lines are already filled when a dashboard opens.
   */
  hasDashboardClients: () => boolean;
  /** Test seam. Defaults to the real `nvidia-smi` probe. */
  gpuProbe?: FleetVitalsGpuSource;
}

/**
 * The live tasks the fleet vitals count as running agents: tasks whose agent
 * session has started and not reached a terminal state.
 */
export function listLiveAgentTasks(tasks: readonly Task[]): FleetVitalsLiveTask[] {
  const live: FleetVitalsLiveTask[] = [];
  for (const task of tasks) {
    if (task.status !== 'inProgress') continue;
    const usage = task.tokenUsage;
    live.push({
      id: task.id,
      tokens: usage
        ? {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheReadTokens: usage.cacheReadTokens,
            cacheWriteTokens: usage.cacheWriteTokens,
          }
        : null,
    });
  }
  return live;
}

/** `os.loadavg()` returns zeros on Windows, where the figure does not exist. */
function readLoadAverage1m(): number | null {
  if (process.platform === 'win32') return null;
  const [oneMinute] = loadavg();
  return Number.isFinite(oneMinute) ? oneMinute : null;
}

function readLogicalCpuCount(): number | null {
  const count = cpus().length;
  return count > 0 ? count : null;
}

export function createFleetVitalsService(deps: CreateFleetVitalsServiceDeps): FleetVitalsService {
  const probe = deps.gpuProbe ?? new GpuProbe();
  return new FleetVitalsService({
    broadcastToAll: deps.broadcastToAll,
    gpu: probe,
    isWatched: deps.hasDashboardClients,
    listLiveTasks: () => listLiveAgentTasks(deps.taskStore.viewLiveTasks()),
    countSubagents: () => deps.monitor.getFleetSubagentCount(),
    readLoadAverage1m,
    readLogicalCpuCount,
  });
}
