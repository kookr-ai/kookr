import type { AgentState } from '../shared/protocol.js';
import { getTask } from './api/tasks.js';
import type { RelaunchTask } from './store/store-types.js';

/**
 * Prefill Launch from a finished (or still-selected) agent using the same
 * path as the detail-panel Relaunch button.
 *
 * Snapshot rows do not carry prompt/criteria bodies, so a regular task is
 * re-fetched by id. Playbook tasks reuse the snapshot's playbook fields so
 * the dialog opens the form already filled.
 */
export async function relaunchFromAgent(
  agent: Pick<
    AgentState,
    'taskId' | 'cwd' | 'agentType' | 'description' | 'playbookId' | 'playbookParameterValues' | 'playbookSource'
  >,
  setRelaunchTask: (task: RelaunchTask) => void,
): Promise<void> {
  if (!agent.taskId) return;

  if (agent.playbookId && agent.playbookParameterValues) {
    setRelaunchTask({
      sourceTaskId: agent.taskId,
      prompt: agent.description ?? '',
      cwd: agent.cwd ?? '',
      agentType: agent.agentType,
      playbookId: agent.playbookId,
      playbookParameterValues: agent.playbookParameterValues,
      // Carry the exact resource identity so relaunch reselects the same
      // playbook file rather than the current same-id precedence winner
      // (issue #2892). Absent on legacy task records launched before identity
      // tracking; those fall back to id-only matching downstream.
      ...(agent.playbookSource ? { playbookSource: agent.playbookSource } : {}),
    });
    return;
  }

  try {
    const task = await getTask<Omit<RelaunchTask, 'sourceTaskId'> & { error?: unknown }>(agent.taskId);
    if (task && !task.error) {
      setRelaunchTask({
        sourceTaskId: agent.taskId,
        prompt: task.prompt,
        cwd: task.cwd,
        criteria: task.criteria,
        agentType: task.agentType,
      });
    }
  } catch {
    // Same as the previous detail-panel handler: a failed fetch must not
    // open an empty Launch form.
  }
}
