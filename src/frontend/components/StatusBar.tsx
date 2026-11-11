import React, { useEffect, useState } from 'react';
import { useKookrStore } from '../store/useStore.js';
import type { FocusZone } from '../store/useStore.js';
import type { QuotaStatus } from '../../shared/protocol.js';
import { getOutcomeLedger } from '../api/index.js';
import type { OutcomeLedgerReadiness } from '../../shared/contracts/outcome-ledger.js';
import { formatOldestFindingWait } from '../presentation.js';
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
 * The status bar keeps counts, spend and quota (issue #3561 slice 2, "quiet
 * chrome"). Host resources, ops-health pills, time to unblock, live friction,
 * speech-to-text, sound and achievements moved behind the System indicator in
 * the top bar (see SystemStatusDetails). The focus-zone cue and the reflection
 * prompt stay: both appear only in a specific moment, never at rest.
 */

interface Props {
  findings: number;
  /**
   * Earliest live finding wait among the same agents as {@link findings}.
   * App passes this from the rail bucket so the chip matches the count
   * without polling `/api/health`.
   */
  oldestFindingWaitStartedAt?: Date | string;
  total: number;
  /**
   * Live-list count of agents whose `finishedAt` falls in the last 24 hours
   * (issue #2618). Hidden at 0. A lower bound when completed rows have aged
   * out of the snapshot.
   */
  completedLast24h?: number;
  /**
   * Live-list count of agents whose `startedAt` falls in the last 24 hours
   * (issue #2632). Hidden at 0. A lower bound when old rows have aged out
   * of the snapshot. Does not invent a start from `finishedAt`.
   */
  launchedLast24h?: number;
  compact?: boolean;
  onShowShortcuts: () => void;
  /**
   * Open Diagnostics (Outcome Scoreboard) from the launched-task chip.
   * Optional so isolated StatusBar instances can show passive counts.
   */
  onOpenDiagnostics?: () => void;
  /**
   * Open Cost Comparison when the 24h cost chip is clicked (issue #3335).
   * Optional so isolated StatusBar tests need no App wiring.
   */
  onOpenCostComparison?: () => void;
  /**
   * Expand the sidebar Completed rail when the 24h completed chip is clicked
   * (issue #3333). Optional so isolated StatusBar tests need no App wiring.
   */
  onExpandCompleted?: () => void;
  /**
   * Select the oldest unanswered finding when the oldest-wait chip is
   * clicked (issue #3343). Optional so isolated StatusBar tests keep
   * today's non-interactive status span.
   */
  onSelectOldestFinding?: () => void;
  reflectionSuggestion?: {
    sessionLabel: string;
    summary: string;
    totalInterventions: number;
    totalFindings: number;
  } | null;
  onReflect?: () => void;
  onDismissReflection?: () => void;
}

const ZONE_LABELS: Record<FocusZone, string> = {
  'terminal': 'Terminal',
  'response-input': 'Response',
  'none': '',
};

function formatResetTime(resetsAt: string): string {
  const resetMs = new Date(resetsAt).getTime();
  const nowMs = Date.now();
  const diffMs = resetMs - nowMs;
  if (diffMs <= 0) return 'now';
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainMins = minutes % 60;
  if (hours < 24) return remainMins > 0 ? `${hours}h ${remainMins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function quotaColorClass(utilization: number): string {
  if (utilization >= 95) return 'quota-critical';
  if (utilization >= 80) return 'quota-high';
  if (utilization >= 50) return 'quota-medium';
  return 'quota-low';
}

export function QuotaDisplay({ quota }: { quota: QuotaStatus }) {
  const staleSec = Math.floor((Date.now() - quota.updatedAt) / 1000);
  const stale = staleSec > 300; // >5 min = stale
  // The raw "5h: 31% (1h 56m) · 7d: 8% (4d)" pills are cryptic — spell out that
  // these are the Claude plan's rolling rate-limit windows.
  const explainer = 'Claude plan rate-limit usage — 5h: rolling 5-hour window (resets in the time shown) · 7d: rolling 7-day window (resets in the time shown)';
  return (
    <span className={`quota-display ${stale ? 'quota-stale' : ''}`} title={stale ? `${explainer}. Quota data is ${Math.floor(staleSec / 60)}m old` : explainer}>
      {quota.fiveHour && (
        <span className={`quota-pill ${quotaColorClass(quota.fiveHour.utilization)}`}>
          5h: {Math.round(quota.fiveHour.utilization)}%
          <span className="quota-reset">({formatResetTime(quota.fiveHour.resetsAt)})</span>
        </span>
      )}
      {quota.sevenDay && (
        <span className={`quota-pill ${quotaColorClass(quota.sevenDay.utilization)}`}>
          7d: {Math.round(quota.sevenDay.utilization)}%
          <span className="quota-reset">({formatResetTime(quota.sevenDay.resetsAt)})</span>
        </span>
      )}
    </span>
  );
}

export function StatusBar({
  findings,
  oldestFindingWaitStartedAt,
  total,
  completedLast24h = 0,
  launchedLast24h = 0,
  compact = false,
  onShowShortcuts,
  onOpenDiagnostics,
  onOpenCostComparison,
  onExpandCompleted,
  onSelectOldestFinding,
  reflectionSuggestion,
  onReflect,
  onDismissReflection,
}: Props) {
  const focusZone = useKookrStore((s) => s.focusZone);
  const quotaStatus = useKookrStore((s) => s.quotaStatus);
  const zoneLabel = ZONE_LABELS[focusZone];
  const [cost24h, setCost24h] = useState<{
    costUsd: number;
    readiness: OutcomeLedgerReadiness;
    costCoverage: number | null;
  } | null>(null);
  const [, setOldestWaitTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const body = await getOutcomeLedger('24h');
        // Trust only a well-shaped summary; a schema drift or error body degrades
        // to a hidden chip rather than a thrown render or a bogus figure.
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

  useEffect(() => {
    if (findings <= 0 || oldestFindingWaitStartedAt === undefined) return;
    const timer = setInterval(() => setOldestWaitTick((tick) => tick + 1), 30_000);
    return () => clearInterval(timer);
  }, [findings, oldestFindingWaitStartedAt]);

  const oldestWaitLabel = findings > 0
    ? formatOldestFindingWait(oldestFindingWaitStartedAt)
    : null;

  const showCompletedChip = shouldShowCompletedInWindowChip(completedLast24h);
  const showLaunchedChip = shouldShowLaunchedInWindowChip(launchedLast24h);
  const showCost24hChip = cost24h !== null
    && shouldShow24hCostChip(cost24h.costUsd, cost24h.readiness, cost24h.costCoverage);
  const cost24hLabel = showCost24hChip && cost24h
    ? format24hCostChipLabel(cost24h.costUsd)
    : '';
  const cost24hTitle = showCost24hChip && cost24h
    ? format24hCostChipTitle(cost24h.costUsd)
    : '';

  return (
    <div className={`statusbar${compact ? ' compact' : ''}`}>
      <span className="statusbar-left">
        {zoneLabel && <span className="focus-zone-pill">{zoneLabel}</span>}
        <span>{total} task{total !== 1 ? 's' : ''} · {findings} finding{findings !== 1 ? 's' : ''}</span>
        {showCompletedChip && (
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
        {showLaunchedChip && (
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
        {oldestWaitLabel && (
          onSelectOldestFinding ? (
            <button
              type="button"
              className="oldest-finding-wait-pill"
              data-testid="oldest-finding-wait-chip"
              title="Age of the oldest unanswered finding — live wait, not the historical median"
              aria-label={`oldest ${oldestWaitLabel}. Select oldest unanswered finding`}
              onClick={onSelectOldestFinding}
            >
              oldest {oldestWaitLabel}
            </button>
          ) : (
            <span
              className="oldest-finding-wait-pill"
              data-testid="oldest-finding-wait-chip"
              role="status"
              title="Age of the oldest unanswered finding — live wait, not the historical median"
            >
              oldest {oldestWaitLabel}
            </span>
          )
        )}
        {reflectionSuggestion && (
          <span className="reflection-prompt" role="status" aria-live="polite">
            <span className="reflection-prompt-copy">
              <strong>Reflect on {reflectionSuggestion.sessionLabel}</strong>
              <span>
                {reflectionSuggestion.summary} ({reflectionSuggestion.totalInterventions} interventions, {reflectionSuggestion.totalFindings} signals)
              </span>
            </span>
            <button className="btn-reflection" onClick={onReflect}>Reflect</button>
            <button className="btn-reflection btn-reflection-dismiss" onClick={onDismissReflection}>Dismiss</button>
          </span>
        )}
      </span>
      <span className="statusbar-right" data-testid="statusbar-spend-quota">
        {showCost24hChip && cost24h && (
          onOpenCostComparison ? (
            <button
              type="button"
              className="cost-24h-pill"
              data-testid="cost-24h-chip"
              title={cost24hTitle}
              aria-label={`${cost24hLabel}. Open Cost Comparison`}
              onClick={onOpenCostComparison}
            >
              {cost24hLabel}
            </button>
          ) : (
            <span
              className="cost-24h-pill"
              data-testid="cost-24h-chip"
              role="status"
              title={cost24hTitle}
            >
              {cost24hLabel}
            </span>
          )
        )}
        {quotaStatus && <QuotaDisplay quota={quotaStatus} />}
      </span>
      {compact && (
        <span className="statusbar-compact-actions">
          <button className="statusbar-action" onClick={onShowShortcuts}>Shortcuts</button>
        </span>
      )}
    </div>
  );
}
