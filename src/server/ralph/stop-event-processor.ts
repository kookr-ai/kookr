import type { Task } from '../../core/tasks.js';
import type { AgentEvent, TokenUsage } from '../../core/types.js';

interface TaskCostReader {
  getUsage(taskId: string): Pick<TokenUsage, 'costUsd'> | undefined;
}

interface RalphStopHandler {
  finalizeCompletedLoopStop(task: Task, tmuxName: string, event: AgentEvent): Promise<boolean>;
  handleStopEvent(
    task: Task,
    tmuxName: string,
    event: AgentEvent,
    opts: { cumulativeCostUsd: number | null },
  ): Promise<void>;
}

export interface RalphStopProcessorDeps {
  taskCostReader: TaskCostReader;
  runningLoopHandlingEnabled: boolean;
  ralphStopHandler: RalphStopHandler;
  broadcastSnapshot: () => void;
  publishTaskProjection?: (taskId: string) => void;
}

export interface RalphStopProcessor {
  process(stopTask: Task | undefined, tmuxName: string, event: AgentEvent): void;
}

export function createRalphStopProcessor({
  taskCostReader,
  runningLoopHandlingEnabled,
  ralphStopHandler,
  broadcastSnapshot,
  publishTaskProjection,
}: RalphStopProcessorDeps): RalphStopProcessor {
  return {
    process(stopTask, tmuxName, event) {
      if (stopTask?.ralphLoop?.status === 'completed') {
        ralphStopHandler.finalizeCompletedLoopStop(stopTask, tmuxName, event)
          .then((changed) => {
            if (changed) {
              broadcastSnapshot();
              publishTaskProjection?.(stopTask.id);
            }
          })
          .catch((err) => {
            console.error('[ralph-loop-service] finalizeCompletedLoopStop failed:', err);
          });
      } else if (stopTask?.ralphLoop?.status === 'running' && runningLoopHandlingEnabled) {
        ralphStopHandler.handleStopEvent(stopTask, tmuxName, event, {
          cumulativeCostUsd: taskCostReader.getUsage(stopTask.id)?.costUsd ?? null,
        })
          .then(() => {
            publishTaskProjection?.(stopTask.id);
          })
          .catch((err) => {
            console.error('[ralph-loop-service] handleStopEvent failed:', err);
          });
      }
    },
  };
}
