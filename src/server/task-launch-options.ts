import type { Task } from '../core/task-read-model.js';
import type { AdapterLaunchOptions } from '../adapters/agent-adapter.js';
import { isValidLaunchPin } from '../shared/contracts/agent-types.js';

/** Build adapter options from the task's durable launch intent. */
export function adapterOptionsForTask(
  task: Task,
  transient: Pick<AdapterLaunchOptions, 'tmuxName' | 'extraEnv' | 'bypassPermissions'> = {},
): AdapterLaunchOptions {
  // Tasks created before launchPins existed are necessarily unpinned; treat
  // absent metadata as known-unpinned for safe automatic recovery.
  const pins = task.metadata?.launchPins;
  if (pins && (pins.version !== 1
    || !['known-pinned', 'known-unpinned', 'unknown', 'malformed'].includes(pins.state))) {
    throw new Error(`Task ${task.id} has unsupported launch pin metadata`);
  }
  if (pins?.state === 'malformed') {
    throw new Error(`Task ${task.id} has malformed launch pins`);
  }
  if (pins?.state === 'unknown') {
    throw new Error(`Task ${task.id} has unknown legacy launch pins; manual confirmation required`);
  }
  if (pins?.state === 'known-pinned') {
    if (pins.effort === undefined && pins.model === undefined) {
      throw new Error(`Task ${task.id} has empty known-pinned launch metadata`);
    }
    if ((pins.effort !== undefined && !isValidLaunchPin(pins.effort))
      || (pins.model !== undefined && !isValidLaunchPin(pins.model))) {
      throw new Error(`Task ${task.id} has invalid persisted launch pins`);
    }
  }
  if (pins?.state === 'known-unpinned' && (pins.effort !== undefined || pins.model !== undefined)) {
    throw new Error(`Task ${task.id} has contradictory unpinned launch metadata`);
  }
  return {
    ...transient,
    ...(pins?.state === 'known-pinned' && pins.effort !== undefined ? { effort: pins.effort } : {}),
    ...(pins?.state === 'known-pinned' && pins.model !== undefined ? { model: pins.model } : {}),
  };
}
