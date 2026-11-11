import React, { useEffect, useState } from 'react';
import { useKookrStore } from '../store/useStore.js';
import type { QuotaStatus } from '../../shared/protocol.js';
import { getOutcomeLedger } from '../api/index.js';
import type { OutcomeLedgerReadiness } from '../../shared/contracts/outcome-ledger.js';
import { formatCost } from '../presentation.js';
import {
  formatCompletedInWindowChipLabel,
  formatCompletedInWindowChipTitle,
  shouldShowCompletedInWindowChip,
} from './status-bar-completed-count.js';
import {
  formatLaunchedInWindowChipLabel,
  formatLaunchedInWindowChipTitle,
  shouldShowLaunchedInWindowChip,
} from './status-bar-launched-count.js';
import {
  format24hCostChipLabel,
  format24hCostChipTitle,
  shouldShow24hCostChip,
} from './status-bar-24h-cost.js';

/*
 * Spend and quota (issue #3561 slice 5b, variant B "triage inbox"). The status
 * bar is gone; these readouts live in the navigation footer, and the same
 * summary is the Usage section of the System detail so they stay reachable
 * where the navigation is not shown (phones, no tracked project, Alt+P,
 * terminal focus). In the 52 px icon rail only the quota percentages show.
 */

export interface Cost24h {
  costUsd: number;
  readiness: OutcomeLedgerReadiness;
  costCoverage: number | null;
}

/**
 * Rolling 24h agent cost from the outcome ledger, refreshed every minute.
 * App calls this once and hands the result to every summary it renders, so a
 * System detail opened beside the footer does not start a second poll.
 * `null` while loading, on error, or for a malformed body (the readout hides).
 */
export function useCost24h(): Cost24h | null {
  const [cost24h, setCost24h] = useState<Cost24h | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const body = await getOutcomeLedger('24h');
        // Trust only a well-shaped summary; a schema drift or error body degrades
        // to a hidden readout rather than a thrown render or a bogus figure.
        const costUsd = body?.summary?.totalKnownCostUsd;
        if (typeof costUsd !== 'number') throw new Error('missing totalKnownCostUsd');
        const rawCoverage = body?.quality?.costCoverage;
        if (!cancelled) {
          setCost24h({
            costUsd,
            readiness: body.readiness,
            costCoverage: typeof rawCoverage === 'number' ? rawCoverage : null,
          });
        }
      } catch {
        if (!cancelled) setCost24h(null);
      }
    };
    void load();
    const timer = setInterval(() => { void load(); }, 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);
  return cost24h;
}

export function formatResetTime(resetsAt: string, nowMs: number = Date.now()): string {
  const diffMs = new Date(resetsAt).getTime() - nowMs;
  if (diffMs <= 0) return 'now';
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainMins = minutes % 60;
  if (hours < 24) return remainMins > 0 ? `${hours}h ${remainMins}m` : `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function quotaColorClass(utilization: number): string {
  if (utilization >= 95) return 'quota-critical';
  if (utilization >= 80) return 'quota-high';
  if (utilization >= 50) return 'quota-medium';
  return 'quota-low';
}

// The bare "5h" / "7d" figures are cryptic; spell out what they measure.
const QUOTA_EXPLAINER = 'Claude plan rate-limit usage, rolling window (resets in the time shown)';

function QuotaRow({
  window,
  longLabel,
  shortLabel,
  utilization,
  resetsAt,
  staleMinutes,
}: {
  window: '5h' | '7d';
  longLabel: string;
  shortLabel: string;
  utilization: number;
  resetsAt: string;
  staleMinutes: number | null;
}) {
  const percent = Math.round(utilization);
  const reset = formatResetTime(resetsAt);
  const title = `${longLabel}: ${percent}% used, resets in ${reset}. ${QUOTA_EXPLAINER}${staleMinutes !== null ? `. Quota data is ${staleMinutes}m old` : ''}`;
  return (
    <div
      className={`usage-row usage-quota ${quotaColorClass(utilization)}`}
      data-testid={`usage-quota-${window}`}
      title={title}
    >
      <div className="usage-line">
        <span className="usage-label">
          <span className="usage-label-long">{longLabel}</span>
          <span className="usage-label-short" aria-hidden="true">{shortLabel}</span>
        </span>
        <span className="usage-value">
          {percent}%{' '}
          <span className="quota-reset">({reset})</span>
        </span>
      </div>
      <div className="usage-bar" aria-hidden="true">
        <i style={{ width: `${Math.max(0, Math.min(100, utilization))}%` }} />
      </div>
    </div>
  );
}

export function QuotaRows({ quota }: { quota: QuotaStatus }) {
  const staleSec = Math.floor((Date.now() - quota.updatedAt) / 1000);
  const staleMinutes = staleSec > 300 ? Math.floor(staleSec / 60) : null;
  return (
    <div className={`usage-quotas${staleMinutes !== null ? ' quota-stale' : ''}`}>
      {quota.fiveHour && (
        <QuotaRow
          window="5h"
          longLabel="5-hour quota"
          shortLabel="5h"
          utilization={quota.fiveHour.utilization}
          resetsAt={quota.fiveHour.resetsAt}
          staleMinutes={staleMinutes}
        />
      )}
      {quota.sevenDay && (
        <QuotaRow
          window="7d"
          longLabel="7-day quota"
          shortLabel="7d"
          utilization={quota.sevenDay.utilization}
          resetsAt={quota.sevenDay.resetsAt}
          staleMinutes={staleMinutes}
        />
      )}
    </div>
  );
}

interface Props {
  /** Where the summary sits: the navigation footer or the System detail. */
  placement: 'nav' | 'system';
  cost24h?: Cost24h | null;
  /** Live-list count of agents that finished in the last 24 hours. Hidden at 0. */
  completedLast24h?: number;
  /** Live-list count of agents that started in the last 24 hours. Hidden at 0. */
  launchedLast24h?: number;
  /** Open Cost Comparison from either spend figure. */
  onOpenCostComparison?: () => void;
  /** Open Diagnostics (Outcome Scoreboard) from the launched count. */
  onOpenDiagnostics?: () => void;
  /** Expand the list's Finished section from the completed count. */
  onExpandCompleted?: () => void;
}

export function UsageSummary({
  placement,
  cost24h = null,
  completedLast24h = 0,
  launchedLast24h = 0,
  onOpenCostComparison,
  onOpenDiagnostics,
  onExpandCompleted,
}: Props) {
  const quotaStatus = useKookrStore((s) => s.quotaStatus);
  const totalSpendUsd = useKookrStore((s) => s.totalSpendUsd);

  const showCost24h = cost24h !== null
    && shouldShow24hCostChip(cost24h.costUsd, cost24h.readiness, cost24h.costCoverage);
  const showAllTime = totalSpendUsd > 0;
  const showCompleted = shouldShowCompletedInWindowChip(completedLast24h);
  const showLaunched = shouldShowLaunchedInWindowChip(launchedLast24h);
  const hasQuota = Boolean(quotaStatus && (quotaStatus.fiveHour || quotaStatus.sevenDay));

  if (!showCost24h && !showAllTime && !showCompleted && !showLaunched && !hasQuota) return null;

  const cost24hLabel = showCost24h && cost24h ? format24hCostChipLabel(cost24h.costUsd) : '';
  const cost24hTitle = showCost24h && cost24h ? format24hCostChipTitle(cost24h.costUsd) : '';
  const allTimeLabel = formatCost(totalSpendUsd);
  const allTimeTitle = 'All-time agent spend recorded by this Kookr server — includes cleared and deleted tasks';

  return (
    <div
      className={`usage-summary usage-summary--${placement}${hasQuota ? '' : ' usage-summary--no-quota'}`}
      data-testid={placement === 'nav' ? 'nav-footer' : 'system-usage'}
      aria-label={placement === 'nav' ? 'Spend and quota' : undefined}
      role={placement === 'nav' ? 'group' : undefined}
    >
      {showCost24h && (
        <div className="usage-row usage-line usage-spend">
          <span className="usage-label">Spend</span>
          {onOpenCostComparison ? (
            <button
              type="button"
              className="usage-value cost-24h-pill"
              data-testid="cost-24h-chip"
              title={cost24hTitle}
              aria-label={`${cost24hLabel}. Open Cost Comparison`}
              onClick={onOpenCostComparison}
            >
              {cost24hLabel}
            </button>
          ) : (
            <span className="usage-value cost-24h-pill" data-testid="cost-24h-chip" role="status" title={cost24hTitle}>
              {cost24hLabel}
            </span>
          )}
        </div>
      )}
      {showAllTime && (
        <div className="usage-row usage-line usage-spend">
          <span className="usage-label">All time</span>
          {onOpenCostComparison ? (
            <button
              type="button"
              className="usage-value"
              data-testid="all-time-spend"
              title={allTimeTitle}
              aria-label={`${allTimeLabel} all-time. Open Cost Comparison`}
              onClick={onOpenCostComparison}
            >
              {allTimeLabel}
            </button>
          ) : (
            <span className="usage-value" data-testid="all-time-spend" title={allTimeTitle}>{allTimeLabel}</span>
          )}
        </div>
      )}
      {(showLaunched || showCompleted) && (
        <div className="usage-row usage-counts">
          {showLaunched && (
            onOpenDiagnostics ? (
              <button
                type="button"
                className="launched-24h-pill"
                data-testid="launched-24h-chip"
                title={formatLaunchedInWindowChipTitle(launchedLast24h)}
                aria-label={`${formatLaunchedInWindowChipLabel(launchedLast24h)}. Open Outcome Scoreboard`}
                onClick={onOpenDiagnostics}
              >
                {formatLaunchedInWindowChipLabel(launchedLast24h)}
              </button>
            ) : (
              <span
                className="launched-24h-pill"
                data-testid="launched-24h-chip"
                role="status"
                title={formatLaunchedInWindowChipTitle(launchedLast24h)}
              >
                {formatLaunchedInWindowChipLabel(launchedLast24h)}
              </span>
            )
          )}
          {showCompleted && (
            onExpandCompleted ? (
              <button
                type="button"
                className="completed-24h-pill"
                data-testid="completed-24h-chip"
                title={formatCompletedInWindowChipTitle(completedLast24h)}
                aria-label={`${formatCompletedInWindowChipLabel(completedLast24h)}. Show completed tasks`}
                onClick={onExpandCompleted}
              >
                {formatCompletedInWindowChipLabel(completedLast24h)}
              </button>
            ) : (
              <span
                className="completed-24h-pill"
                data-testid="completed-24h-chip"
                role="status"
                title={formatCompletedInWindowChipTitle(completedLast24h)}
              >
                {formatCompletedInWindowChipLabel(completedLast24h)}
              </span>
            )
          )}
        </div>
      )}
      {quotaStatus && hasQuota && <QuotaRows quota={quotaStatus} />}
    </div>
  );
}
