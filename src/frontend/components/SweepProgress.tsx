import { useEffect, useMemo, useState } from 'react';
import { useKookrStore } from '../store/useStore.js';

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds.toString().padStart(2, '0')}s` : `${seconds}s`;
}

function shortProjectLabel(projectId: string): string {
  const parts = projectId.split('/').filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join('/') : projectId;
}

function BulkRemoveProgress() {
  const running = useKookrStore((s) => s.bulkRemoveRunning);
  const progress = useKookrStore((s) => s.bulkRemoveProgress);

  if (!running) return null;

  const total = progress?.total ?? 0;
  const determinate = !!progress && total > 0;
  const percent = determinate ? Math.min(100, Math.max(0, (progress.index / total) * 100)) : 0;
  const label = progress ? shortProjectLabel(progress.projectId) : 'Starting';

  return (
    <section className="sweep-progress" aria-live="polite" data-testid="bulk-remove-progress">
      <div className="sweep-progress-header">
        <div>
          <div className="sweep-progress-title">Reclaiming worktree paths</div>
          <div className="sweep-progress-subtitle">
            {determinate
              ? `Path ${progress.index} of ${total} — ${label} (keeping branches)`
              : 'Preparing bulk removal…'}
          </div>
        </div>
      </div>
      <div
        className={`sweep-progress-bar${determinate ? '' : ' sweep-progress-bar-indeterminate'}`}
        role="progressbar"
        aria-label="Bulk path removal progress"
        aria-valuemin={0}
        aria-valuemax={determinate ? total : undefined}
        aria-valuenow={determinate ? progress.index : undefined}
      >
        <div className="sweep-progress-fill" style={{ width: determinate ? `${percent}%` : undefined }} />
      </div>
      <div className="sweep-progress-counts">
        <span>{progress?.done ?? 0} removed</span>
        <span>{progress?.skipped ?? 0} skipped</span>
      </div>
    </section>
  );
}

export function SweepProgress() {
  const sweepRunning = useKookrStore((s) => s.sweepRunning);
  const progress = useKookrStore((s) => s.sweepProgress);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!sweepRunning) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [sweepRunning]);

  const elapsed = useMemo(() => {
    if (!progress?.startedAt) return null;
    const started = Date.parse(progress.startedAt);
    return Number.isFinite(started) ? formatElapsed(now - started) : null;
  }, [now, progress?.startedAt]);

  // Bulk reclaim (PR 3) can run independently of a sweep, so render its
  // determinate bar even when no sweep is active.
  if (!sweepRunning) return <BulkRemoveProgress />;

  const hasDeterminateProgress = progress && progress.total > 0;
  const percent = hasDeterminateProgress
    ? Math.min(100, Math.max(0, (progress.index / progress.total) * 100))
    : 0;
  const label = progress ? shortProjectLabel(progress.projectId) : 'Waiting for server progress';
  const statusLabel = progress?.status === 'running'
    ? 'Running'
    : progress?.status === 'done'
      ? 'Done'
      : progress?.status === 'failed'
        ? 'Failed'
        : progress?.status === 'skipped'
          ? 'Skipped'
          : 'Starting';

  return (
    <section className="sweep-progress" aria-live="polite" data-testid="sweep-progress">
      <div className="sweep-progress-header">
        <div>
          <div className="sweep-progress-title">Sweeping worktrees</div>
          <div className="sweep-progress-subtitle">
            {hasDeterminateProgress
              ? `Project ${progress.index} of ${progress.total} - ${label}`
              : 'No live cursor yet - re-run if the sweep is not active'}
          </div>
        </div>
        <div className="sweep-progress-meta">
          <span>{statusLabel}</span>
          {elapsed ? <span>{elapsed}</span> : null}
        </div>
      </div>
      <div
        className={`sweep-progress-bar${hasDeterminateProgress ? '' : ' sweep-progress-bar-indeterminate'}`}
        role="progressbar"
        aria-label="Workspace sweep progress"
        aria-valuemin={0}
        aria-valuemax={hasDeterminateProgress ? progress.total : undefined}
        aria-valuenow={hasDeterminateProgress ? progress.index : undefined}
      >
        <div className="sweep-progress-fill" style={{ width: hasDeterminateProgress ? `${percent}%` : undefined }} />
      </div>
      <div className="sweep-progress-counts">
        <span>{progress?.counts.done ?? 0} done</span>
        <span>{progress?.counts.skipped ?? 0} skipped</span>
        <span>{progress?.counts.failed ?? 0} failed</span>
      </div>
      <BulkRemoveProgress />
    </section>
  );
}
