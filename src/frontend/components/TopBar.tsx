import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useKookrStore } from '../store/useStore.js';
import { DndPill } from './DndPill.js';
import { formatCost } from '../presentation.js';

interface Props {
  findings: number;
  currentIndex: number;
  totalFindings: number;
  compact?: boolean;
  onLaunch: () => void;
  onSchedules: () => void;
  onSettings: () => void;
  onShowShortcuts: () => void;
  onOssView: () => void;
  onOperations: () => void;
  operationsOpen?: boolean;
  /** Open the Cost Comparison panel. Optional — the icon is hidden when undefined. */
  onCostComparison?: () => void;
  /** Optional slot rendered in the right-side action cluster, hidden in compact mode. */
  sweepSlot?: React.ReactNode;
}

interface DeployStatus {
  configured: boolean;
  available?: boolean;
  deploying?: boolean;
  toolkit?: ToolkitStatus;
  toolkitError?: string;
  currentShort?: string;
  latestShort?: string;
  behindCount?: number;
  commits?: { hash: string; subject: string }[];
  error?: string;
  /** Port this dashboard's backend is bound to. Undefined when talking to a pre-update backend. */
  runningPort?: number;
  /** Port the deploy button targets (the production instance). */
  prodPort?: number;
}

interface ToolkitStatus {
  stale: boolean;
  checkedCount: number;
  staleCount: number;
}

function timeAgo(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatDateTime(isoString: string): string {
  return new Date(isoString).toLocaleString();
}

export function TopBar({ findings, currentIndex, totalFindings, compact = false, onLaunch, onSchedules, onSettings, onShowShortcuts, onOssView, onOperations, operationsOpen = false, onCostComparison, sweepSlot }: Props) {
  const { connected, buildInfo, serverStartedAt, totalSpendUsd, agents, circuitBreakers, diagnosticReport } = useKookrStore();
  const [showPopover, setShowPopover] = useState(false);
  const [deployStatus, setDeployStatus] = useState<DeployStatus | null>(null);
  const [deployLoading, setDeployLoading] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [toolkitRefreshing, setToolkitRefreshing] = useState(false);
  const preDeployCommitRef = useRef<string | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Close popover on outside click
  useEffect(() => {
    if (!showPopover) return;
    function handleClick(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setShowPopover(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showPopover]);

  // Check deploy status when popover opens
  const checkDeployStatus = useCallback(async () => {
    setDeployLoading(true);
    try {
      const res = await fetch('/api/deploy/status');
      const data: DeployStatus = await res.json();
      if (res.ok) {
        setDeployStatus(data);
        if (data.deploying) setDeploying(true);
      } else {
        setDeployStatus({ ...data, error: data.error ?? 'Failed to check status' });
      }
    } catch {
      setDeployStatus({ configured: false, error: 'Server unreachable' });
    } finally {
      setDeployLoading(false);
    }
  }, []);

  useEffect(() => {
    checkDeployStatus();
  }, [checkDeployStatus]);

  useEffect(() => {
    if (showPopover) {
      checkDeployStatus();
    }
  }, [showPopover, checkDeployStatus]);

  // Detect deploy completion: when we were deploying and reconnected with a *different* build
  useEffect(() => {
    if (
      deploying &&
      connected &&
      buildInfo &&
      buildInfo.commitShort !== 'dev' &&
      preDeployCommitRef.current &&
      buildInfo.commitShort !== preDeployCommitRef.current
    ) {
      setDeploying(false);
      setDeployStatus(null);
      preDeployCommitRef.current = null;
    }
  }, [connected, buildInfo, deploying]);

  async function triggerDeploy() {
    preDeployCommitRef.current = buildInfo?.commitShort ?? null;
    setDeploying(true);
    try {
      const res = await fetch('/api/deploy/trigger', { method: 'POST' });
      if (!res.ok) {
        const data = await res.json();
        setDeploying(false);
        setDeployStatus((prev) => prev ? { ...prev, error: data.error ?? 'Deploy failed' } : null);
      }
    } catch {
      // Connection may drop during deploy — that's expected
    }
  }

  async function refreshToolkitLinks() {
    setToolkitRefreshing(true);
    try {
      const res = await fetch('/api/deploy/toolkit-refresh', { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        setDeployStatus((prev) => prev ? { ...prev, toolkit: data.toolkit } : prev);
      } else {
        setDeployStatus((prev) => prev ? { ...prev, ...data, error: data.error ?? 'Toolkit refresh failed' } : {
          configured: false,
          ...data,
          error: data.error ?? 'Toolkit refresh failed',
        });
      }
    } catch {
      setDeployStatus((prev) => prev ? { ...prev, error: 'Toolkit refresh failed' } : {
        configured: false,
        error: 'Toolkit refresh failed',
      });
    } finally {
      setToolkitRefreshing(false);
    }
  }

  const isDev = !buildInfo || buildInfo.commitShort === 'dev';
  const versionLabel = isDev
    ? 'DEV'
    : `${buildInfo.commitShort}`;
  const builtAgo = buildInfo?.buildTimestamp ? timeAgo(buildInfo.buildTimestamp) : '';
  const uptimeLabel = serverStartedAt ? timeAgo(serverStartedAt) : '';

  // Treat a non-prod backend (e.g. `pnpm dev` on :4801) as "deploy doesn't apply
  // here" — clicking would update an unrelated sibling process. We hide the
  // controls and the version-badge update pulse so users aren't nudged toward
  // a misleading action. See issue #15.
  const onNonProdPort =
    deployStatus?.runningPort !== undefined &&
    deployStatus?.prodPort !== undefined &&
    deployStatus.runningPort !== deployStatus.prodPort;

  const toolkitStale = Boolean(deployStatus?.toolkit?.stale);
  const showToolkitSection = Boolean(toolkitStale || toolkitRefreshing || deployStatus?.toolkitError);
  const hasUpdates = (!onNonProdPort && deployStatus?.configured && deployStatus.available && !deploying) || toolkitStale;
  const operationsNeedsAttention =
    circuitBreakers.some((breaker) => breaker.state !== 'closed') ||
    Boolean(diagnosticReport?.findings.length);
  const hasQueueInfo = totalFindings > 0;
  const queueTitle = hasQueueInfo
    ? currentIndex >= 0
      ? `Triaging ${currentIndex + 1} of ${totalFindings} findings`
      : `${totalFindings} finding${totalFindings !== 1 ? 's' : ''} waiting`
    : undefined;
  const queueDotCount = Math.max(totalFindings, 1);
  const spendLabel = totalSpendUsd > 0 ? formatCost(totalSpendUsd) : '$0.00';

  return (
    <div className={`topbar kookr-tour-target-layout${compact ? ' compact' : ''}`}>
      <div className="topbar-left">
        <span className="logo">
          <img src="/kookr-mark-32.png" alt="" aria-hidden="true" width={18} height={18} className="logo-mark" />
          KOOKR
        </span>
        <span
          className={`version-badge ${isDev ? 'dev' : ''} ${hasUpdates ? 'has-updates' : ''}`}
          onClick={() => setShowPopover((v) => !v)}
          title="Build info"
        >
          <span className={`health-dot ${connected ? 'health-dot-connected' : 'health-dot-disconnected'}`} />
          {deploying && <span className="deploy-spinner" />}
          {versionLabel}
          {!compact && !isDev && builtAgo && <span className="version-built"> · {builtAgo}</span>}
          {hasUpdates && <span className="update-dot" />}
        </span>
        {showPopover && (
          <div className="version-popover" ref={popoverRef}>
            {isDev ? (
              <div className="version-row">Running in dev mode (no build info)</div>
            ) : (
              <>
                <div className="version-row"><span className="version-label">Commit</span> <code>{buildInfo.commitHash}</code></div>
                <div className="version-row"><span className="version-label">Branch</span> {buildInfo.branch}</div>
                <div className="version-row"><span className="version-label">Built</span> {formatDateTime(buildInfo.buildTimestamp)}</div>
                <div className="version-row"><span className="version-label">Version</span> {buildInfo.version}</div>
                {serverStartedAt && (
                  <div className="version-row"><span className="version-label">Server up</span> {formatDateTime(serverStartedAt)} ({uptimeLabel})</div>
                )}
              </>
            )}

            {/* Deploy section */}
            <div className="deploy-divider" />
            {onNonProdPort ? (
              <div className="deploy-uptodate">
                This dashboard is on dev (port {deployStatus?.runningPort}). The deploy button updates the prod instance on port {deployStatus?.prodPort}.
              </div>
            ) : (
              <>
                {deployLoading && !deployStatus && (
                  <div className="version-row deploy-checking">Checking for updates...</div>
                )}
                {deployStatus?.error && (
                  <div className="version-row deploy-error">{deployStatus.error}</div>
                )}
                {deployStatus?.toolkitError && (
                  <div className="version-row deploy-error">{deployStatus.toolkitError}</div>
                )}
                {deployStatus && !deployStatus.configured && !deployStatus.error && (
                  <div className="deploy-uptodate">No production instance configured</div>
                )}
                {deploying && (
                  <div className="deploy-status-row">
                    <span className="deploy-spinner" /> Deploying to production...
                  </div>
                )}
                {deployStatus?.configured && !deploying && (
                  <>
                    {deployStatus.available ? (
                      <>
                        <div className="deploy-available">
                          {deployStatus.behindCount} commit{deployStatus.behindCount !== 1 ? 's' : ''} ahead of production
                          <span className="deploy-range">{deployStatus.currentShort} &rarr; {deployStatus.latestShort}</span>
                        </div>
                        {deployStatus.commits && deployStatus.commits.length > 0 && (
                          <div className="deploy-commits">
                            {deployStatus.commits.slice(0, 8).map((c) => (
                              <div key={c.hash} className="deploy-commit">
                                <code>{c.hash}</code> {c.subject}
                              </div>
                            ))}
                            {deployStatus.commits.length > 8 && (
                              <div className="deploy-commit deploy-more">
                                ...and {deployStatus.commits.length - 8} more
                              </div>
                            )}
                          </div>
                        )}
                        <button className="btn-deploy" onClick={triggerDeploy}>
                          Deploy to production
                        </button>
                      </>
                    ) : (
                      <div className="deploy-uptodate">Production is up to date</div>
                    )}
                    <button className="deploy-refresh" onClick={checkDeployStatus} disabled={deployLoading}>
                      {deployLoading ? 'Checking...' : 'Refresh'}
                    </button>
                  </>
                )}
              </>
            )}

            {deployStatus?.configured && showToolkitSection && (
              <>
                <div className="deploy-divider" />
                <div className="toolkit-stale">
                  Toolkit links {toolkitStale ? 'need refresh' : toolkitRefreshing ? 'refreshing' : 'unavailable'}
                  {deployStatus.toolkit && (
                    <span className="deploy-range">
                      {deployStatus.toolkit.checkedCount - deployStatus.toolkit.staleCount}/{deployStatus.toolkit.checkedCount} current
                    </span>
                  )}
                </div>
                <button
                  className="deploy-refresh"
                  onClick={refreshToolkitLinks}
                  disabled={toolkitRefreshing || !deployStatus.toolkit?.stale}
                >
                  {toolkitRefreshing ? 'Refreshing...' : 'Refresh toolkit links'}
                </button>
              </>
            )}
          </div>
        )}
        <div
          className={`queue-info${hasQueueInfo ? '' : ' queue-info-reserved'}`}
          title={queueTitle}
          aria-hidden={hasQueueInfo ? undefined : true}
        >
          <div className="queue-dots">
            {Array.from({ length: queueDotCount }, (_, i) => (
              <div
                key={i}
                className={`queue-dot ${hasQueueInfo && i === currentIndex ? 'current' : 'waiting'}`}
              />
            ))}
          </div>
          {compact ? (
            <span className="queue-text queue-text-compact">
              {currentIndex >= 0 ? `${currentIndex + 1}/${totalFindings}` : `${totalFindings}`}
            </span>
          ) : (
            <span className="queue-text">
              {currentIndex >= 0
                ? `Triaging ${currentIndex + 1} of ${totalFindings} findings`
                : `${totalFindings} finding${totalFindings !== 1 ? 's' : ''} waiting`}
            </span>
          )}
        </div>
      </div>
      <div className="topbar-right">
        <div className="metric-group topbar-spend-group">
          <span
            className={`topbar-spend${totalSpendUsd > 0 ? '' : ' topbar-spend-placeholder'}`}
            title={totalSpendUsd > 0 ? `Lifetime total across ${agents.length} task${agents.length !== 1 ? 's' : ''}` : undefined}
            aria-hidden={totalSpendUsd > 0 ? undefined : true}
          >
            {spendLabel}
          </span>
        </div>
        <div className="metric-group">
          <DndPill />
          <button
            className={`btn-icon operations-trigger${operationsOpen ? ' active' : ''}`}
            onClick={onOperations}
            title="Diagnostics"
            aria-label="Diagnostics"
            aria-pressed={operationsOpen}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 12h4l3-8 4 16 3-8h4" />
            </svg>
            {operationsNeedsAttention && <span className="operations-alert-dot" />}
          </button>
          {!compact && (
            <button className="btn-icon" onClick={onShowShortcuts} title="Help" aria-label="Help">
              ?
            </button>
          )}
          {!compact && (
            <button className="btn-icon" onClick={onOssView} title="OSS contribution productivity" aria-label="OSS contribution productivity">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="6" cy="4" r="2" />
                <circle cx="6" cy="20" r="2" />
                <circle cx="18" cy="12" r="2" />
                <path d="M6 6v12" />
                <path d="M8 12h8" />
              </svg>
            </button>
          )}
          {!compact && sweepSlot}
          {!compact && (
            <button className="btn-icon" onClick={onSchedules} title="Schedules" aria-label="Schedules">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="9" />
                <polyline points="12 7 12 12 15 14" />
              </svg>
            </button>
          )}
          {!compact && onCostComparison && (
            <button className="btn-icon" onClick={onCostComparison} title="Cost comparison (Claude vs Codex)" aria-label="Cost comparison">
              $
            </button>
          )}
          <button className="btn-icon" onClick={onSettings} title="Settings" aria-label="Settings">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
          <button className="btn-launch kookr-tour-target-launch" onClick={onLaunch}>+ Launch</button>
        </div>
      </div>
    </div>
  );
}
