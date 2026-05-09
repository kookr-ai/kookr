import type { TaskStatus, WorktreeHealth } from './types.js';

export function isMissingWorktreeHealth(health: WorktreeHealth | undefined): boolean {
  return health === 'missing' || health === 'missing_unexpectedly';
}

export function normalizeTerminalWorktreeHealth(
  taskStatus: TaskStatus,
  health: WorktreeHealth | undefined,
): WorktreeHealth | undefined {
  if (taskStatus === 'completed' && isMissingWorktreeHealth(health)) {
    return 'cleaned_up';
  }
  return health;
}
