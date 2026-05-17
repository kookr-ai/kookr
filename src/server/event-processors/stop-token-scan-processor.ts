import type { SessionInfo, Task } from '../../core/tasks.js';
import type { TokenUsage } from '../../core/types.js';

type TokenScanTask = Pick<Task, 'id'> & { sessions: Pick<SessionInfo, 'tmuxSession' | 'lastStatus'>[] };

interface TaskTokenUsageWriter {
  updateTokenUsage(taskId: string, usage: TokenUsage): void;
}

interface TaskTokenScanner {
  scanTask(taskId: string): Promise<boolean>;
  getUsage(taskId: string): TokenUsage | undefined;
}

interface TokenActivityRecorder {
  recordTokenActivity(tmuxName: string): void;
}

export interface StopTokenScanProcessorDeps {
  tokenUsageWriter: TaskTokenUsageWriter;
  tokenScanner: TaskTokenScanner;
  tokenActivityRecorder: TokenActivityRecorder;
  broadcastSnapshot: () => void;
  publishTaskProjection?: (taskId: string) => void;
}

export interface StopTokenScanProcessor {
  process(stopTask: TokenScanTask | undefined): void;
}

export function createStopTokenScanProcessor({
  tokenUsageWriter,
  tokenScanner,
  tokenActivityRecorder,
  broadcastSnapshot,
  publishTaskProjection,
}: StopTokenScanProcessorDeps): StopTokenScanProcessor {
  return {
    process(stopTask) {
      if (!stopTask) return;

      // On stop/stop_failure events, immediately scan transcript for updated spending.
      tokenScanner.scanTask(stopTask.id).then((changed) => {
        if (!changed) return;
        const usage = tokenScanner.getUsage(stopTask.id);
        if (usage) {
          tokenUsageWriter.updateTokenUsage(stopTask.id, usage);
        }
        // Notify watchdog of token activity (mirrors lifecycle-timers.ts:76-80).
        for (const session of stopTask.sessions) {
          if (session.lastStatus !== 'completed' && session.lastStatus !== 'aborted') {
            tokenActivityRecorder.recordTokenActivity(session.tmuxSession);
          }
        }
        broadcastSnapshot();
        publishTaskProjection?.(stopTask.id);
      }).catch(() => { /* scan failure is non-critical — fallback poll will catch it */ });
    },
  };
}
