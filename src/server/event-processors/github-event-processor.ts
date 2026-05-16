import type { Task } from '../../core/tasks.js';
import type { AgentEvent } from '../../core/types.js';
import type { AgentState } from '../../shared/contracts/agent-state.js';

type GitHubTask = Pick<Task, 'id' | 'status'>;

interface GitHubEventScanner {
  isActive(): boolean;
  processEventsImmediate(tmuxName: string, events: AgentEvent[], taskId: string): Promise<void>;
}

interface GitHubTaskLookup {
  findTaskBySession(tmuxName: string): GitHubTask | null | undefined;
}

export interface GitHubEventProcessorDeps {
  githubScanner: GitHubEventScanner;
  taskLookup: GitHubTaskLookup;
}

export interface GitHubEventProcessor {
  process(input: { tmuxName: string; event: AgentEvent; postState: AgentState | undefined }): void;
}

export function createGitHubEventProcessor({
  githubScanner,
  taskLookup,
}: GitHubEventProcessorDeps): GitHubEventProcessor {
  return {
    process({ tmuxName, event, postState }) {
      // Feed events to GitHub scanner for immediate reference extraction.
      if (!githubScanner.isActive()) return;
      const ghTask = taskLookup.findTaskBySession(tmuxName);
      if (ghTask && ghTask.status === 'inProgress') {
        const ghEvents = postState?.events.slice(-20) ?? [event];
        void githubScanner.processEventsImmediate(tmuxName, ghEvents, ghTask.id);
      }
    },
  };
}
