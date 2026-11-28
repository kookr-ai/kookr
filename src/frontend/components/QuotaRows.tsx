import React from 'react';
import type { QuotaStatus } from '../../shared/protocol.js';

// The Claude plan quota bars. They live apart from UsageSummary so that
// account components can draw them without importing UsageSummary, which
// itself imports the account switcher (an import cycle otherwise).

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
const QUOTA_OPEN_SETTINGS_HINT = 'Click to change quota headroom in Settings';

function QuotaRow({
  window,
  longLabel,
  shortLabel,
  utilization,
  resetsAt,
  staleMinutes,
  inButton,
}: {
  window: '5h' | '7d';
  longLabel: string;
  shortLabel: string;
  utilization: number;
  resetsAt: string;
  staleMinutes: number | null;
  /** Inside the Settings button a row may hold only phrasing content (spans). */
  inButton: boolean;
}) {
  const percent = Math.round(utilization);
  const reset = formatResetTime(resetsAt);
  const title = `${longLabel}: ${percent}% used, resets in ${reset}. ${QUOTA_EXPLAINER}${staleMinutes !== null ? `. Quota data is ${staleMinutes}m old` : ''}${inButton ? `. ${QUOTA_OPEN_SETTINGS_HINT}` : ''}`;
  const Block = inButton ? 'span' : 'div';
  return (
    <Block
      className={`usage-row usage-quota ${quotaColorClass(utilization)}`}
      data-testid={`usage-quota-${window}`}
      title={title}
    >
      <Block className="usage-line">
        <span className="usage-label">
          <span className="usage-label-long">{longLabel}</span>
          <span className="usage-label-short" aria-hidden="true">{shortLabel}</span>
        </span>
        <span className="usage-value">
          {percent}%{' '}
          <span className="quota-reset">({reset})</span>
        </span>
      </Block>
      <Block className="usage-bar" aria-hidden="true">
        <i style={{ width: `${Math.max(0, Math.min(100, utilization))}%` }} />
      </Block>
    </Block>
  );
}

/**
 * The Claude plan windows. With `onOpenQuotaSettings` both rows form one
 * button that opens Settings on the quota-headroom field (issue #3408);
 * without it they stay a plain, non-interactive readout.
 */
export function QuotaRows({
  quota,
  onOpenQuotaSettings,
}: {
  quota: QuotaStatus;
  onOpenQuotaSettings?: () => void;
}) {
  const staleSec = Math.floor((Date.now() - quota.updatedAt) / 1000);
  const staleMinutes = staleSec > 300 ? Math.floor(staleSec / 60) : null;
  const inButton = Boolean(onOpenQuotaSettings);
  const className = `usage-quotas${staleMinutes !== null ? ' quota-stale' : ''}`;
  const rows = (
    <>
      {quota.fiveHour && (
        <QuotaRow
          window="5h"
          longLabel="5-hour quota"
          shortLabel="5h"
          utilization={quota.fiveHour.utilization}
          resetsAt={quota.fiveHour.resetsAt}
          staleMinutes={staleMinutes}
          inButton={inButton}
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
          inButton={inButton}
        />
      )}
    </>
  );
  if (!onOpenQuotaSettings) return <div className={className}>{rows}</div>;
  // aria-label replaces the button's content for screen readers, so it carries
  // the percentages too, like the "… Open Cost Comparison" spend buttons.
  const readout = [
    quota.fiveHour && `5-hour quota ${Math.round(quota.fiveHour.utilization)}%`,
    quota.sevenDay && `7-day quota ${Math.round(quota.sevenDay.utilization)}%`,
  ].filter(Boolean).join(', ');
  return (
    <button
      type="button"
      className={className}
      data-testid="usage-quota-settings"
      aria-label={`${readout}. Open Settings to change quota headroom`}
      onClick={onOpenQuotaSettings}
    >
      {rows}
    </button>
  );
}
