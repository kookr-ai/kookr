import React, { useMemo, useState } from 'react';
import { useKookrStore } from '../store/useStore.js';
import type {
  PipelineStarvationRepoStatus,
  PipelineStarvationStatus,
} from '../store/store-types.js';
import { formatDiagnosticIdentifier } from './diagnostics-format.js';

interface Props {
  defaultExpanded?: boolean;
  /** Optional override for tests; defaults to the ops-health store projection. */
  snapshot?: PipelineStarvationStatus | null;
}

/** Elevated drought rows only (`consecutiveBlockedEmpty > 0`), sorted by repo. */
export function elevatedPipelineStarvationRepos(
  repos: Record<string, PipelineStarvationRepoStatus> | undefined | null,
): PipelineStarvationRepoStatus[] {
  if (!repos) return [];
  const rows: PipelineStarvationRepoStatus[] = [];
  for (const key of Object.keys(repos).sort()) {
    const row = repos[key];
    if (!row) continue;
    if (!Number.isFinite(row.consecutiveBlockedEmpty) || row.consecutiveBlockedEmpty <= 0) continue;
    rows.push(row);
  }
  return rows;
}

function formatCooldown(ms: number): string | null {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  if (ms < 60_000) return `${Math.round(ms / 1_000)}s`;
  if (ms < 3_600_000) {
    const minutes = Math.floor(ms / 60_000);
    const seconds = Math.round((ms % 60_000) / 1_000);
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.round((ms % 3_600_000) / 60_000);
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

function formatTimestamp(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function RepoRow({ row }: { row: PipelineStarvationRepoStatus }) {
  const cooldown = formatCooldown(row.effectiveScoutCooldownMs);
  const lastEmpty = formatTimestamp(row.lastBlockedEmptyAt);
  const lastSkip = row.lastSpawnSkipReason
    ? formatDiagnosticIdentifier(row.lastSpawnSkipReason)
    : null;
  const lastScout = formatTimestamp(row.lastStarvationScoutAt);
  const lastAlert = formatTimestamp(row.lastStarvationAlertAt);
  const lastKick = formatTimestamp(row.lastBatchKickAt);

  return (
    <div className="pipeline-starvation-row">
      <div className="pipeline-starvation-row-main">
        <span className="pipeline-starvation-repo">{row.repo}</span>
        <span className="pipeline-starvation-metric">
          blockedEmpty={row.consecutiveBlockedEmpty}
        </span>
        {cooldown ? (
          <span className="pipeline-starvation-metric">cooldown={cooldown}</span>
        ) : null}
      </div>
      <div className="pipeline-starvation-row-meta">
        {lastEmpty ? <span>last empty {lastEmpty}</span> : null}
        {lastSkip ? <span>skip {lastSkip}</span> : null}
        {lastScout ? <span>scout {lastScout}</span> : null}
        {lastAlert ? <span>alert {lastAlert}</span> : null}
        {lastKick ? <span>batch kick {lastKick}</span> : null}
      </div>
    </div>
  );
}

/**
 * Read-only Diagnostics card for pipeline-starvation drought depth (issue #2259).
 * Reuses the `pipelineStarvation` block already projected on `GET /api/health`
 * and retained by the ops-health poll — no dedicated API route, no mutations.
 */
export function PipelineStarvationPanel({
  defaultExpanded = true,
  snapshot,
}: Props) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const storeSnapshot = useKookrStore((s) => s.pipelineStarvation);
  const block = snapshot !== undefined ? snapshot : storeSnapshot;
  const elevated = useMemo(
    () => elevatedPipelineStarvationRepos(block?.repos),
    [block],
  );

  return (
    <section className="pipeline-starvation-section" aria-label="Pipeline Starvation">
      <button
        type="button"
        className="section-header pipeline-starvation-header"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        aria-controls="pipeline-starvation-body"
      >
        <span className="section-chevron" aria-hidden>{expanded ? '▾' : '▸'}</span>
        <span className="stats-label">
          Pipeline Starvation
          <span className="stats-summary">
            {elevated.length > 0
              ? `${elevated.length} elevated`
              : 'none elevated'}
          </span>
        </span>
        {elevated.length > 0 ? (
          <span className="finding-evidence-pill finding-evidence-pill--warn">drought</span>
        ) : null}
      </button>
      {expanded ? (
        <div
          id="pipeline-starvation-body"
          className="pipeline-starvation-body"
          aria-live="polite"
        >
          {block?.inventByPriorityClass ? (
            <div className="pipeline-starvation-invent-mix diagnostic-muted">
              invent {block.inventByPriorityClass.windowHours}h: product=
              {block.inventByPriorityClass.product} micro=
              {block.inventByPriorityClass.micro} other=
              {block.inventByPriorityClass.other}
            </div>
          ) : null}
          {elevated.length === 0 ? (
            <div className="diagnostic-muted">No elevated pipeline starvation.</div>
          ) : (
            <div className="pipeline-starvation-list">
              {elevated.map((row) => (
                <RepoRow key={row.repo} row={row} />
              ))}
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}
