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
    'taskId' | 'cwd' | 'agentType' | 'description' | 'playbookId' | 'playbookParameterValues'
  >,
  setRelaunchTask: (task: RelaunchTask) => void,
): Promise<void> {
  if (agent.playbookId && agent.playbookParameterValues) {
    setRelaunchTask({
      prompt: agent.description ?? '',
      cwd: agent.cwd ?? '',
      agentType: agent.agentType,
      playbookId: agent.playbookId,
      playbookParameterValues: agent.playbookParameterValues,
    });
    return;
  }

  if (!agent.taskId) return;
  try {
    const task = await getTask<RelaunchTask & { error?: unknown }>(agent.taskId);
    if (task && !task.error) {
      setRelaunchTask({
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
