import type { AgentState } from '../shared/protocol.js';
import { isTerminalStatus } from '../shared/contracts/task-status.js';

/**
 * Active (non-terminal) task IDs drawn from a scoped agent list, deduped by
 * task so a multi-session task aborts exactly once, and excluding tasks already
 * queued for a destructive action. Feeds the control-room batch-abort action
 * (issue #1325): one request cancels these and interrupts their live sessions.
 *
 * Kept as a pure function so the selection rules (terminal filter, dedup,
 * pending-destructive exclusion) are unit-testable without rendering the app.
 */
export function computeAbortActiveTaskIds(
  agents: readonly AgentState[],
  pendingDestructiveTaskIds: ReadonlySet<string>,
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const agent of agents) {
    const taskId = agent.taskId;
    if (!taskId || seen.has(taskId) || pendingDestructiveTaskIds.has(taskId)) continue;
    if (agent.taskStatus !== undefined && isTerminalStatus(agent.taskStatus)) continue;
    seen.add(taskId);
    ids.push(taskId);
  }
  return ids;
}
