import React, { useEffect, useState } from 'react';
import { useKookrStore } from '../store/useStore.js';
import { getOutcomeLedger } from '../api/index.js';
import type { OutcomeLedgerReadiness } from '../../shared/contracts/outcome-ledger.js';
import { formatCost } from '../presentation.js';
import { AccountSwitcherChip } from './AccountSwitcherChip.js';
import { useClaudeAccounts } from '../store/claude-accounts.js';
import { QuotaRows } from './QuotaRows.js';
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

export { QuotaRows, formatResetTime, quotaColorClass } from './QuotaRows.js';

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
  /** Open Settings on the quota-headroom field from the quota rows (#3408). */
  onOpenQuotaSettings?: () => void;
  /** Open Settings on the Accounts tab from the account switcher chip. */
  onOpenAccountSettings?: () => void;
}

export function UsageSummary({
  placement,
  cost24h = null,
  completedLast24h = 0,
  launchedLast24h = 0,
  onOpenCostComparison,
  onOpenDiagnostics,
  onExpandCompleted,
  onOpenQuotaSettings,
  onOpenAccountSettings,
}: Props) {
  const quotaStatus = useKookrStore((s) => s.quotaStatus);
  const totalSpendUsd = useKookrStore((s) => s.totalSpendUsd);
  const { hasRegistered, defaultName } = useClaudeAccounts();

  const showCost24h = cost24h !== null
    && shouldShow24hCostChip(cost24h.costUsd, cost24h.readiness, cost24h.costCoverage);
  const showAllTime = totalSpendUsd > 0;
  const showCompleted = shouldShowCompletedInWindowChip(completedLast24h);
  const showLaunched = shouldShowLaunchedInWindowChip(launchedLast24h);
  const hasQuota = Boolean(quotaStatus && (quotaStatus.fiveHour || quotaStatus.sevenDay));

  if (!showCost24h && !showAllTime && !showCompleted && !showLaunched && !hasQuota && !hasRegistered) return null;

  const cost24hLabel = showCost24h && cost24h ? format24hCostChipLabel(cost24h.costUsd) : '';
  const cost24hTitle = showCost24h && cost24h ? format24hCostChipTitle(cost24h.costUsd) : '';
  const allTimeLabel = formatCost(totalSpendUsd);
  const allTimeTitle = 'All-time agent spend recorded by this Kookr server — includes cleared and deleted tasks';

  const summary = (
    <div
      className={`usage-summary usage-summary--${placement}${hasQuota || hasRegistered ? '' : ' usage-summary--no-quota'}`}
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
      <AccountSwitcherChip onOpenAccountSettings={onOpenAccountSettings} />
      {quotaStatus && hasQuota && hasRegistered && defaultName !== 'host' && (
        <div
          className="usage-quota-caption"
          data-testid="usage-quota-host-caption"
          title="Kookr reads quota for the host login only, not for the account new tasks use"
        >
          Quota: host login
        </div>
      )}
      {quotaStatus && hasQuota && (
        <QuotaRows quota={quotaStatus} onOpenQuotaSettings={onOpenQuotaSettings} />
      )}
    </div>
  );
  if (placement === 'nav') return summary;
  // In the System detail the summary brings its own heading, so an empty
  // summary leaves no orphan "Usage" title behind.
  return (
    <>
      <h3 className="system-popover-heading" data-testid="system-usage-heading">Usage</h3>
      {summary}
    </>
  );
}
