import type {
  WorkspaceSlice,
  StoreGet,
  StoreSet,
} from '../store-types.js';
import type { CleanupResultSummary } from '../../../core/workspace-types.js';

export function cleanupResultMessage(result: CleanupResultSummary): { summary: string; severity: 'info' | 'error' } {
  const recoverySuffix = result.recoveryRef ? ` Recovery stash: ${result.recoveryRef}.` : '';

  if (result.errorKind === 'prune_failed') {
    return { summary: `Removed worktree ${result.branch} but git prune failed.${recoverySuffix}`.trim(), severity: 'error' };
  }

  if (result.errorKind === 'branch_delete_failed') {
    return { summary: `Removed worktree ${result.branch} but branch deletion failed.${recoverySuffix}`.trim(), severity: 'error' };
  }

  if (result.errorKind === 'manual_intervention_required') {
    return { summary: `Cleanup for ${result.branch} needs manual intervention.${recoverySuffix}`.trim(), severity: 'error' };
  }

  if (result.branchRemoved) {
    return { summary: `Removed worktree and branch ${result.branch}.${recoverySuffix}`.trim(), severity: 'info' };
  }

  switch (result.retainedReason) {
    case 'user_requested_keep_branch':
      return { summary: `Removed worktree ${result.branch} and kept the branch.${recoverySuffix}`.trim(), severity: 'info' };
    case 'ref_changed':
      return { summary: `Removed worktree ${result.branch} but branch was retained (ref changed).${recoverySuffix}`.trim(), severity: 'info' };
    default:
      return { summary: `Removed worktree ${result.branch}.${recoverySuffix}`.trim(), severity: 'info' };
  }
}

export function createWorkspaceSlice(set: StoreSet, get: StoreGet): WorkspaceSlice {
  return {
    workspaceEnabled: false,
    workspaceView: null,
    workspaceLoading: false,
    workspaceError: null,
    workspaceCleanupDetail: null,
    workspaceCleanupDetailLoading: false,
    workspaceCleanupDetailError: null,
    sweepRunning: false,

    handleWorkspaceView: (view, error, cleanupResult, cleanupResults, diagnosticLaunch) => {
      set({
        workspaceView: view,
        workspaceLoading: false,
        workspaceError: error ?? null,
        workspaceCleanupDetail: null,
        workspaceCleanupDetailLoading: false,
        workspaceCleanupDetailError: null,
      });
      if (cleanupResult) {
        const { summary, severity } = cleanupResultMessage(cleanupResult);
        get().handleAlert('workspace', summary, severity);
      }
      for (const result of cleanupResults ?? []) {
        const { summary, severity } = cleanupResultMessage(result);
        get().handleAlert('workspace', summary, severity);
      }
      if (diagnosticLaunch) {
        get().handleAlert(
          'workspace',
          `Launched cleanup diagnostic task ${diagnosticLaunch.taskId}${diagnosticLaunch.queued ? ' (queued)' : ''}`,
          'info',
        );
      }
    },

    handleWorkspaceCleanupDetail: (_worktreePath, detail, error) => {
      set({
        workspaceCleanupDetail: detail ?? null,
        workspaceCleanupDetailLoading: false,
        workspaceCleanupDetailError: error ?? null,
      });
    },

    handleWorkspaceStartWorkAck: (ack) => {
      if (ack.error) {
        set({ workspaceError: ack.error });
      }
    },

    setWorkspaceLoading: (loading) => {
      set({ workspaceLoading: loading });
    },

    setWorkspaceCleanupDetailLoading: (loading) => {
      set({ workspaceCleanupDetailLoading: loading, workspaceCleanupDetailError: loading ? null : get().workspaceCleanupDetailError });
    },

    setWorkspaceError: (error) => {
      set({ workspaceError: error });
    },

    clearWorkspaceCleanupDetail: () => {
      set({
        workspaceCleanupDetail: null,
        workspaceCleanupDetailLoading: false,
        workspaceCleanupDetailError: null,
      });
    },

    clearWorkspaceView: () => {
      set({
        workspaceView: null,
        workspaceError: null,
        workspaceCleanupDetail: null,
        workspaceCleanupDetailLoading: false,
        workspaceCleanupDetailError: null,
      });
    },

    setSweepRunning: (running) => {
      set({ sweepRunning: running });
    },

    handleSweepComplete: (result) => {
      set({ sweepRunning: false });

      const ok = result.projects.filter((p) => p.kind === 'ok');
      const skipped = result.projects.filter((p) => p.kind === 'skipped');
      const failed = result.projects.filter((p) => p.kind === 'failed');

      const removedCount = ok.reduce((acc, p) => {
        if (p.kind !== 'ok') return acc;
        return acc + p.summaries.filter((s) => s.branchRemoved || s.pathRemoved).length;
      }, 0);

      const parts: string[] = [];
      parts.push(`Swept ${result.projects.length} project(s)`);
      if (removedCount > 0) parts.push(`removed ${removedCount} worktree(s)`);
      if (skipped.length > 0) parts.push(`skipped ${skipped.length}`);
      if (failed.length > 0) parts.push(`failed ${failed.length}`);

      const severity: 'info' | 'error' = failed.length > 0 ? 'error' : 'info';
      const reflogHint = removedCount > 0
        ? ' Deleted branches remain recoverable via `git reflog` for ~30 days.'
        : '';
      get().handleAlert('workspace', parts.join(' · ') + '.' + reflogHint, severity);
    },

    handleSweepBusy: (payload) => {
      set({ sweepRunning: false });
      get().handleAlert(
        'workspace',
        `Sweep already running (PID ${payload.holderPid}, since ${payload.heldSince}).`,
        'info',
      );
    },
  };
}
