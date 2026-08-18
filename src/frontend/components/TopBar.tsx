import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useKookrStore } from '../store/useStore.js';
import { DndPill } from './DndPill.js';
import { FollowPill } from './FollowPill.js';
import { formatCost } from '../presentation.js';
import {
  TOOLKIT_MARKETPLACE_SLUG,
  marketplaceNameFromPluginId,
  pluginUpdateCommands,
} from '../../shared/contracts/plugin-version.js';
import {
  commandPaletteHint,
  detectShortcutPlatform,
  getDefaultShortcutBindings,
  type ShortcutBindingMap,
} from '../../shared/contracts/shortcut-bindings.js';
import {
  getDeployStatus,
  triggerDeploy as requestDeploy,
  refreshToolkitLinks as requestToolkitRefresh,
  updateToolkitPlugin as requestPluginUpdate,
  apiBlackoutTier,
  formatBlackoutSeconds,
  type DeployStatus,
} from '../api/index.js';
import { loadDeployIntent } from '../store/deploy-intent-storage.js';

interface Props {
  findings: number;
  currentIndex: number;
  totalFindings: number;
  /** Focus the finding the queue indicator currently names. Wired to the same
   *  selection action the findings rail uses; no-op when there are no findings
   *  (the indicator is inert in that reserved/empty state). */
  onFocusQueue?: () => void;
  compact?: boolean;
  onLaunch: () => void;
  /** Open the command palette — the single entry point for the actions that
   *  previously lived as their own top-bar icons (Schedules, Settings, Help,
   *  OSS, Bug report, Terminal focus, Cost comparison, …). */
  onCommandPalette: () => void;
  onOperations: () => void;
  operationsOpen?: boolean;
  onCoordinatorFindings: () => void;
  coordinatorFindingsOpen?: boolean;
  /** Terminal-focus stays a quick icon: in focus mode the chrome is hidden, so
   *  this toggle is the visible exit affordance and the stable focus target. */
  terminalFocusMode?: boolean;
  terminalFocusAvailable?: boolean;
  terminalFocusTriggerRef?: React.RefObject<HTMLButtonElement | null>;
  onTerminalFocusToggle: () => void;
  /** Read-only viewer: hide mutation entry points (e.g. Launch) (#811). */
  readOnly?: boolean;
  /** When true, spotlight the command-palette trigger (driven by the
   *  scheduled-tasks discovery hint — Schedules now lives in the palette). */
  scheduleHintActive?: boolean;
  /** Resolved platform/user bindings for FollowPill and related hints. */
  shortcutBindings?: ShortcutBindingMap;
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

export function TopBar({
  findings,
  currentIndex,
  totalFindings,
  onFocusQueue,
  compact = false,
  onLaunch,
  onCommandPalette,
  onOperations,
  operationsOpen = false,
  onCoordinatorFindings,
  coordinatorFindingsOpen = false,
  terminalFocusMode = false,
  terminalFocusAvailable = true,
  terminalFocusTriggerRef,
  onTerminalFocusToggle,
  readOnly = false,
  scheduleHintActive = false,
  shortcutBindings = getDefaultShortcutBindings(detectShortcutPlatform()),
}: Props) {
  const {
    connected,
    buildInfo,
    serverStartedAt,
    totalSpendUsd,
    circuitBreakers,
    diagnosticReport,
    coordinator,
    deploying,
    setDeploying,
  } = useKookrStore();
  const paletteHint = commandPaletteHint(detectShortcutPlatform());
  const [showPopover, setShowPopover] = useState(false);
  const [deployStatus, setDeployStatus] = useState<DeployStatus | null>(null);
  const [deployLoading, setDeployLoading] = useState(false);
  const [toolkitRefreshing, setToolkitRefreshing] = useState(false);
  const [pluginUpdating, setPluginUpdating] = useState(false);
  const [pluginUpdateMessage, setPluginUpdateMessage] = useState<string | null>(null);
  const [pluginUpdateError, setPluginUpdateError] = useState<string | null>(null);
  const preDeployCommitRef = useRef<string | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Restore sticky pre-deploy commit after remount so completion clear still works.
  useEffect(() => {
    const intent = loadDeployIntent();
    if (intent?.preDeployCommit) {
      preDeployCommitRef.current = intent.preDeployCommit;
    }
  }, []);

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
      const { ok, body: data } = await getDeployStatus();
      if (ok) {
        setDeployStatus(data);
        if (data.deploying) {
          setDeploying(true);
        } else if (useKookrStore.getState().deploying) {
          // Clear sticky intent once status reports idle — but not while we still
          // have a pre-deploy commit matching the live build (in-flight button
          // deploy / race with a concurrent status poll on the old process).
          const pre = preDeployCommitRef.current;
          const current = useKookrStore.getState().buildInfo?.commitShort;
          if (!pre || (current && current !== 'dev' && current !== pre)) {
            setDeploying(false);
            preDeployCommitRef.current = null;
          }
        }
      } else {
        setDeployStatus({ ...data, error: data.error ?? 'Failed to check status' });
      }
    } catch {
      setDeployStatus({ configured: false, error: 'Server unreachable' });
    } finally {
      setDeployLoading(false);
    }
  }, [setDeploying]);

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
  }, [connected, buildInfo, deploying, setDeploying]);

  async function triggerDeploy() {
    const preCommit = buildInfo?.commitShort ?? null;
    preDeployCommitRef.current = preCommit;
    setDeploying(true, preCommit);
    try {
      const { ok, body: data } = await requestDeploy();
      if (!ok) {
        setDeploying(false);
        preDeployCommitRef.current = null;
        setDeployStatus((prev) => prev ? { ...prev, error: data?.error ?? 'Deploy failed' } : null);
      }
    } catch {
      // Connection may drop during deploy — that's expected
    }
  }

  async function refreshToolkitLinks() {
    setToolkitRefreshing(true);
    try {
      const { ok, body: data } = await requestToolkitRefresh();
      if (ok) {
        setDeployStatus((prev) => prev ? { ...prev, toolkit: data?.toolkit } : prev);
      } else {
        setDeployStatus((prev) => prev ? { ...prev, ...data, error: data?.error ?? 'Toolkit refresh failed' } : {
          configured: false,
          ...data,
          error: data?.error ?? 'Toolkit refresh failed',
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

  async function updateToolkitPlugin() {
    setPluginUpdating(true);
    setPluginUpdateMessage(null);
    setPluginUpdateError(null);
    try {
      const { ok, body: data } = await requestPluginUpdate();
      if (ok) {
        setDeployStatus((prev) => prev ? { ...prev, plugin: data?.plugin } : prev);
        setPluginUpdateMessage('Toolkit plugin updated. Restart Claude Code sessions to load it.');
      } else {
        if (data?.plugin) setDeployStatus((prev) => prev ? { ...prev, plugin: data.plugin } : prev);
        setPluginUpdateError(data?.error ?? 'Plugin update failed');
      }
    } catch {
      setPluginUpdateError('Plugin update failed');
    } finally {
      setPluginUpdating(false);
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
  const pluginStale = Boolean(deployStatus?.plugin?.stale);
  const pluginNotInstalled = Boolean(
    deployStatus?.plugin &&
      deployStatus.plugin.installedVersion === null &&
      deployStatus.plugin.availableVersion !== null,
  );
  // The marketplace name is the part after `@` in the plugin id
  // ("kookr-toolkit@kookr" → "kookr"); used in the `/plugin marketplace update`
  // hint. Falls back to the default marketplace name if the id is malformed.
  const pluginId = deployStatus?.plugin?.pluginId ?? 'kookr-toolkit@kookr';
  const pluginMarketplace = marketplaceNameFromPluginId(pluginId);
  const pluginManualCommands = pluginUpdateCommands(pluginId, pluginMarketplace);
  const hasUpdates =
    (!onNonProdPort && deployStatus?.configured && deployStatus.available && !deploying) ||
    toolkitStale ||
    pluginStale ||
    pluginNotInstalled;
  const operationsNeedsAttention =
    circuitBreakers.some((breaker) => breaker.state !== 'closed') ||
    Boolean(diagnosticReport?.findings.length);
  const coordinatorFindingCount = coordinator?.findings.length ?? 0;
  const coordinatorFindingsLabel = coordinatorFindingCount > 0
    ? `Coordinator findings, ${coordinatorFindingCount} finding${coordinatorFindingCount === 1 ? '' : 's'}`
    : 'Coordinator findings';
  const hasQueueInfo = totalFindings > 0;
  const queueTitle = hasQueueInfo
    ? currentIndex >= 0
      ? `Triaging ${currentIndex + 1} of ${totalFindings} findings`
      : `${totalFindings} finding${totalFindings !== 1 ? 's' : ''} waiting`
    : undefined;
  const queueDotCount = Math.max(totalFindings, 1);
  const spendLabel = totalSpendUsd > 0 ? formatCost(totalSpendUsd) : '$0.00';
  const connectionLabel = connected ? 'Dashboard WebSocket connected' : 'Dashboard WebSocket disconnected';
  const lastRestart = deployStatus?.lastRestart;
  const blackoutTier = lastRestart ? apiBlackoutTier(lastRestart.apiBlackoutSeconds) : null;

  return (
    <div className={`topbar kookr-tour-target-layout${compact ? ' compact' : ''}`}>
      <div className="topbar-left">
        <span className="logo">
          <img src="/kookr-mark-32.png" alt="" aria-hidden="true" width={18} height={18} className="logo-mark" />
          KOOKR
        </span>
        <button
          type="button"
          className={`version-badge ${isDev ? 'dev' : ''} ${hasUpdates ? 'has-updates' : ''}`}
          onClick={() => setShowPopover((v) => !v)}
          aria-label="Build info"
          aria-expanded={showPopover}
          aria-controls="version-popover"
        >
          <span
            className={`health-dot ${connected ? 'health-dot-connected' : 'health-dot-disconnected'}`}
            role="img"
            aria-label={connectionLabel}
            title={connectionLabel}
          />
          {deploying && <span className="deploy-spinner" />}
          {versionLabel}
          {!compact && !isDev && builtAgo && <span className="version-built"> · {builtAgo}</span>}
          {hasUpdates && <span className="update-dot" />}
        </button>
        {showPopover && (
          <div className="version-popover" id="version-popover" ref={popoverRef}>
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

            {/* Last restart blackout + phase timings (issue #1979). Optional field
                from #1973; omit entire block when API has no lastRestart. */}
            {lastRestart && blackoutTier && (
              <>
                <div className="deploy-divider" />
                <div
                  className={`deploy-blackout deploy-blackout--${blackoutTier}`}
                  data-testid="deploy-last-restart"
                  role="status"
                  aria-label={`API blackout ${formatBlackoutSeconds(lastRestart.apiBlackoutSeconds)}; ideal under 1 second, SLO under 5 seconds; last restart ${formatDateTime(lastRestart.at)}`}
                  title={`Ideal <1s · SLO max <5s · last restart ${formatDateTime(lastRestart.at)}`}
                >
                  <span className="deploy-blackout-label">API blackout</span>{' '}
                  <strong data-testid="deploy-api-blackout">
                    {formatBlackoutSeconds(lastRestart.apiBlackoutSeconds)}
                  </strong>
                  <span className="deploy-range">
                    ideal &lt;1s · SLO &lt;5s · {timeAgo(lastRestart.at)}
                  </span>
                </div>
                <div className="deploy-phase-timings" data-testid="deploy-phase-timings">
                  M1 {formatBlackoutSeconds(lastRestart.m1Seconds)}
                  {' · '}
                  M2 {formatBlackoutSeconds(lastRestart.m2Seconds)}
                  {' · '}
                  dominant {lastRestart.dominantPhase}
                </div>
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

            {deployStatus?.plugin && (pluginNotInstalled || pluginStale || pluginUpdating || pluginUpdateMessage || pluginUpdateError) && (
              <>
                <div className="deploy-divider" />
                {pluginNotInstalled ? (
                  <>
                    <div className="toolkit-stale">
                      Toolkit plugin not installed
                      {deployStatus.plugin.availableVersion && (
                        <span className="deploy-range">v{deployStatus.plugin.availableVersion} available</span>
                      )}
                    </div>
                    <div className="version-row deploy-checking">
                      Install in Claude Code: <code>/plugin marketplace add {TOOLKIT_MARKETPLACE_SLUG}</code> then{' '}
                      <code>/plugin install {deployStatus.plugin.pluginId}</code>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="toolkit-stale">
                      {pluginStale ? 'Toolkit plugin update available' : 'Toolkit plugin'}
                      {deployStatus.plugin.installedVersion && deployStatus.plugin.availableVersion && (
                        <span className="deploy-range">
                          {pluginStale
                            ? `${deployStatus.plugin.installedVersion} -> ${deployStatus.plugin.availableVersion}`
                            : `v${deployStatus.plugin.installedVersion} installed`}
                        </span>
                      )}
                    </div>
                    {pluginUpdateMessage && (
                      <div className="deploy-status-row" role="status" aria-live="polite">
                        {pluginUpdateMessage}
                      </div>
                    )}
                    {pluginUpdateError && (
                      <div className="version-row deploy-error" role="alert">{pluginUpdateError}</div>
                    )}
                    {pluginStale && (
                      <button
                        className="btn-deploy"
                        onClick={updateToolkitPlugin}
                        disabled={pluginUpdating}
                      >
                        {pluginUpdating ? 'Updating plugin...' : 'Update plugin'}
                      </button>
                    )}
                    <details className="deploy-help" open={Boolean(pluginUpdateError)}>
                      <summary>Manual commands</summary>
                      <div className="version-row">
                        In Claude Code: <code>{pluginManualCommands.slash[0]}</code> then{' '}
                        <code>{pluginManualCommands.slash[1]}</code>
                      </div>
                      <div className="version-row">
                        Terminal: <code>{pluginManualCommands.cli[0]}</code> then{' '}
                        <code>{pluginManualCommands.cli[1]}</code>
                      </div>
                    </details>
                  </>
                )}
              </>
            )}
          </div>
        )}
        <button
          type="button"
          className={`queue-info${hasQueueInfo ? '' : ' queue-info-reserved'}`}
          title={queueTitle}
          aria-label={queueTitle}
          aria-hidden={hasQueueInfo ? undefined : true}
          disabled={!hasQueueInfo}
          onClick={onFocusQueue}
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
        </button>
      </div>
      <div className="topbar-right">
        <div className="metric-group topbar-spend-group">
          <span
            className={`topbar-spend${totalSpendUsd > 0 ? '' : ' topbar-spend-placeholder'}`}
            title={totalSpendUsd > 0 ? 'All-time agent spend recorded by this Kookr server — includes cleared and deleted tasks' : undefined}
            aria-hidden={totalSpendUsd > 0 ? undefined : true}
          >
            {spendLabel}
          </span>
        </div>
        <div className="metric-group">
          <FollowPill shortcutBindings={shortcutBindings} />
          <DndPill />
          <button
            type="button"
            className={`command-trigger${compact ? ' command-trigger--compact' : ''}${scheduleHintActive ? ' schedule-hint-spotlight' : ''}`}
            onClick={onCommandPalette}
            title={`Search actions & tasks (${paletteHint})`}
            aria-label="Search actions and tasks"
            aria-keyshortcuts="Meta+K Control+K"
            data-testid="command-trigger"
          >
            <span className="command-trigger-mag" aria-hidden="true">🔍</span>
            {!compact && <span className="command-trigger-label">Search actions &amp; tasks</span>}
            <kbd className="command-trigger-kbd" aria-hidden="true">{paletteHint}</kbd>
          </button>
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
          {!compact && terminalFocusAvailable && (
            <button
              ref={terminalFocusTriggerRef}
              className={`btn-icon terminal-focus-trigger${terminalFocusMode ? ' active' : ''}`}
              onClick={onTerminalFocusToggle}
              title="Terminal focus"
              aria-label="Terminal focus"
              aria-pressed={terminalFocusMode}
            >
              <span aria-hidden="true">&gt;_</span>
            </button>
          )}
          {!compact && (
            <button
              className={`btn-icon coordinator-findings-trigger${coordinatorFindingsOpen ? ' active' : ''}`}
              onClick={onCoordinatorFindings}
              title="Coordinator findings"
              aria-label={coordinatorFindingsLabel}
              aria-pressed={coordinatorFindingsOpen}
            >
              ⛓
              {coordinatorFindingCount > 0 && <span className="coordinator-nav-badge">{coordinatorFindingCount}</span>}
            </button>
          )}
          {!readOnly && (
            <button className="btn-launch kookr-tour-target-launch" onClick={onLaunch}>+ Launch</button>
          )}
        </div>
      </div>
    </div>
  );
}
