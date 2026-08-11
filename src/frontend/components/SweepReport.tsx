import { useEffect, useRef, useState } from 'react';
import { useKookrStore } from '../store/useStore.js';
import { useDialogFocus } from '../hooks/useDialogFocus.js';
import { useEscapeToClose } from '../hooks/useEscapeToClose.js';
import type { ClientMessage, SweepReportBucketSummary, SweepReportRow } from '../../shared/protocol.js';
import { ClassificationBadge } from './cleanup-classification-badge.js';
import { formatAge } from './cleanup-row-format.js';

interface Props {
  send: (msg: ClientMessage) => void;
}

type SortMode = 'default' | 'footprint-desc';

/**
 * Kill-switch for the Probably-safe bulk reclaim (RFC PR 3, the RFC's one
 * destructive-adjacent surface). Set to `false` to pull the bulk action — its
 * checkboxes, button, and confirm — without disturbing the read-only report.
 */
const BULK_REMOVE_ENABLED = true;

interface BulkRemoveConfirmDialogProps {
  selectedCount: number;
  sensitiveSelectedCount: number;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * Destructive bulk path-remove confirm. Mounted only while open so
 * Escape-to-close and the focus trap attach for the dialog lifetime only —
 * same pattern as SweepButton's SweepConfirmDialog.
 */
function BulkRemoveConfirmDialog({
  selectedCount,
  sensitiveSelectedCount,
  onCancel,
  onConfirm,
}: BulkRemoveConfirmDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  useEscapeToClose(onCancel);
  useDialogFocus({ dialogRef, initialFocusRef: cancelButtonRef });

  return (
    <div
      ref={dialogRef}
      className="sweep-confirm-backdrop"
      data-testid="sweep-report-bulk-confirm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="sweep-report-bulk-confirm-title"
    >
      <div className="sweep-confirm-dialog">
        <h3 className="sweep-confirm-title" id="sweep-report-bulk-confirm-title">
          Remove {selectedCount} worktree path(s)
        </h3>
        <p>
          Kookr will delete the working directory of each selected worktree and{' '}
          <strong>keep its branch and commits</strong>. Everything in those directories that is
          not committed is deleted — including gitignored files (<code>.env</code>, local
          databases, build output).
        </p>
        {sensitiveSelectedCount > 0 && (
          <p className="sweep-confirm-warning" data-testid="sweep-report-bulk-sensitive-warning">
            ⚠ {sensitiveSelectedCount} selected worktree(s) hold gitignored files that are{' '}
            <strong>not</strong> just regenerable build output. Those files will be permanently
            deleted.
          </p>
        )}
        <p className="sweep-confirm-hint">
          Branches and their commits stay reachable in each repo — only the working directories
          are removed.
        </p>
        <div className="sweep-confirm-actions">
          <button
            ref={cancelButtonRef}
            type="button"
            className="sweep-confirm-cancel"
            data-testid="sweep-report-bulk-cancel"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="sweep-confirm-go"
            data-testid="sweep-report-bulk-confirm-go"
            onClick={onConfirm}
          >
            Remove {selectedCount} path(s)
          </button>
        </div>
      </div>
    </div>
  );
}

function shortProjectLabel(projectId: string): string {
  const parts = projectId.split('/').filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join('/') : projectId;
}

/** Human-readable on-disk footprint. `null` renders as "size unknown" so a
 *  failed/timed-out `du` measurement never reads as "zero bytes". */
function formatFootprint(bytes: number | null): string {
  if (bytes === null) return 'size unknown';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb >= 10 ? 0 : 1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(gb >= 10 ? 0 : 1)} GB`;
}

function formatLastTouched(ms: number | null, now: number): string {
  if (ms === null) return 'unknown';
  return formatAge(new Date(ms).toISOString(), new Date(now)) ?? 'unknown';
}

function combineBucketSummaries(a: SweepReportBucketSummary, b: SweepReportBucketSummary): SweepReportBucketSummary {
  return {
    count: a.count + b.count,
    footprintBytesUpperBound: a.footprintBytesUpperBound + b.footprintBytesUpperBound,
    unknownFootprintCount: a.unknownFootprintCount + b.unknownFootprintCount,
  };
}

function footprintLabel(summary: SweepReportBucketSummary): string {
  const unknownSuffix = summary.unknownFootprintCount > 0
    ? ` (+${summary.unknownFootprintCount} unknown size)`
    : '';
  return `on-disk footprint (upper bound): ${formatFootprint(summary.footprintBytesUpperBound)}${unknownSuffix}`;
}

function sortRows(rows: SweepReportRow[], sortMode: SortMode): SweepReportRow[] {
  if (sortMode !== 'footprint-desc') return rows;
  return [...rows].sort((a, b) => {
    if (a.footprintBytes === null && b.footprintBytes === null) return 0;
    if (a.footprintBytes === null) return 1;
    if (b.footprintBytes === null) return -1;
    return b.footprintBytes - a.footprintBytes;
  });
}

/**
 * Disk-aware Sweep Report panel (RFC sweep-worktree-ux PR 2).
 *
 * Read-only presentation of the last completed sweep's `SweepReport`: a
 * non-modal, re-openable surface bucketing every visited worktree into
 * Removed / Probably-safe / Needs-your-call / Blocked, plus a loud banner
 * for projects that could not be analyzed. No bulk actions or checkboxes —
 * those are PR 3. The one interactive affordance here is a per-row
 * "Run diagnostic" button for Needs-your-call rows.
 */
export function SweepReport({ send }: Props) {
  const sweepReport = useKookrStore((s) => s.sweepReport);
  const sweepReportOpen = useKookrStore((s) => s.sweepReportOpen);
  const lastSweepRunId = useKookrStore((s) => s.lastSweepRunId);
  const workspaceCleanupDetail = useKookrStore((s) => s.workspaceCleanupDetail);
  const openSweepReport = useKookrStore((s) => s.openSweepReport);
  const closeSweepReport = useKookrStore((s) => s.closeSweepReport);
  const bulkRemoveRunning = useKookrStore((s) => s.bulkRemoveRunning);
  const startBulkRemove = useKookrStore((s) => s.startBulkRemove);

  const [sortMode, setSortMode] = useState<SortMode>('default');
  const [pending, setPending] = useState<{ projectId: string; worktreePath: string } | null>(null);
  const [dismissedRunId, setDismissedRunId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmingBulk, setConfirmingBulk] = useState(false);
  const lastInitRunId = useRef<string | null>(null);

  // Pre-select Probably-safe rows once per report. Rows carrying sensitive
  // gitignored files are intentionally NOT pre-selected (RFC PR 3). Guarded by
  // a runId ref so the selection is not reset when rows drop out live during a
  // bulk run.
  useEffect(() => {
    if (!sweepReport) {
      lastInitRunId.current = null;
      setSelected(new Set());
      return;
    }
    if (lastInitRunId.current === sweepReport.runId) return;
    lastInitRunId.current = sweepReport.runId;
    setSelected(new Set(
      sweepReport.rows
        .filter((r) => r.bucket === 'probably_safe' && !r.hasSensitiveIgnored)
        .map((r) => r.worktreePath),
    ));
  }, [sweepReport]);

  // Two-step diagnostic: request a fresh detail (with fingerprint) first,
  // then fire the diagnostic once that detail lands for the pending row.
  useEffect(() => {
    if (!pending || !workspaceCleanupDetail) return;
    if (workspaceCleanupDetail.worktreePath !== pending.worktreePath) return;
    if (!workspaceCleanupDetail.fingerprint) return;
    send({
      type: 'workspace:runCleanupDiagnostic',
      projectId: pending.projectId,
      worktreePath: pending.worktreePath,
      reviewFingerprint: workspaceCleanupDetail.fingerprint,
    });
    setPending(null);
  }, [pending, workspaceCleanupDetail, send]);

  if (!sweepReportOpen) {
    // Closed but the report is still in memory → re-open instantly for the
    // run's lifetime, no server round-trip.
    if (sweepReport) {
      return (
        <div className="sweep-report-reopen" data-testid="sweep-report-reopen">
          <button
            type="button"
            className="sweep-report-reopen-btn"
            data-testid="sweep-report-view"
            onClick={openSweepReport}
          >
            View sweep report
          </button>
        </div>
      );
    }
    // No live report, but the server remembers the last run → offer to
    // reconstruct its Removed manifest from the durable ledger.
    if (!lastSweepRunId || dismissedRunId === lastSweepRunId) return null;
    return (
      <div className="sweep-report-reopen" data-testid="sweep-report-reopen">
        <button
          type="button"
          className="sweep-report-reopen-btn"
          data-testid="sweep-report-view-last"
          onClick={() => send({ type: 'workspace:requestSweepReport', runId: lastSweepRunId })}
        >
          View last sweep report
        </button>
        <button
          type="button"
          className="sweep-report-reopen-dismiss"
          aria-label="Dismiss last sweep report affordance"
          data-testid="sweep-report-reopen-dismiss"
          onClick={() => setDismissedRunId(lastSweepRunId)}
        >
          ×
        </button>
      </div>
    );
  }

  if (!sweepReport) return null;

  const now = Date.now();
  const report = sweepReport;

  function handleRunDiagnostic(row: SweepReportRow) {
    setPending({ projectId: row.projectId, worktreePath: row.worktreePath });
    send({ type: 'workspace:getCleanupDetail', projectId: row.projectId, worktreePath: row.worktreePath });
  }

  function toggleSelected(worktreePath: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(worktreePath)) next.delete(worktreePath);
      else next.add(worktreePath);
      return next;
    });
  }

  // Selected rows resolved against the CURRENT report so paths already removed
  // this run never leak into the next bulk send.
  const selectedProbablySafe = report.rows.filter(
    (r) => r.bucket === 'probably_safe' && selected.has(r.worktreePath),
  );
  const selectedCount = selectedProbablySafe.length;
  const sensitiveSelectedCount = selectedProbablySafe.filter((r) => r.hasSensitiveIgnored).length;

  function triggerBulkRemove() {
    const rows = selectedProbablySafe.map((r) => ({
      projectId: r.projectId,
      worktreePath: r.worktreePath,
      branch: r.branch,
      fingerprint: r.fingerprint,
    }));
    setConfirmingBulk(false);
    if (rows.length === 0) return;
    startBulkRemove();
    send({ type: 'workspace:bulkRemoveProbablySafe', rows });
  }

  function renderRow(row: SweepReportRow, showDiagnostic: boolean, selectable = false) {
    const isRemovalFailed = row.bucket === 'removal_failed';
    const isPending = pending?.worktreePath === row.worktreePath;
    const showCheckbox = selectable && BULK_REMOVE_ENABLED;
    return (
      <li key={`${row.projectId}:${row.worktreePath}`} className="sweep-report-row" data-testid="sweep-report-row">
        <div className="sweep-report-row-main">
          {showCheckbox && (
            <input
              type="checkbox"
              className="sweep-report-row-select"
              data-testid="sweep-report-row-select"
              checked={selected.has(row.worktreePath)}
              disabled={bulkRemoveRunning}
              onChange={() => toggleSelected(row.worktreePath)}
              aria-label={`Select ${row.branch} for bulk path removal`}
            />
          )}
          <span className="sweep-report-row-project">{shortProjectLabel(row.projectId)}</span>
          <span className="sweep-report-row-branch">{row.branch}</span>
          <ClassificationBadge classification={row.classification} />
          {isRemovalFailed && (
            <span className="sweep-report-removal-failed-tag">removal failed — still on disk</span>
          )}
        </div>
        <div className="sweep-report-row-meta">
          <span>{formatFootprint(row.footprintBytes)}</span>
          <span>{formatLastTouched(row.lastTouchedMs, now)}</span>
          <span className="sweep-report-row-reason">{row.reason}</span>
        </div>
        {row.hasSensitiveIgnored && (
          <div className="sweep-report-sensitive-warning">
            ⚠ holds gitignored files ({(row.ignoredSample ?? []).join(', ')}) — not just regenerable build output
          </div>
        )}
        {showDiagnostic && (
          <button
            type="button"
            className="sweep-report-diagnostic-btn"
            data-testid="sweep-report-run-diagnostic"
            disabled={isPending}
            onClick={() => handleRunDiagnostic(row)}
          >
            {isPending ? 'Running…' : 'Run diagnostic'}
          </button>
        )}
      </li>
    );
  }

  const removedRows = sortRows(
    sweepReport.rows.filter((r) => r.bucket === 'removed' || r.bucket === 'removal_failed'),
    sortMode,
  );
  const probablySafeRows = sortRows(sweepReport.rows.filter((r) => r.bucket === 'probably_safe'), sortMode);
  const needsCallRows = sortRows(sweepReport.rows.filter((r) => r.bucket === 'needs_call'), sortMode);

  const removedSummary = combineBucketSummaries(sweepReport.buckets.removed, sweepReport.buckets.removal_failed);
  const probablySafeSummary = sweepReport.buckets.probably_safe;
  const needsCallSummary = sweepReport.buckets.needs_call;
  const blockedSummary = sweepReport.buckets.blocked;

  return (
    <section className="sweep-report-panel" aria-labelledby="sweep-report-title" data-testid="sweep-report-panel">
      <header className="sweep-report-header">
        <div>
          <h2 id="sweep-report-title" className="sweep-report-title">Sweep Report</h2>
          {sweepReport.reconstructedFromLedger && (
            <div className="sweep-report-reconstructed-note">reconstructed from ledger — removed items only</div>
          )}
        </div>
        <div className="sweep-report-header-actions">
          <button
            type="button"
            className="sweep-report-sort-toggle"
            data-testid="sweep-report-sort-toggle"
            onClick={() => setSortMode((mode) => (mode === 'footprint-desc' ? 'default' : 'footprint-desc'))}
          >
            {sortMode === 'footprint-desc' ? 'Sorted by footprint ↓' : 'Sort by footprint'}
          </button>
          <button
            type="button"
            className="sweep-report-close-btn"
            aria-label="Close sweep report"
            data-testid="sweep-report-close"
            onClick={closeSweepReport}
          >
            ×
          </button>
        </div>
      </header>

      {sweepReport.notAnalyzed.length > 0 && (
        <div className="sweep-report-not-analyzed" role="alert" data-testid="sweep-report-not-analyzed">
          {sweepReport.notAnalyzed.map((entry) => (
            <div key={entry.projectId} className="sweep-report-not-analyzed-row">
              ⚠ {shortProjectLabel(entry.projectId)} not analyzed — {entry.notAnalyzedCount} worktree(s) ({entry.code})
            </div>
          ))}
        </div>
      )}

      <div className="sweep-report-section">
        <div className="sweep-report-section-header">
          <span>Removed ({removedSummary.count})</span>
          <span className="sweep-report-footprint-label">{footprintLabel(removedSummary)}</span>
        </div>
        <ul className="sweep-report-row-list">
          {removedRows.map((row) => renderRow(row, false))}
        </ul>
      </div>

      <div className="sweep-report-section">
        <div className="sweep-report-section-header">
          <span>Probably safe to remove ({probablySafeSummary.count})</span>
          <span className="sweep-report-footprint-label">{footprintLabel(probablySafeSummary)}</span>
        </div>
        <ul className="sweep-report-row-list">
          {probablySafeRows.map((row) => renderRow(row, false, true))}
        </ul>
        {BULK_REMOVE_ENABLED && probablySafeRows.length > 0 && (
          <div className="sweep-report-bulk-actions" data-testid="sweep-report-bulk-actions">
            <button
              type="button"
              className="sweep-report-bulk-btn"
              data-testid="sweep-report-bulk-remove"
              disabled={selectedCount === 0 || bulkRemoveRunning}
              onClick={() => setConfirmingBulk(true)}
            >
              {bulkRemoveRunning
                ? 'Removing…'
                : `Remove ${selectedCount} path(s), keep branch(es)`}
            </button>
          </div>
        )}
      </div>

      <div className="sweep-report-section">
        <div className="sweep-report-section-header">
          <span>Needs your call ({needsCallSummary.count})</span>
          <span className="sweep-report-footprint-label">{footprintLabel(needsCallSummary)}</span>
        </div>
        <ul className="sweep-report-row-list">
          {needsCallRows.map((row) => renderRow(row, true))}
        </ul>
      </div>

      <div className="sweep-report-section sweep-report-section-blocked">
        <div className="sweep-report-section-header" data-testid="sweep-report-blocked-summary">
          {blockedSummary.count} blocked (busy / protected / checked out elsewhere / unknown)
        </div>
      </div>

      {confirmingBulk && (
        <BulkRemoveConfirmDialog
          selectedCount={selectedCount}
          sensitiveSelectedCount={sensitiveSelectedCount}
          onCancel={() => setConfirmingBulk(false)}
          onConfirm={triggerBulkRemove}
        />
      )}
    </section>
  );
}
