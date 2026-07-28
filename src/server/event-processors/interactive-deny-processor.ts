import type { AgentEvent } from '../../shared/contracts/agent-events.js';
import type { Task } from '../../core/task-read-model.js';
import {
  isInteractiveToolName,
  operatorNeededMessage,
  type OperatorNeeded,
} from '../../shared/contracts/operator-needed.js';

/**
 * Interactive-tool denial processor (issue #1562).
 *
 * For an unattended/autonomous task, the spawned agent's settings hard-deny
 * interactive tools (`AskUserQuestion` and equivalents). The PreToolUse hook
 * still fires and forwards the `tool_use` event before Claude Code evaluates
 * the deny rule, so this processor observes the attempted interactive call and
 * flags the owning task operator-needed — turning what used to be an
 * open-ended hang into an operator-visible signal on the tasks API + dashboard.
 *
 * No-op for attended tasks (no deny rule injected, so no flag) and for
 * non-interactive tools. The store's `setOperatorNeeded` is first-write-wins,
 * so repeated denied calls do not churn the task or re-broadcast.
 */
export interface InteractiveDenyProcessorDeps {
  taskStore: {
    findTaskBySession(tmuxSessionName: string): Task | undefined;
    setOperatorNeeded(taskId: string, flag: OperatorNeeded): boolean;
  };
  /** Injectable clock so tests can assert a stable `detectedAt`. */
  now?: () => Date;
  /** Optional log emitted exactly once, when the flag is newly set. */
  log?: (line: string) => void;
}

export interface InteractiveDenyProcessor {
  process(input: { tmuxName: string; event: AgentEvent }): void;
}

export function createInteractiveDenyProcessor(
  deps: InteractiveDenyProcessorDeps,
): InteractiveDenyProcessor {
  const now = deps.now ?? (() => new Date());
  return {
    process({ tmuxName, event }) {
      if (event.type !== 'tool_use') return;
      if (!isInteractiveToolName(event.toolName)) return;

      const task = deps.taskStore.findTaskBySession(tmuxName);
      if (!task || !task.unattended) return;

      const flag: OperatorNeeded = {
        reason: 'interactive_tool_denied',
        toolName: event.toolName,
        detectedAt: now(),
        message: operatorNeededMessage(event.toolName),
      };
      const newlySet = deps.taskStore.setOperatorNeeded(task.id, flag);
      if (newlySet) {
        deps.log?.(
          `[interactive-deny] flagged task ${task.id} operator-needed after denied ${event.toolName}`,
        );
      }
    },
  };
}
