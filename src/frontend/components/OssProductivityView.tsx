import React, { useEffect, useMemo, useState } from 'react';
import { useKookrStore } from '../store/useStore.js';
import { useEscapeToClose } from '../hooks/useEscapeToClose.js';
import type {
  ContributionAttempt,
  AttemptState,
  IssueCheckError,
} from '../../shared/contracts/messages.js';
import {
  computeOssTrends,
  countDelta,
  mergeRateDelta,
  priorWindowLabel,
  isSparseTrend,
  isStale,
  type TrendWindow,
  type DeltaDisplay,
} from '../oss-trends.js';
import { OssWeeklyBars } from './OssWeeklyBars.js';
import { OssTrendsErrorBoundary } from './OssTrendsErrorBoundary.js';

interface Props {
  onClose: () => void;
  /** Close this panel and open Launch on the Playbooks tab. */
  onBrowsePlaybooks: () => void;
}

/** OSS-extension / tracking setup in the published hooks guide. */
export const OSS_HOOKS_SETUP_URL =
  'https://github.com/kookr-ai/kookr/blob/main/docs/hooks-setup.md#oss-extension-hooks-bundled-with-the-repo';

type TimeWindow = TrendWindow;

const WINDOW_LABELS: Record<TimeWindow, string> = {
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
  all: 'All time',
};

/** Returns the ISO timestamp of N days ago at local midnight, as UTC ISO string. */
function localStartOfDaysAgo(days: number): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

function filterByWindow(attempts: ContributionAttempt[], timeWindow: TimeWindow): ContributionAttempt[] {
  if (timeWindow === 'all') return attempts;
  const days = timeWindow === '7d' ? 7 : timeWindow === '30d' ? 30 : 90;
  const cutoff = localStartOfDaysAgo(days);
  return attempts.filter((a) => a.updatedAt >= cutoff);
}

/** Exclude scouted-only records from user-visible counts and tables. */
function prRecords(attempts: ContributionAttempt[]): ContributionAttempt[] {
  return attempts.filter((a) => a.state !== 'scouted');
}

// Exported for test coverage without React-component infra. Pure derived-data
// helpers consumed by the view. Unit tested in
// `src/frontend/components/OssProductivityView.derived.test.ts`.
export interface RepoRow {
  repo: string;
  opened: number;
  merged: number;
  closed: number;
  open: number;
  stale: number; // subset of open — linked issue closed by different PR
  mergeRate: number | null; // null when < 3 attempts
  truncated: boolean;
}

export function computeRepoRows(
  attempts: ContributionAttempt[],
  truncatedRepos: string[],
  registryActiveRepos: string[] = [],
): RepoRow[] {
  const byRepo = new Map<string, ContributionAttempt[]>();
  for (const a of attempts) {
    if (a.state === 'scouted') continue;
    const list = byRepo.get(a.repo) ?? [];
    list.push(a);
    byRepo.set(a.repo, list);
  }
  for (const repo of registryActiveRepos) {
    if (!byRepo.has(repo)) byRepo.set(repo, []);
  }
  const rows: RepoRow[] = [];
  for (const [repo, records] of byRepo.entries()) {
    const merged = records.filter((r) => r.state === 'merged').length;
    const closed = records.filter((r) => r.state === 'closed').length;
    const openAll = records.filter((r) => r.state === 'pr_open');
    const stale = openAll.filter(isStale).length;
    const open = openAll.length - stale;
    const opened = merged + closed + openAll.length;
    const decided = merged + closed;
    const mergeRate = decided >= 3 ? merged / decided : null;
    rows.push({
      repo,
      opened,
      merged,
      closed,
      open,
      stale,
      mergeRate,
      truncated: truncatedRepos.includes(repo),
    });
  }
  rows.sort((a, b) => b.opened - a.opened);
  return rows;
}

export interface StaleInfo {
  issueNumber: number;
  closingPrNumber: number | null;
  closingPrUrl: string | null;
  closedAt: string | null;
  verifiedAt: string;
}

export interface FeedItem {
  at: string;
  repo: string;
  state: AttemptState;
  prUrl: string | null;
  prNumber: number | null;
  prTitle: string | null;
  closingPreview: string | null;
  stale: StaleInfo | null;
}

export function computeLifecycleFeed(attempts: ContributionAttempt[]): FeedItem[] {
  const items: FeedItem[] = [];
  for (const a of attempts) {
    if (a.state === 'scouted') continue;
    // Only surface the latest observation for each record to avoid cluttering the feed
    const latest = a.history[a.history.length - 1];
    if (!latest) continue;
    const li = a.linkedIssue ?? null;
    const staleInfo: StaleInfo | null = isStale(a) && li
      ? {
          issueNumber: li.number,
          closingPrNumber: li.closingPrNumber,
          closingPrUrl: li.closingPrNumber != null
            ? `https://github.com/${a.repo}/pull/${li.closingPrNumber}`
            : null,
          closedAt: li.closedAt,
          verifiedAt: li.verifiedAt,
        }
      : null;
    items.push({
      at: latest.at,
      repo: a.repo,
      state: a.state,
      prUrl: a.prUrl,
      prNumber: a.prNumber,
      prTitle: a.prTitle,
      closingPreview: a.closing?.closingComment?.slice(0, 160) ?? null,
      stale: staleInfo,
    });
  }
  items.sort((a, b) => b.at.localeCompare(a.at));
  return items.slice(0, 10);
}

function formatDateOnly(iso: string | null): string | null {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return iso;
  }
}

function stateLabel(s: AttemptState): string {
  switch (s) {
    case 'pr_open': return 'open';
    case 'merged': return 'merged';
    case 'closed': return 'closed';
    case 'scouted': return 'scouted';
  }
}

function stateClass(s: AttemptState): string {
  return `oss-state-${s}`;
}

function formatPercent(v: number | null): string {
  if (v == null) return '—';
  return `${Math.round(v * 100)}%`;
}

function formatDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function OssProductivityView({ onClose, onBrowsePlaybooks }: Props) {
  useEscapeToClose(onClose);

  const {
    ossAttempts,
    ossRegistryActiveRepos,
    ossLastRefreshAt,
    ossRefreshLoading,
    ossRefreshError,
    ossTruncatedRepos,
    ossLastRefreshIssueCheckErrors,
    fetchOssAttempts,
    refreshOssAttempts,
  } = useKookrStore();

  const [timeWindow, setTimeWindow] = useState<TimeWindow>('30d');

  useEffect(() => {
    void fetchOssAttempts();
    // Only on mount — WebSocket pushes keep it fresh afterward
  }, [fetchOssAttempts]);

  const windowed = useMemo(
    () => filterByWindow(ossAttempts, timeWindow),
    [ossAttempts, timeWindow],
  );

  const prs = useMemo(() => prRecords(windowed), [windowed]);

  const trends = useMemo(
    () => computeOssTrends(ossAttempts, timeWindow, Date.now()),
    [ossAttempts, timeWindow],
  );
  const summary = trends.current;
  const priorWindow = priorWindowLabel(timeWindow);
  const chartEvents = summary.opened + summary.merged;
  const isWindowEmpty = chartEvents === 0;
  const isSparse = !isWindowEmpty && isSparseTrend(trends.nonEmptyWeeks, chartEvents);

  const repoRows = useMemo(
    () => computeRepoRows(windowed, ossTruncatedRepos, ossRegistryActiveRepos),
    [windowed, ossTruncatedRepos, ossRegistryActiveRepos],
  );

  const feed = useMemo(() => computeLifecycleFeed(windowed), [windowed]);

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div
        className="dialog oss-productivity-dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="OSS contribution productivity"
      >
        <div className="oss-productivity-header">
          <div>
            <h2 className="oss-productivity-title">OSS Contribution Productivity</h2>
            <div className="oss-productivity-subtitle">
              External repos only · Kookr-observed · local time
              {ossLastRefreshAt && (
                <> · last refresh {formatDateTime(ossLastRefreshAt)}</>
              )}
            </div>
          </div>
          <div className="oss-productivity-actions">
            <select
              className="oss-window-select"
              value={timeWindow}
              onChange={(e) => setTimeWindow(e.target.value as TimeWindow)}
              aria-label="Time window"
            >
              {(Object.keys(WINDOW_LABELS) as TimeWindow[]).map((w) => (
                <option key={w} value={w}>{WINDOW_LABELS[w]}</option>
              ))}
            </select>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => void refreshOssAttempts()}
              disabled={ossRefreshLoading}
            >
              {ossRefreshLoading ? 'Refreshing…' : 'Refresh'}
            </button>
            <button className="dialog-close" onClick={onClose} aria-label="Close">&times;</button>
          </div>
        </div>

        {ossRefreshError && (
          <div className="oss-productivity-error">{ossRefreshError}</div>
        )}

        {ossLastRefreshIssueCheckErrors.length > 0 && (
          <div
            className="oss-issue-check-error-banner"
            role="alert"
            aria-label="Zombie detection issue check failures"
          >
            <div>
              ⚠ Zombie detection had {ossLastRefreshIssueCheckErrors.length} failed
              issue state check{ossLastRefreshIssueCheckErrors.length === 1 ? '' : 's'} this refresh.
              Stale flags may be out of date.
            </div>
            <details>
              <summary>Details</summary>
              <ul>
                {ossLastRefreshIssueCheckErrors.map((e, i) => (
                  <li key={i}>
                    <code>{e.repo}</code> PR #{e.prNumber}: {e.message}
                  </li>
                ))}
              </ul>
            </details>
          </div>
        )}

        {ossAttempts.length === 0 && ossRegistryActiveRepos.length === 0 ? (
          <div className="oss-productivity-empty">
            <p>
              No OSS attempts tracked yet. Click <strong>Refresh</strong> to pull your
              PR history from the repos in <code>~/.kookr/oss-repos.json</code>.
              Future PRs will be captured automatically by the PostToolUse hook.
            </p>
            <div className="oss-productivity-empty-cta">
              <button
                type="button"
                className="btn-primary"
                onClick={() => {
                  onClose();
                  onBrowsePlaybooks();
                }}
              >
                Browse playbooks
              </button>
              <p>
                Start the OSS Contribution Pipeline playbook, or read{' '}
                <a
                  className="oss-productivity-empty-docs-link"
                  href={OSS_HOOKS_SETUP_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  how OSS tracking works
                </a>
                .
              </p>
            </div>
          </div>
        ) : (
          <>
            <OssTrendsErrorBoundary>
              <section className="oss-summary">
                <SummaryCard
                  label="Opened"
                  value={summary.opened}
                  delta={countDelta(summary.opened, trends.prior, trends.prior?.opened ?? 0)}
                  priorWindow={priorWindow}
                />
                <SummaryCard
                  label="Merged"
                  value={summary.merged}
                  accent="success"
                  delta={countDelta(summary.merged, trends.prior, trends.prior?.merged ?? 0)}
                  priorWindow={priorWindow}
                />
                <SummaryCard
                  label="Closed"
                  value={summary.closed}
                  accent="danger"
                  delta={countDelta(summary.closed, trends.prior, trends.prior?.closed ?? 0)}
                  priorWindow={priorWindow}
                  invertDeltaColor
                />
                <SummaryCard
                  label="Open now"
                  value={summary.openNow}
                  delta={countDelta(summary.openNow, trends.prior, trends.prior?.openNow ?? 0)}
                  priorWindow={priorWindow}
                  neutralDeltaColor
                />
                <SummaryCard
                  label="Stale"
                  value={summary.stale}
                  accent={summary.stale > 0 ? 'warning' : undefined}
                  // No delta — volume is too low for period-over-period to be meaningful.
                />
                <SummaryCard
                  label="Merge rate"
                  value={formatPercent(summary.mergeRate)}
                  accent={summary.mergeRate != null && summary.mergeRate >= 0.5 ? 'success' : undefined}
                  delta={mergeRateDelta(summary.mergeRate, trends.prior)}
                  priorWindow={priorWindow}
                />
              </section>

              <section className="oss-growth-section">
                <div className="oss-growth-heading">
                  <h3>Weekly trend (opened vs merged)</h3>
                  <span className="oss-growth-meta">
                    {isWindowEmpty ? (
                      'no PR activity in this window'
                    ) : (
                      <>
                        {isSparse && (
                          <span className="oss-growth-early">
                            early data — counts are real, any trend is noise ·{' '}
                          </span>
                        )}
                        n = {chartEvents}
                      </>
                    )}
                  </span>
                </div>
                <OssWeeklyBars bars={trends.weeklyBars} />
              </section>
            </OssTrendsErrorBoundary>

            <section className="oss-per-repo">
              <h3>Per-repo breakdown</h3>
              <table className="oss-repo-table">
                <thead>
                  <tr>
                    <th>Repo</th>
                    <th className="num">Opened</th>
                    <th className="num">Merged</th>
                    <th className="num">Closed</th>
                    <th className="num">Open</th>
                    <th className="num">Stale</th>
                    <th className="num">Merge rate</th>
                  </tr>
                </thead>
                <tbody>
                  {repoRows.length === 0 ? (
                    <tr><td colSpan={7} className="oss-empty-row">No PR records in this window.</td></tr>
                  ) : (
                    repoRows.map((row) => (
                      <tr key={row.repo}>
                        <td>
                          {row.repo}
                          {row.truncated && (
                            <span className="oss-truncation-warning" title="gh pr list returned exactly 100 items — older PRs may not be visible">
                              {' '}⚠ possibly truncated
                            </span>
                          )}
                        </td>
                        <td className="num">{row.opened}</td>
                        <td className="num">{row.merged}</td>
                        <td className="num">{row.closed}</td>
                        <td className="num">{row.open}</td>
                        <td className="num">
                          {row.stale > 0 ? (
                            <span className="oss-stale-count">{row.stale}</span>
                          ) : (
                            row.stale
                          )}
                        </td>
                        <td className="num">{formatPercent(row.mergeRate)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </section>

            <section className="oss-feed">
              <h3>Recent lifecycle feed</h3>
              {feed.length === 0 ? (
                <div className="oss-empty-row">No activity in this window.</div>
              ) : (
                <ul className="oss-feed-list">
                  {feed.map((item, idx) => (
                    <li key={idx} className="oss-feed-item">
                      <div className="oss-feed-row">
                        <span className={`oss-state-pill ${stateClass(item.state)}`}>
                          {stateLabel(item.state)}
                        </span>
                        <span className="oss-feed-repo">{item.repo}</span>
                        {item.prNumber != null && item.prUrl && (
                          <a
                            href={item.prUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="oss-feed-pr"
                          >
                            #{item.prNumber}
                          </a>
                        )}
                        <span className="oss-feed-time">{formatDateTime(item.at)}</span>
                      </div>
                      {item.prTitle && <div className="oss-feed-title">{item.prTitle}</div>}
                      {item.stale && (
                        <div
                          className="oss-feed-stale"
                          role="status"
                          title={`linked-issue state verified at ${formatDateTime(item.stale.verifiedAt)}`}
                        >
                          <span aria-hidden="true">⚠ </span>
                          issue #{item.stale.issueNumber} closed
                          {item.stale.closingPrNumber != null && item.stale.closingPrUrl && (
                            <>
                              {' '}by{' '}
                              <a
                                href={item.stale.closingPrUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                              >
                                #{item.stale.closingPrNumber}
                              </a>
                            </>
                          )}
                          {item.stale.closedAt && <> on {formatDateOnly(item.stale.closedAt)}</>}
                        </div>
                      )}
                      {item.closingPreview && (
                        <div className="oss-feed-closing" title="Closing comment preview (first 160 chars)">
                          “{item.closingPreview}”
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}

function SummaryCard({
  label,
  value,
  accent,
  delta,
  priorWindow,
  invertDeltaColor,
  neutralDeltaColor,
}: {
  label: string;
  value: string | number;
  accent?: 'success' | 'danger' | 'warning';
  delta?: DeltaDisplay | null;
  priorWindow?: string;
  invertDeltaColor?: boolean;
  neutralDeltaColor?: boolean;
}) {
  const accentClass = accent ? `oss-summary-card-${accent}` : '';
  let deltaClass = 'oss-summary-delta-flat';
  if (delta) {
    if (neutralDeltaColor) {
      deltaClass = 'oss-summary-delta-neutral';
    } else if (delta.direction === 'up') {
      deltaClass = invertDeltaColor ? 'oss-summary-delta-down' : 'oss-summary-delta-up';
    } else if (delta.direction === 'down') {
      deltaClass = invertDeltaColor ? 'oss-summary-delta-up' : 'oss-summary-delta-down';
    }
  }
  return (
    <div className={`oss-summary-card ${accentClass}`}>
      <div className="oss-summary-label">{label}</div>
      <div className="oss-summary-value">{value}</div>
      {delta && (
        <div className={`oss-summary-delta ${deltaClass}`}>
          {delta.label}
          {priorWindow ? <span className="oss-summary-delta-window"> {priorWindow}</span> : null}
        </div>
      )}
    </div>
  );
}
