import type {
  WorkspaceSlice,
  StoreGet,
  StoreSet,
} from '../store-types.js';
import type { CleanupResultSummary } from '../../../shared/contracts/workspace.js';

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
    sweepProgress: null,
    sweepReport: null,
    sweepReportOpen: false,
    lastSweepRunId: null,
    bulkRemoveRunning: false,
    bulkRemoveProgress: null,

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
      set({
        sweepRunning: running,
        sweepProgress: null,
      });
    },

    handleSweepProgress: (progress) => {
      set((prev) => {
        const projectStatuses = { ...(prev.sweepProgress?.projectStatuses ?? {}) };
        projectStatuses[progress.projectId] = progress.status;
        const counts = Object.values(projectStatuses).reduce(
          (acc, status) => {
            if (status === 'done') acc.done += 1;
            if (status === 'skipped') acc.skipped += 1;
            if (status === 'failed') acc.failed += 1;
            return acc;
          },
          { done: 0, skipped: 0, failed: 0 },
        );
        return {
          sweepRunning: true,
          sweepProgress: {
            runId: progress.runId,
            startedAt: progress.startedAt,
            index: progress.index,
            total: progress.total,
            projectId: progress.projectId,
            status: progress.status,
            counts: progress.counts ?? counts,
            projectStatuses,
          },
        };
      });
    },

    handleSweepComplete: (result) => {
      // Persist the disk-aware report and auto-open the panel; the toast below
      // stays as the entry point / summary. `report` is optional for old-server
      // compatibility — the toast alone still renders.
      set({
        sweepRunning: false,
        sweepProgress: null,
        ...(result.report
          ? { sweepReport: result.report, sweepReportOpen: true, lastSweepRunId: result.runId }
          : {}),
      });

      const ok = result.projects.filter((p) => p.kind === 'ok');
      const skipped = result.projects.filter((p) => p.kind === 'skipped');
      const failed = result.projects.filter((p) => p.kind === 'failed');
      const unavailable = skipped.find((p) => p.kind === 'skipped' && p.reason === 'workspace_unavailable');

      if (unavailable?.kind === 'skipped') {
        get().handleAlert('workspace', 'Sweep unavailable: workspace cleanup services are not configured.', 'error');
        return;
      }

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
      set({ sweepRunning: false, sweepProgress: null });
      get().handleAlert(
        'workspace',
        `Sweep already running (PID ${payload.holderPid}, since ${payload.heldSince}).`,
        'info',
      );
    },

    handleSweepReport: (payload) => {
      if (!payload.report) {
        get().handleAlert('workspace', 'No sweep report available to reconstruct.', 'info');
        return;
      }
      set({ sweepReport: payload.report, sweepReportOpen: true, lastSweepRunId: payload.runId });
    },

    setLastSweepRunId: (runId) => {
      set({ lastSweepRunId: runId });
    },

    openSweepReport: () => {
      set({ sweepReportOpen: true });
    },

    closeSweepReport: () => {
      set({ sweepReportOpen: false });
    },

    startBulkRemove: () => {
      set({ bulkRemoveRunning: true, bulkRemoveProgress: null });
    },

    handleBulkRemoveProgress: (msg) => {
      // A terminal event for the final row (or a synthetic 0/0 terminal the
      // server emits on an early/error exit) ends the run — one predicate,
      // reused to clear the running flag and to fire the completion alert.
      const finished = msg.status !== 'running' && msg.index >= msg.total;
      set((prev) => {
        const sameRun = prev.bulkRemoveProgress?.runId === msg.runId;
        let done = sameRun ? prev.bulkRemoveProgress!.done : 0;
        let skipped = sameRun ? prev.bulkRemoveProgress!.skipped : 0;
        if (msg.status === 'done') done += 1;
        else if (msg.status === 'skipped' || msg.status === 'failed') skipped += 1;

        // A removed path leaves the Probably-safe bucket live so the list and
        // its footprint headline shrink as the bulk runs.
        let sweepReport = prev.sweepReport;
        if (msg.status === 'done' && sweepReport) {
          const removedRow = sweepReport.rows.find(
            (r) => r.worktreePath === msg.worktreePath && r.bucket === 'probably_safe',
          );
          if (removedRow) {
            const ps = sweepReport.buckets.probably_safe;
            sweepReport = {
              ...sweepReport,
              rows: sweepReport.rows.filter((r) => r !== removedRow),
              buckets: {
                ...sweepReport.buckets,
                probably_safe: {
                  count: Math.max(0, ps.count - 1),
                  footprintBytesUpperBound: removedRow.footprintBytes === null
                    ? ps.footprintBytesUpperBound
                    : Math.max(0, ps.footprintBytesUpperBound - removedRow.footprintBytes),
                  unknownFootprintCount: removedRow.footprintBytes === null
                    ? Math.max(0, ps.unknownFootprintCount - 1)
                    : ps.unknownFootprintCount,
                },
              },
            };
          }
        }

        return {
          sweepReport,
          bulkRemoveRunning: !finished,
          bulkRemoveProgress: {
            runId: msg.runId,
            index: msg.index,
            total: msg.total,
            projectId: msg.projectId,
            worktreePath: msg.worktreePath,
            status: msg.status,
            done,
            skipped,
          },
        };
      });

      if (finished) {
        const progress = get().bulkRemoveProgress;
        const done = progress?.done ?? 0;
        const skipped = progress?.skipped ?? 0;
        const reflogHint = done > 0
          ? ' Branches were kept; removed paths are gone (gitignored files included).'
          : '';
        get().handleAlert(
          'workspace',
          `Bulk reclaim finished · removed ${done} path(s)${skipped > 0 ? ` · skipped ${skipped}` : ''}.${reflogHint}`,
          'info',
        );
      }
    },
  };
}
