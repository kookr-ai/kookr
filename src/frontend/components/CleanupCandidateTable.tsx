import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  CleanupCandidateAssessment,
  CleanupCandidateDetail,
  WorkspaceAttemptRecord,
  WorktreeLease,
} from '../../shared/protocol.js';
import { formatCleanupSubtext } from './cleanup-row-format.js';

interface CleanupRequestOptions {
  deleteBranch: boolean;
  riskAccepted?: boolean;
  discardDirtyState?: boolean;
  reviewFingerprint?: string;
}

interface Props {
  candidates: CleanupCandidateAssessment[];
  recentAttempts: WorkspaceAttemptRecord[];
  activeLeases: WorktreeLease[];
  repoPath?: string;
  projectId: string;
  cleanupDetail: CleanupCandidateDetail | null;
  cleanupDetailLoading: boolean;
  cleanupDetailError: string | null;
  onRequestDetail: (candidate: CleanupCandidateAssessment) => void;
  onCleanup: (candidate: CleanupCandidateAssessment, options: CleanupRequestOptions) => void;
  onBulkSafeCleanup: () => void;
  onRunDiagnostic: (candidate: CleanupCandidateAssessment, reviewFingerprint: string) => void;
  onClearDetail: () => void;
  onRefresh: () => void;
  loading: boolean;
}

const CLASSIFICATION_LABELS: Record<string, { label: string; color: string }> = {
  merged: { label: 'Merged', color: 'var(--color-success, #4caf50)' },
  patch_equivalent: { label: 'Patch eq.', color: 'var(--color-info, #2196f3)' },
  unique_commits: { label: 'Unique', color: 'var(--color-warning, #ff9800)' },
  dirty: { label: 'Dirty', color: 'var(--color-error, #f44336)' },
  checked_out_elsewhere: { label: 'Elsewhere', color: 'var(--color-warning, #ff9800)' },
  busy: { label: 'Busy', color: 'var(--color-info, #2196f3)' },
  protected: { label: 'Protected', color: 'var(--color-warning, #ff9800)' },
  unknown: { label: 'Unknown', color: 'var(--color-muted, #9e9e9e)' },
};

const FILTER_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'merged', label: 'Merged' },
  { value: 'patch_equivalent', label: 'Patch eq.' },
  { value: 'unique_commits', label: 'Unique' },
  { value: 'dirty', label: 'Dirty' },
  { value: 'busy', label: 'Busy' },
  { value: 'protected', label: 'Protected' },
  { value: 'unknown', label: 'Unknown' },
];

function ClassificationBadge({ classification }: { classification: string }) {
  const info = CLASSIFICATION_LABELS[classification] ?? { label: classification, color: '#9e9e9e' };
  return (
    <span
      className="cleanup-classification-badge"
      style={{ borderColor: info.color, color: info.color }}
    >
      {info.label}
    </span>
  );
}

/** Render a lease row for the "Held by" block. Marks stale heartbeats
 *  (older than 120 s — matching the lease service's own default).  */
function HeldByDetail({ lease }: { lease: WorktreeLease }) {
  const now = Date.now();
  const heartbeatAgeMs = now - new Date(lease.lastHeartbeatAt).getTime();
  const acquiredAgeMs = now - new Date(lease.acquiredAt).getTime();
  const STALE_THRESHOLD_MS = 120_000;
  const isStale = heartbeatAgeMs > STALE_THRESHOLD_MS;
  return (
    <>
      <p>
        Held by <code>{lease.ownerId}</code>
        {' · acquired '}<span>{formatRelativeShort(acquiredAgeMs)}</span>
        {' · last heartbeat '}<span>{formatRelativeShort(heartbeatAgeMs)}</span>
        {isStale && <> <em>(stale)</em></>}
      </p>
    </>
  );
}

function formatRelativeShort(diffMs: number): string {
  if (diffMs < 0) return 'just now';
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;
  if (diffMs < MINUTE) return `${Math.max(1, Math.round(diffMs / 1000))}s ago`;
  if (diffMs < HOUR) return `${Math.floor(diffMs / MINUTE)}m ago`;
  if (diffMs < DAY) return `${Math.floor(diffMs / HOUR)}h ago`;
  return `${Math.floor(diffMs / DAY)}d ago`;
}

export function CleanupCandidateTable({
  candidates,
  recentAttempts,
  activeLeases,
  repoPath,
  projectId,
  cleanupDetail,
  cleanupDetailLoading,
  cleanupDetailError,
  onRequestDetail,
  onCleanup,
  onBulkSafeCleanup,
  onRunDiagnostic,
  onClearDetail,
  onRefresh,
  loading,
}: Props) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [classFilter, setClassFilter] = useState<string>('all');
  const [reviewCandidate, setReviewCandidate] = useState<CleanupCandidateAssessment | null>(null);
  const [confirmBulkSafeCleanup, setConfirmBulkSafeCleanup] = useState(false);
  const [riskAccepted, setRiskAccepted] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(
    () => classFilter === 'all' ? candidates : candidates.filter((c) => c.classification === classFilter),
    [candidates, classFilter],
  );

  const classCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const candidate of candidates) {
      counts[candidate.classification] = (counts[candidate.classification] || 0) + 1;
    }
    return counts;
  }, [candidates]);

  useEffect(() => {
    if (filtered.length === 0) {
      setSelectedPath(null);
      return;
    }
    if (!selectedPath || !filtered.some((candidate) => candidate.worktreePath === selectedPath)) {
      setSelectedPath(filtered[0].worktreePath ?? null);
    }
  }, [filtered, selectedPath]);

  const selectedCandidate = useMemo(
    () => filtered.find((candidate) => candidate.worktreePath === selectedPath) ?? filtered[0],
    [filtered, selectedPath],
  );

  const selectedAttempts = useMemo(
    () => recentAttempts.filter((attempt) => attempt.worktreePath === selectedCandidate?.worktreePath),
    [recentAttempts, selectedCandidate],
  );

  const selectedLease = useMemo(
    () => activeLeases.find((lease) => lease.worktreePath === selectedCandidate?.worktreePath),
    [activeLeases, selectedCandidate],
  );

  const reviewDetail = reviewCandidate?.worktreePath === cleanupDetail?.worktreePath ? cleanupDetail : null;
  const safeCandidateCount = useMemo(
    () => candidates.filter((candidate) => candidate.capabilities.canSafeRemove).length,
    [candidates],
  );

  const handleListKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (filtered.length === 0) return;
    const currentIndex = filtered.findIndex((candidate) => candidate.worktreePath === selectedPath);
    if (currentIndex === -1) return;

    let nextIndex = currentIndex;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      nextIndex = Math.min(currentIndex + 1, filtered.length - 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      nextIndex = Math.max(currentIndex - 1, 0);
    } else if (e.key === 'Home') {
      e.preventDefault();
      nextIndex = 0;
    } else if (e.key === 'End') {
      e.preventDefault();
      nextIndex = filtered.length - 1;
    } else {
      return;
    }

    if (nextIndex !== currentIndex) {
      setSelectedPath(filtered[nextIndex].worktreePath ?? null);
      const items = listRef.current?.querySelectorAll<HTMLElement>('[data-cleanup-row]');
      items?.[nextIndex]?.focus();
    }
  }, [filtered, selectedPath]);

  const openReview = useCallback((candidate: CleanupCandidateAssessment) => {
    setReviewCandidate(candidate);
    setRiskAccepted(false);
    onRequestDetail(candidate);
  }, [onRequestDetail]);

  const closeReview = useCallback(() => {
    setReviewCandidate(null);
    setRiskAccepted(false);
    onClearDetail();
  }, [onClearDetail]);

  const submitCleanup = useCallback((candidate: CleanupCandidateAssessment, options: CleanupRequestOptions) => {
    onCleanup(candidate, options);
    closeReview();
  }, [closeReview, onCleanup]);

  if (candidates.length === 0 && !loading) {
    return (
      <div className="cleanup-empty">
        <p>No worktree candidates found.</p>
        <button onClick={onRefresh} disabled={loading} aria-label="Refresh candidate list">Refresh</button>
      </div>
    );
  }

  return (
    <div className="cleanup-split-container">
      <div className="cleanup-list-panel">
        <div className="cleanup-list-header">
          <span className="cleanup-count">{filtered.length} of {candidates.length}</span>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            {safeCandidateCount > 0 && (
              <button
                onClick={() => setConfirmBulkSafeCleanup(true)}
                disabled={loading}
                className="cleanup-refresh-btn"
                aria-label={`Remove all ${safeCandidateCount} safe cleanup candidates`}
              >
                Remove all safe ({safeCandidateCount})
              </button>
            )}
            <button
              onClick={onRefresh}
              disabled={loading}
              className="cleanup-refresh-btn"
              aria-label="Refresh candidate list"
              aria-busy={loading}
            >
              {loading ? '...' : 'Refresh'}
            </button>
          </div>
        </div>

        <div className="cleanup-filter-bar" role="group" aria-label="Filter by classification">
          {FILTER_OPTIONS.filter((opt) => opt.value === 'all' || classCounts[opt.value]).map((opt) => (
            <button
              key={opt.value}
              className={`cleanup-filter-pill ${classFilter === opt.value ? 'active' : ''}`}
              onClick={() => setClassFilter(opt.value)}
              aria-pressed={classFilter === opt.value}
            >
              {opt.label}
              {opt.value !== 'all' && classCounts[opt.value] ? ` ${classCounts[opt.value]}` : ''}
            </button>
          ))}
        </div>

        <div className="cleanup-list-scroll" ref={listRef} onKeyDown={handleListKeyDown} role="listbox" aria-label="Cleanup candidates">
          {filtered.map((candidate, index) => {
            const isSelected = selectedCandidate?.worktreePath === candidate.worktreePath;
            const subtext = formatCleanupSubtext(candidate);
            return (
              <div
                key={candidate.worktreePath ?? index}
                data-cleanup-row
                className={`cleanup-list-item ${isSelected ? 'selected' : ''}`}
                tabIndex={0}
                role="option"
                aria-selected={isSelected}
                onClick={() => setSelectedPath(candidate.worktreePath ?? null)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setSelectedPath(candidate.worktreePath ?? null);
                  }
                }}
              >
                <div className="cleanup-list-row-top">
                  <span className="cleanup-list-branch" title={candidate.branch}>{candidate.branch}</span>
                  <ClassificationBadge classification={candidate.classification} />
                </div>
                {subtext && (
                  <span
                    className={`cleanup-list-subtext${subtext.failed ? ' cleanup-list-subtext--failed' : ''}`}
                    data-cleanup-subtext
                    title={subtext.text}
                  >
                    {subtext.text}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="cleanup-detail-panel">
        {selectedCandidate ? (
          <div className="cleanup-detail-card" aria-label={`Details for ${selectedCandidate.branch}`}>
            <div className="cleanup-detail-header">
              <div>
                <h3>{selectedCandidate.branch}</h3>
                <p>{selectedCandidate.capabilities.riskSummary}</p>
              </div>
              <ClassificationBadge classification={selectedCandidate.classification} />
            </div>

            <dl className="cleanup-detail-grid">
              <div>
                <dt>Project</dt>
                <dd>{projectId}</dd>
              </div>
              <div>
                <dt>Repository root</dt>
                <dd>{repoPath ?? 'Resolved on server'}</dd>
              </div>
              <div>
                <dt>Worktree path</dt>
                <dd>{selectedCandidate.worktreePath ?? 'Unavailable'}</dd>
              </div>
              <div>
                <dt>Reason code</dt>
                <dd>{selectedCandidate.reasonCode}</dd>
              </div>
              {selectedCandidate.commitSummary && (
                <div>
                  <dt>Ahead / behind{selectedCandidate.baselineRef ? ` vs ${selectedCandidate.baselineRef}` : ''}</dt>
                  <dd>
                    <code>+{selectedCandidate.commitSummary.aheadCount}</code>
                    {' / '}
                    <code>−{selectedCandidate.commitSummary.behindCount}</code>
                  </dd>
                </div>
              )}
              {selectedCandidate.commitSummary?.lastCommitSubject && (
                <div>
                  <dt>Last commit</dt>
                  <dd>{selectedCandidate.commitSummary.lastCommitSubject}</dd>
                </div>
              )}
            </dl>

            {(selectedCandidate.classification === 'busy' || selectedCandidate.classification === 'checked_out_elsewhere') && (
              <div className="cleanup-context-block">
                <h4>Held by</h4>
                {selectedLease ? (
                  <HeldByDetail lease={selectedLease} />
                ) : (
                  <p><em>Lease released since inspection.</em></p>
                )}
              </div>
            )}
            {selectedLease && selectedCandidate.classification !== 'busy' && selectedCandidate.classification !== 'checked_out_elsewhere' && (
              <div className="cleanup-context-block">
                <h4>Active lease</h4>
                <p>Owner: <code>{selectedLease.ownerId}</code></p>
                <p>Last heartbeat: <code>{selectedLease.lastHeartbeatAt}</code></p>
              </div>
            )}

            <div className="cleanup-context-block">
              <h4>Policy</h4>
              <p>{selectedCandidate.capabilities.riskSummary}</p>
              {selectedCandidate.capabilities.blockedReason && (
                <p className="cleanup-disabled-reason">{selectedCandidate.capabilities.blockedReason}</p>
              )}
            </div>

            <div className="cleanup-context-block">
              <h4>Recent attempts</h4>
              {selectedAttempts.length === 0 ? (
                <p>No recent attempts for this worktree.</p>
              ) : (
                <ul className="cleanup-attempt-list">
                  {selectedAttempts.map((attempt) => (
                    <li key={attempt.attemptId}>
                      <strong>{attempt.type}</strong> {attempt.status} / {attempt.disposition}
                      <span>{attempt.evidenceSummary}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="cleanup-detail-actions">
              {(selectedCandidate.capabilities.canSafeRemove
                || selectedCandidate.capabilities.canRemovePathKeepBranch
                || selectedCandidate.classification === 'dirty') && (
                <button
                  type="button"
                  className="cleanup-run-btn"
                  disabled={loading || !selectedCandidate.worktreePath}
                  aria-label={`Review cleanup options for ${selectedCandidate.branch}`}
                  onClick={() => openReview(selectedCandidate)}
                >
                  {selectedCandidate.classification === 'dirty' ? 'Review cleanup status' : selectedCandidate.capabilities.defaultActionLabel}
                </button>
              )}
              {!selectedCandidate.capabilities.canSafeRemove
                && !selectedCandidate.capabilities.canRemovePathKeepBranch
                && selectedCandidate.classification !== 'dirty'
                && selectedCandidate.capabilities.blockedReason && (
                  <span className="cleanup-disabled-reason">
                    {selectedCandidate.capabilities.blockedReason}
                  </span>
                )}
            </div>
          </div>
        ) : (
          <div className="cleanup-detail-empty">
            <p>Select a candidate to view details.</p>
          </div>
        )}
      </div>

      {reviewCandidate && (
        <div className="dialog-overlay" onClick={closeReview}>
          <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="confirm-dialog-title">Review cleanup for {reviewCandidate.branch}</div>
            <div className="confirm-dialog-message">
              {cleanupDetailLoading && <p>Loading cleanup evidence...</p>}
              {!cleanupDetailLoading && cleanupDetailError && <p>{cleanupDetailError}</p>}
              {!cleanupDetailLoading && reviewDetail && (
                <>
                  <p>{reviewDetail.capabilities.riskSummary}</p>
                  <p>Reason: <code>{reviewDetail.reasonCode}</code></p>
                  <p>Worktree: <code>{reviewDetail.worktreePath}</code></p>
                  {reviewDetail.commitSummary && (
                    <>
                      <p>Ahead/behind: <code>{reviewDetail.commitSummary.aheadCount}</code> ahead, <code>{reviewDetail.commitSummary.behindCount}</code> behind.</p>
                      {reviewDetail.commitSummary.lastCommitSubject && (
                        <p>Last commit: <code>{reviewDetail.commitSummary.lastCommitSubject}</code></p>
                      )}
                    </>
                  )}
                  {reviewDetail.dirtySummary && (
                    <>
                      <p>
                        Dirty files: modified <code>{reviewDetail.dirtySummary.modified}</code>,
                        added <code>{reviewDetail.dirtySummary.added}</code>,
                        deleted <code>{reviewDetail.dirtySummary.deleted}</code>,
                        renamed <code>{reviewDetail.dirtySummary.renamed}</code>,
                        untracked <code>{reviewDetail.dirtySummary.untracked}</code>.
                      </p>
                      {reviewDetail.dirtyFilesSample && reviewDetail.dirtyFilesSample.length > 0 && (
                        <ul className="cleanup-attempt-list">
                          {reviewDetail.dirtyFilesSample.slice(0, 5).map((file) => (
                            <li key={`${file.status}:${file.path}`}>
                              <strong>{file.status}</strong> <span>{file.path}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </>
                  )}
                  {reviewDetail.classification === 'dirty' && (
                    <>
                      <p>Dirty cleanup creates a recovery stash before removing the worktree path.</p>
                      <p>That recovery stash includes tracked, untracked, and ignored files.</p>
                    </>
                  )}
                  {reviewDetail.capabilities.canSafeRemove && (
                    <p>Branch deletion is skipped automatically if the branch ref changed after review.</p>
                  )}
                  {(reviewDetail.classification === 'unique_commits'
                    || (reviewDetail.classification === 'dirty' && (reviewDetail.commitSummary?.aheadCount ?? 0) > 0))
                    && reviewDetail.capabilities.canReviewedDiscard && (
                    <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginTop: '0.75rem' }}>
                      <input
                        type="checkbox"
                        checked={riskAccepted}
                        onChange={(e) => setRiskAccepted(e.target.checked)}
                      />
                      <span>I understand deleting this branch will discard local-only commits.</span>
                    </label>
                  )}
                </>
              )}
            </div>
            <div className="confirm-dialog-actions">
              <button className="btn-secondary" onClick={closeReview}>Keep worktree</button>
              {reviewDetail && ['dirty', 'unique_commits'].includes(reviewDetail.classification) && (
                <button
                  className="btn-secondary"
                  onClick={() => {
                    onRunDiagnostic(reviewCandidate, reviewDetail.fingerprint);
                    closeReview();
                  }}
                  disabled={loading || cleanupDetailLoading}
                >
                  Run diagnostic
                </button>
              )}
              {reviewDetail?.capabilities.canRemovePathKeepBranch && (
                <button
                  className="btn-secondary"
                  onClick={() => submitCleanup(reviewCandidate, {
                    deleteBranch: false,
                    riskAccepted: false,
                    discardDirtyState: reviewDetail.classification === 'dirty',
                    reviewFingerprint: reviewDetail.fingerprint,
                  })}
                  disabled={loading || cleanupDetailLoading}
                >
                  {reviewDetail.classification === 'dirty' ? 'Create stash and remove path' : 'Keep branch, remove path'}
                </button>
              )}
              {reviewDetail?.capabilities.canSafeRemove && (
                <button
                  className="btn-danger"
                  onClick={() => submitCleanup(reviewCandidate, {
                    deleteBranch: true,
                    reviewFingerprint: reviewDetail.fingerprint,
                  })}
                  disabled={loading || cleanupDetailLoading}
                >
                  Remove path and delete branch
                </button>
              )}
              {reviewDetail?.classification === 'unique_commits' && reviewDetail.capabilities.canReviewedDiscard && (
                <button
                  className="btn-danger"
                  onClick={() => submitCleanup(reviewCandidate, {
                    deleteBranch: true,
                    riskAccepted,
                    reviewFingerprint: reviewDetail.fingerprint,
                  })}
                  disabled={loading || cleanupDetailLoading || !riskAccepted}
                >
                  Remove path and delete branch
                </button>
              )}
              {reviewDetail?.classification === 'dirty' && reviewDetail.capabilities.canReviewedDiscard && (
                <button
                  className="btn-danger"
                  onClick={() => submitCleanup(reviewCandidate, {
                    deleteBranch: true,
                    riskAccepted,
                    discardDirtyState: true,
                    reviewFingerprint: reviewDetail.fingerprint,
                  })}
                  disabled={
                    loading
                    || cleanupDetailLoading
                    || ((reviewDetail.commitSummary?.aheadCount ?? 0) > 0 && !riskAccepted)
                    || reviewDetail.commitSummary?.aheadCount === undefined
                  }
                >
                  Create stash, remove path, and delete branch
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {confirmBulkSafeCleanup && (
        <div className="dialog-overlay" onClick={() => setConfirmBulkSafeCleanup(false)}>
          <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="confirm-dialog-title">Remove all safe worktrees</div>
            <div className="confirm-dialog-message">
              Remove all currently safe worktrees? Only the server-authorized safe set will run, and branch deletion is skipped automatically if a ref changes before execution.
            </div>
            <div className="confirm-dialog-actions">
              <button className="btn-secondary" onClick={() => setConfirmBulkSafeCleanup(false)}>Cancel</button>
              <button
                className="btn-danger"
                onClick={() => {
                  onBulkSafeCleanup();
                  setConfirmBulkSafeCleanup(false);
                }}
                disabled={loading}
              >
                Remove all safe
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
