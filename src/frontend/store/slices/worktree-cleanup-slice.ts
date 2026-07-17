import type {
  WorktreeCleanupSlice,
  StoreSet,
} from '../store-types.js';

/**
 * Verdict state for the task-completion dialog's worktree-cleanup option.
 *
 * Separate from WorkspaceSlice on purpose: that slice serves the Contribution
 * Workspace, which classifies worktrees by its own richer rules. This one
 * mirrors what the completion cleanup will actually do, and the two must not
 * be conflated.
 */
export function createWorktreeCleanupSlice(set: StoreSet): WorktreeCleanupSlice {
  return {
    cleanupVerdictsTaskId: null,
    cleanupVerdicts: null,
    cleanupVerdictsError: null,
    cleanupVerdictsRefreshing: false,

    beginWorktreeCleanupInspect: (taskId, opts) => {
      set({
        cleanupVerdictsTaskId: taskId,
        // A refresh keeps the previous verdicts on screen so the box doesn't
        // collapse to a spinner and shift everything under the cursor.
        ...(opts?.refresh ? {} : { cleanupVerdicts: null }),
        cleanupVerdictsError: null,
        cleanupVerdictsRefreshing: opts?.refresh === true,
      });
    },

    handleWorktreeCleanupVerdicts: (taskId, verdicts, error) => {
      set((s) => {
        // A reply for a task we're no longer asking about is stale — dialog
        // closed, or reopened on a different task while this was in flight.
        if (s.cleanupVerdictsTaskId !== taskId) return {};
        return {
          cleanupVerdicts: verdicts,
          cleanupVerdictsError: error ?? null,
          cleanupVerdictsRefreshing: false,
        };
      });
    },

    clearWorktreeCleanupVerdicts: () => {
      set({
        cleanupVerdictsTaskId: null,
        cleanupVerdicts: null,
        cleanupVerdictsError: null,
        cleanupVerdictsRefreshing: false,
      });
    },
  };
}
