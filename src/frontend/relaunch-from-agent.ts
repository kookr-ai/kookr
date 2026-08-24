import type { AgentState } from '../shared/protocol.js';
import { getTask } from './api/tasks.js';
import type { RelaunchTask } from './store/store-types.js';

/**
 * Prefill Launch from a finished (or still-selected) agent using the same
 * path as the detail-panel Relaunch button.
 *
 * Snapshot rows do not carry prompt/criteria bodies, so a task is re-fetched
 * by id. Persisted launch pins are copied into the dialog as well, so a
 * manual relaunch preserves the original harness selection.
 */
export async function relaunchFromAgent(
  agent: Pick<
    AgentState,
    'taskId' | 'cwd' | 'agentType' | 'description' | 'playbookId' | 'playbookParameterValues' | 'effort' | 'model'
  >,
  setRelaunchTask: (task: RelaunchTask) => void,
): Promise<void> {
  const reuseSnapshotPlaybook = () => {
    if (!agent.playbookId || !agent.playbookParameterValues) return;
    setRelaunchTask({
      prompt: agent.description ?? '',
      cwd: agent.cwd ?? '',
      agentType: agent.agentType,
      ...(agent.effort !== undefined ? { effort: agent.effort } : {}),
      ...(agent.model !== undefined ? { model: agent.model } : {}),
      playbookId: agent.playbookId,
      playbookParameterValues: agent.playbookParameterValues,
    });
  };

  if (!agent.taskId) {
    reuseSnapshotPlaybook();
    return;
  }

  try {
    const task = await getTask<RelaunchTask & { error?: unknown }>(agent.taskId);
    if (task && !task.error && typeof task.prompt === 'string' && typeof task.cwd === 'string') {
      const launchPins = (task as RelaunchTask & {
        metadata?: { launchPins?: { state?: string; effort?: string; model?: string } };
      }).metadata?.launchPins;
      const knownLaunchPins = launchPins?.state === 'known-pinned' ? launchPins : undefined;
      setRelaunchTask({
        prompt: task.prompt,
        cwd: task.cwd,
        criteria: task.criteria,
        agentType: task.agentType,
        effort: knownLaunchPins?.effort,
        model: knownLaunchPins?.model,
        playbookId: task.playbookId ?? agent.playbookId,
        playbookParameterValues:
          task.playbookParameterValues ?? agent.playbookParameterValues,
      });
    } else {
      reuseSnapshotPlaybook();
    }
  } catch {
    // Preserve the previous playbook fallback if hydration is unavailable;
    // regular tasks still stay closed rather than opening an empty form.
    reuseSnapshotPlaybook();
  }
}
