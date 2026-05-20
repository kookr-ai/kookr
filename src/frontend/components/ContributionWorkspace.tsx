import React, { useCallback, useEffect, useRef } from 'react';
import type { CleanupCandidateAssessment, ClientMessage } from '../../shared/protocol.js';
import { useKookrStore } from '../store/useStore.js';
import { useEscapeToClose } from '../hooks/useEscapeToClose.js';
import { CleanupCandidateTable } from './CleanupCandidateTable.js';

interface Props {
  send: (msg: ClientMessage) => void;
  projectId: string;
  onClose: () => void;
}

export function ContributionWorkspace({ send, projectId, onClose }: Props) {
  const view = useKookrStore((s) => s.workspaceView);
  const loading = useKookrStore((s) => s.workspaceLoading);
  const error = useKookrStore((s) => s.workspaceError);
  const cleanupDetail = useKookrStore((s) => s.workspaceCleanupDetail);
  const cleanupDetailLoading = useKookrStore((s) => s.workspaceCleanupDetailLoading);
  const cleanupDetailError = useKookrStore((s) => s.workspaceCleanupDetailError);
  const setWorkspaceLoading = useKookrStore((s) => s.setWorkspaceLoading);
  const setWorkspaceCleanupDetailLoading = useKookrStore((s) => s.setWorkspaceCleanupDetailLoading);
  const clearWorkspaceCleanupDetail = useKookrStore((s) => s.clearWorkspaceCleanupDetail);
  const panelRef = useRef<HTMLDivElement>(null);

  const refreshView = useCallback(() => {
    setWorkspaceLoading(true);
    send({ type: 'workspace:getView', projectId });
  }, [send, projectId, setWorkspaceLoading]);

  useEffect(() => {
    if (!view || view.projectId !== projectId) {
      refreshView();
    }
  }, [projectId, view, refreshView]);

  useEscapeToClose(onClose);

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Tab') return;
      const focusable = panel!.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    panel.addEventListener('keydown', handleKeyDown);
    const firstFocusable = panel.querySelector<HTMLElement>('button:not([disabled]), [href], input:not([disabled])');
    firstFocusable?.focus();
    return () => {
      panel.removeEventListener('keydown', handleKeyDown);
      previouslyFocused?.focus();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- runs once on mount; focus restore uses captured ref

  const displayName = view?.displayName ?? projectId;
  const policy = view?.policy ?? 'unknown_policy';

  const requestCleanupDetail = useCallback((candidate: CleanupCandidateAssessment) => {
    if (!candidate.worktreePath) return;
    setWorkspaceCleanupDetailLoading(true);
    send({
      type: 'workspace:getCleanupDetail',
      projectId,
      worktreePath: candidate.worktreePath,
    });
  }, [projectId, send, setWorkspaceCleanupDetailLoading]);

  return (
    <div className="workspace-overlay" onClick={(e) => {
      if (e.target === e.currentTarget) onClose();
    }}>
      <div
        className="workspace-panel"
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="workspace-title"
      >
        <div className="workspace-header">
          <h2 id="workspace-title">Workspace Cleanup</h2>
          <span className="workspace-project">{displayName}</span>
          {policy === 'unknown_policy' && (
            <span className="workspace-policy-badge unknown">unknown policy</span>
          )}
          <button className="workspace-close" onClick={onClose} aria-label="Close workspace">
            &times;
          </button>
        </div>

        <div className="workspace-body">
          {loading && <div className="workspace-loading" aria-live="polite">Loading workspace...</div>}
          {error && <div className="workspace-error" role="alert">{error}</div>}

          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <CleanupCandidateTable
              candidates={view?.candidates ?? []}
              recentAttempts={view?.recentAttempts ?? []}
              activeLeases={view?.activeLeases ?? []}
              repoPath={view?.repoPath}
              projectId={projectId}
              cleanupDetail={cleanupDetail}
              cleanupDetailLoading={cleanupDetailLoading}
              cleanupDetailError={cleanupDetailError}
              onRequestDetail={requestCleanupDetail}
              onCleanup={(candidate, options) => {
                if (!candidate.worktreePath) return;
                setWorkspaceLoading(true);
                send({
                  type: 'workspace:cleanupCandidate',
                  projectId,
                  worktreePath: candidate.worktreePath,
                  branch: candidate.branch,
                  deleteBranch: options.deleteBranch,
                  riskAccepted: options.riskAccepted,
                  discardDirtyState: options.discardDirtyState,
                  reviewFingerprint: options.reviewFingerprint,
                });
              }}
              onBulkSafeCleanup={() => {
                setWorkspaceLoading(true);
                send({
                  type: 'workspace:bulkSafeCleanup',
                  projectId,
                });
              }}
              onRunDiagnostic={(candidate, reviewFingerprint) => {
                if (!candidate.worktreePath) return;
                setWorkspaceLoading(true);
                send({
                  type: 'workspace:runCleanupDiagnostic',
                  projectId,
                  worktreePath: candidate.worktreePath,
                  reviewFingerprint,
                });
              }}
              onClearDetail={clearWorkspaceCleanupDetail}
              onRefresh={refreshView}
              loading={loading}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
