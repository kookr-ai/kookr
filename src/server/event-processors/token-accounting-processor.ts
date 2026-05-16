import type { Task } from '../../core/tasks.js';
import type { AgentEvent } from '../../core/types.js';

type TokenOwnerTask = Pick<Task, 'id'>;

interface TaskSessionLookup {
  findTaskBySession(tmuxName: string): TokenOwnerTask | null | undefined;
}

interface TranscriptRegistry {
  register(transcriptPath: string, taskId: string): void;
}

export interface TokenAccountingProcessorDeps {
  taskLookup: TaskSessionLookup;
  transcriptRegistry: TranscriptRegistry;
}

export interface TokenAccountingEvent {
  tmuxName: string;
  event: AgentEvent;
}

export interface TokenAccountingProcessor {
  process(input: TokenAccountingEvent): void;
}

export function createTokenAccountingProcessor({
  taskLookup,
  transcriptRegistry,
}: TokenAccountingProcessorDeps): TokenAccountingProcessor {
  // Pending transcript registrations: if session_start arrives before the task
  // is findable (race between hook event and task creation), retry on next event.
  const pendingTranscriptRegistrations = new Map<string, string>();

  return {
    process({ tmuxName, event }) {
      // Token tracking runs for ALL parentages: a cross-session child writing to
      // the same Kookr hook file still has tokens that should roll up to the
      // parent task. The token tracker is path-keyed, so a child SessionStart
      // with a distinct transcriptPath registers a separate transcript that
      // findTaskBySession associates with the parent task. See
      // rfc-activity-log-reliability §3.
      if (event.type === 'session_start' && event.transcriptPath) {
        const task = taskLookup.findTaskBySession(tmuxName);
        if (task) {
          transcriptRegistry.register(event.transcriptPath, task.id);
        } else {
          pendingTranscriptRegistrations.set(tmuxName, event.transcriptPath);
        }
      }

      // Register subagent transcripts so their tokens are summed into the parent
      // task (rfc-cost-comparison-panel.md R13). `tokenTracker.register` is
      // idempotent on path, so multiple SubagentStop events for the same
      // isSidechain transcript do not double-count.
      if (event.type === 'subagent_stop' && event.agentTranscriptPath) {
        const parentTask = taskLookup.findTaskBySession(tmuxName);
        if (parentTask) {
          transcriptRegistry.register(event.agentTranscriptPath, parentTask.id);
        }
      }

      // Retry pending registration on any subsequent event.
      if (pendingTranscriptRegistrations.has(tmuxName)) {
        const task = taskLookup.findTaskBySession(tmuxName);
        if (task) {
          transcriptRegistry.register(pendingTranscriptRegistrations.get(tmuxName)!, task.id);
          pendingTranscriptRegistrations.delete(tmuxName);
        }
      }
    },
  };
}
