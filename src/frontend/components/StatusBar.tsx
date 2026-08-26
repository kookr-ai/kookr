import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useKookrStore } from '../store/useStore.js';
import type { FocusZone } from '../store/useStore.js';
import type { QuotaStatus } from '../../shared/protocol.js';
import { useSoundPreference } from '../audio/sound.js';
import { useAudioAlertLog, type LocalAudioAlertDecision } from '../audio/audio-alert-log.js';
import {
  cpuSeverity,
  eventLoopSeverity,
  formatResourceDetails,
  formatResourcePercent,
  isResourceStatusStale,
  memorySeverity,
} from '../resource-status.js';
import { formatShortcutBinding, type ShortcutBindingMap } from '../../shared/contracts/shortcut-bindings.js';
import {
  TIME_TO_UNBLOCK_MIN_SAMPLES,
  formatTimeToUnblockChipLabel,
  formatTimeToUnblockChipTitle,
  type TimeToUnblockSnapshot,
} from '../../shared/contracts/time-to-unblock.js';
import { getLiveFrictionCalibration, getTimeToUnblock } from '../api/index.js';
import {
  formatLiveFrictionChipLabel,
  isLiveFrictionSnapshot,
  liveFrictionChipCounts,
  shouldShowLiveFrictionChip,
  LIVE_FRICTION_CHIP_TITLE,
  type LiveFrictionSnapshot,
} from './live-friction-chip.js';
import {
  formatFaaResidualAge,
  formatFaaResidualLabel,
  shouldShowFaaResidualPill,
} from './faa-residual-pill.js';
import {
  formatLaunchDepsLabel,
  formatLaunchDepsTitle,
  shouldShowLaunchDepsPill,
} from './launch-deps-pill.js';
import {
  formatPausedSchedulesLabel,
  formatPausedSchedulesTitle,
  shouldShowPausedSchedulesPill,
} from './paused-schedules-pill.js';
import {
  formatTimerOverdueLabel,
  formatTimerOverdueTitle,
  shouldShowTimerOverduePill,
} from './timer-overdue-pill.js';
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
   * Open the capacity settings section when the FAA residual pill is clicked
   * (issue #2082). Optional so isolated StatusBar tests need no App wiring.
   */
  onOpenCapacity?: () => void;
  /**
   * Open Diagnostics at the live-friction panel (issue #2596). Optional so
   * isolated StatusBar tests need no App wiring.
   */
  onOpenLiveFriction?: () => void;
  /**
   * Open Diagnostics when the overdue-timer pill is clicked (issue #2643).
   * Optional so isolated StatusBar tests need no App wiring.
   */
  onOpenDiagnostics?: () => void;
  reflectionSuggestion?: {
    sessionLabel: string;
    summary: string;
    totalInterventions: number;
    totalFindings: number;
  } | null;
  onReflect?: () => void;
  onDismissReflection?: () => void;
  shortcutBindings?: ShortcutBindingMap;
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

function formatRelativeAge(timestamp: string): string {
  const ageMs = Date.now() - new Date(timestamp).getTime();
  if (!Number.isFinite(ageMs) || ageMs < 0) return 'just now';
  if (ageMs < 60_000) return 'just now';
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function soundToggleTitle(soundOn: boolean, lastDecision: LocalAudioAlertDecision | null): string {
  const action = soundOn ? 'Mute alert sounds' : 'Unmute alert sounds';
  if (!lastDecision) return action;
  return `${action}. Last alert: ${lastDecision.source} -> ${lastDecision.outcome}, ${lastDecision.reason}, ${formatRelativeAge(lastDecision.timestamp)}`;
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

function ResourceDisplay({ compact }: { compact: boolean }) {
  const resourceStatus = useKookrStore((s) => s.resourceStatus);
  const receivedAtMs = useKookrStore((s) => s.resourceStatusReceivedAtMs);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!resourceStatus) return;
    const timer = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [resourceStatus]);

  if (!resourceStatus) return null;

  const stale = isResourceStatusStale(receivedAtMs, nowMs);
  const cpuLabel = formatResourcePercent(resourceStatus.host.cpuUsagePercent);
  const memoryLabel = formatResourcePercent(resourceStatus.host.memoryUsedPercent);
  const cpuClass = cpuSeverity(resourceStatus.host.cpuUsagePercent);
  const memoryClass = memorySeverity(resourceStatus);
  const loopClass = eventLoopSeverity(resourceStatus.server.eventLoopDelayP95Ms);
  const showLoopWarning = loopClass === 'high' || loopClass === 'critical';
  const details = formatResourceDetails(resourceStatus, nowMs);
  const ariaLabel = [
    `CPU ${cpuLabel}`,
    `RAM ${memoryLabel}`,
    ...details,
    stale ? 'Resource data is stale' : '',
  ].filter(Boolean).join('. ');

  return (
    <span className={`resource-status ${compact ? 'compact' : ''} ${stale ? 'stale' : ''} ${showLoopWarning ? `loop-${loopClass}` : ''}`}>
      <button
        type="button"
        className="resource-status-trigger"
        title={ariaLabel}
        aria-label={ariaLabel}
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
      >
        <span className={`resource-pill resource-${cpuClass}`}>CPU {cpuLabel}</span>
        <span className={`resource-pill resource-${memoryClass}`}>RAM {memoryLabel}</span>
        {showLoopWarning && (
          <span className={`resource-pill resource-${loopClass}`} title="Server event-loop p95 delay">
            Loop {resourceStatus.server.eventLoopDelayP95Ms === null ? '--' : `${Math.round(resourceStatus.server.eventLoopDelayP95Ms)}ms`}
          </span>
        )}
      </button>
      {open && (
        <span className="resource-status-popover" role="tooltip">
          {details.map((line) => (
            <span key={line}>{line}</span>
          ))}
        </span>
      )}
    </span>
  );
}

/**
 * Compact ops-health pills for smoke-tick failing streak, resourceWatchdog off
 * (issue #2037), chronic finishedAwaitingAck residual (issue #2082),
 * launch-dependency degradation (issue #2364), fail-closed paused
 * schedules (issue #2432), and overdue lifecycle timers (issue #2643).
 * Hidden when healthy / enabled / residual clear / no data yet.
 */
function OpsHealthPills({
  onOpenCapacity,
  onOpenDiagnostics,
}: {
  onOpenCapacity?: () => void;
  onOpenDiagnostics?: () => void;
}) {
  const prodSmokeTick = useKookrStore((s) => s.prodSmokeTick);
  const resourceWatchdog = useKookrStore((s) => s.resourceWatchdog);
  const capacityResidual = useKookrStore((s) => s.capacityResidual);
  const launchDependencies = useKookrStore((s) => s.launchDependencies);
  const pausedSchedules = useKookrStore((s) => s.pausedSchedules);
  const timerHealth = useKookrStore((s) => s.timerHealth);

  const smokeFailures = prodSmokeTick?.consecutiveFailures ?? 0;
  const showSmoke = smokeFailures >= 1;
  const showWatchdog = resourceWatchdog != null && resourceWatchdog.enabled === false;
  const faaCount = capacityResidual?.finishedAwaitingAck ?? 0;
  const faaAgeMs = capacityResidual?.oldestFinishedAwaitingAckAgeMs ?? null;
  const showFaa = capacityResidual != null && shouldShowFaaResidualPill(faaCount, faaAgeMs);
  const showLaunchDeps = shouldShowLaunchDepsPill(launchDependencies);
  const showPausedSchedules = shouldShowPausedSchedulesPill(pausedSchedules);
  const showTimerOverdue = shouldShowTimerOverduePill(timerHealth);

  if (
    !showSmoke
    && !showWatchdog
    && !showFaa
    && !showLaunchDeps
    && !showPausedSchedules
    && !showTimerOverdue
  ) return null;

  const smokeTitle = showSmoke
    ? [
        `Prod smoke tick failing for ${smokeFailures} consecutive hour${smokeFailures === 1 ? '' : 's'}`,
        prodSmokeTick?.failingChecks?.length
          ? `failing checks: ${prodSmokeTick.failingChecks.join(', ')}`
          : null,
        prodSmokeTick?.firstFailedAt
          ? `streak began ${prodSmokeTick.firstFailedAt}`
          : null,
        'See GET /api/health.prodSmokeTick',
      ].filter(Boolean).join(' · ')
    : '';

  const watchdogTitle = showWatchdog
    ? [
        resourceWatchdog?.pressureWhileDisabled
          ? 'Resource watchdog continuous monitoring is off under host pressure'
          : 'Resource watchdog continuous monitoring is off',
        resourceWatchdog?.lastDecision ? `lastDecision=${resourceWatchdog.lastDecision}` : null,
        resourceWatchdog?.pressureWhileDisabled && resourceWatchdog.pressureWhileDisabledReason
          ? resourceWatchdog.pressureWhileDisabledReason
          : null,
        'Set KOOKR_RESOURCE_WATCHDOG=1 for continuous sampling · GET /api/health.resourceWatchdog',
      ].filter(Boolean).join(' · ')
    : '';

  const faaLabel = showFaa ? formatFaaResidualLabel(faaCount, faaAgeMs) : '';
  const faaAgeLabel = showFaa ? formatFaaResidualAge(faaAgeMs) : null;
  const faaTitle = showFaa
    ? [
        `${faaCount} task${faaCount === 1 ? '' : 's'} finished and awaiting completion ack`,
        faaAgeLabel ? `oldest residual age ${faaAgeLabel}` : null,
        onOpenCapacity
          ? 'Capacity slots held with no forward progress — open capacity settings'
          : 'Capacity slots held with no forward progress',
        'See GET /api/health.capacity',
      ].filter(Boolean).join(' · ')
    : '';

  const launchDepsLabel =
    showLaunchDeps && launchDependencies ? formatLaunchDepsLabel(launchDependencies) : '';
  const launchDepsTitle =
    showLaunchDeps && launchDependencies ? formatLaunchDepsTitle(launchDependencies) : '';

  const pausedSchedulesLabel =
    showPausedSchedules && pausedSchedules ? formatPausedSchedulesLabel(pausedSchedules) : '';
  const pausedSchedulesTitle =
    showPausedSchedules && pausedSchedules ? formatPausedSchedulesTitle(pausedSchedules) : '';

  const timerOverdueLabel =
    showTimerOverdue && timerHealth ? formatTimerOverdueLabel(timerHealth) : '';
  const timerOverdueTitle =
    showTimerOverdue && timerHealth
      ? formatTimerOverdueTitle(timerHealth, Boolean(onOpenDiagnostics))
      : '';

  return (
    <span className="ops-health-pills" data-testid="ops-health-pills">
      {showSmoke && (
        <span
          className="ops-health-pill ops-health-smoke"
          data-testid="ops-health-smoke-pill"
          title={smokeTitle}
          role="status"
        >
          Smoke: fail×{smokeFailures}
        </span>
      )}
      {showWatchdog && (
        <span
          className="ops-health-pill ops-health-watchdog"
          data-testid="ops-health-watchdog-pill"
          title={watchdogTitle}
          role="status"
        >
          Watchdog: off
        </span>
      )}
      {showFaa && (
        onOpenCapacity ? (
          <button
            type="button"
            className="ops-health-pill ops-health-faa"
            data-testid="ops-health-faa-pill"
            title={faaTitle}
            aria-label={`${faaLabel}. Open capacity settings`}
            onClick={onOpenCapacity}
          >
            {faaLabel}
          </button>
        ) : (
          <span
            className="ops-health-pill ops-health-faa"
            data-testid="ops-health-faa-pill"
            title={faaTitle}
            role="status"
          >
            {faaLabel}
          </span>
        )
      )}
      {showLaunchDeps && (
        <span
          className="ops-health-pill ops-health-launch-deps"
          data-testid="ops-health-launch-deps-pill"
          title={launchDepsTitle}
          aria-label={launchDepsTitle}
          role="status"
        >
          {launchDepsLabel}
        </span>
      )}
      {showPausedSchedules && (
        <span
          className="ops-health-pill ops-health-paused-schedules"
          data-testid="ops-health-paused-schedules-pill"
          title={pausedSchedulesTitle}
          role="status"
        >
          {pausedSchedulesLabel}
        </span>
      )}
      {showTimerOverdue && (
        onOpenDiagnostics ? (
          <button
            type="button"
            className="ops-health-pill ops-health-timer-overdue"
            data-testid="ops-health-timer-overdue-pill"
            title={timerOverdueTitle}
            aria-label={`${timerOverdueLabel}. Open Diagnostics`}
            onClick={onOpenDiagnostics}
          >
            {timerOverdueLabel}
          </button>
        ) : (
          <span
            className="ops-health-pill ops-health-timer-overdue"
            data-testid="ops-health-timer-overdue-pill"
            title={timerOverdueTitle}
            role="status"
          >
            {timerOverdueLabel}
          </span>
        )
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
  onOpenCapacity,
  onOpenLiveFriction,
  onOpenDiagnostics,
  reflectionSuggestion,
  onReflect,
  onDismissReflection,
  shortcutBindings,
}: Props) {
  const focusZone = useKookrStore((s) => s.focusZone);
  const sttUrl = useKookrStore((s) => s.sttUrl);
  const quotaStatus = useKookrStore((s) => s.quotaStatus);
  const achievements = useKookrStore((s) => s.achievements);
  const toggleAchievementsPanel = useKookrStore((s) => s.toggleAchievementsPanel);
  const zoneLabel = ZONE_LABELS[focusZone];
  const sound = useSoundPreference();
  const audioAlertSnapshot = useAudioAlertLog(1);
  const soundOn = sound.enabled;
  const soundTitle = soundToggleTitle(soundOn, audioAlertSnapshot.lastDecision);
  const [timeToUnblock, setTimeToUnblock] = useState<TimeToUnblockSnapshot | null>(null);
  const [liveFriction, setLiveFriction] = useState<LiveFrictionSnapshot | null>(null);
  const [, setOldestWaitTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const body = await getTimeToUnblock();
        if (!cancelled) setTimeToUnblock(body);
      } catch {
        if (!cancelled) setTimeToUnblock(null);
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
    let cancelled = false;
    const load = async () => {
      try {
        const body = await getLiveFrictionCalibration<unknown>();
        if (!cancelled) setLiveFriction(isLiveFrictionSnapshot(body) ? body : null);
      } catch {
        if (!cancelled) setLiveFriction(null);
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

  const showUnblockChip = timeToUnblock !== null
    && timeToUnblock.sampleCount >= TIME_TO_UNBLOCK_MIN_SAMPLES
    && timeToUnblock.medianMs !== null
    && Number.isFinite(timeToUnblock.medianMs);

  const oldestWaitLabel = findings > 0
    ? formatOldestFindingWait(oldestFindingWaitStartedAt)
    : null;

  const showFrictionChip = shouldShowLiveFrictionChip(liveFriction);
  const frictionCounts = liveFriction ? liveFrictionChipCounts(liveFriction) : null;
  const frictionLabel = frictionCounts ? formatLiveFrictionChipLabel(frictionCounts) : '';
  const showCompletedChip = shouldShowCompletedInWindowChip(completedLast24h);
  const showLaunchedChip = shouldShowLaunchedInWindowChip(launchedLast24h);

  const hasNewAchievements = useMemo(() => {
    const lastOpen = typeof localStorage !== 'undefined'
      ? Number(localStorage.getItem('kookr-last-achievement-panel-open')) || Date.now()
      : Date.now();
    return Object.values(achievements).some(ts => new Date(ts).getTime() > lastOpen);
  }, [achievements]);

  const toggleSound = useCallback(() => {
    sound.setEnabled(!sound.enabled);
  }, [sound]);

  return (
    <div className={`statusbar${compact ? ' compact' : ''}`}>
      <span className="statusbar-left">
        {zoneLabel && <span className="focus-zone-pill">{zoneLabel}</span>}
        <span>{total} task{total !== 1 ? 's' : ''} · {findings} finding{findings !== 1 ? 's' : ''}</span>
        {showCompletedChip && (
          <span
            className="completed-24h-pill"
            data-testid="completed-24h-chip"
            role="status"
            title={formatCompletedInWindowChipTitle(completedLast24h)}
          >
            {formatCompletedInWindowChipLabel(completedLast24h)}
          </span>
        )}
        {showLaunchedChip && (
          <span
            className="launched-24h-pill"
            data-testid="launched-24h-chip"
            role="status"
            title={formatLaunchedInWindowChipTitle(launchedLast24h)}
          >
            {formatLaunchedInWindowChipLabel(launchedLast24h)}
          </span>
        )}
        {oldestWaitLabel && (
          <span
            className="oldest-finding-wait-pill"
            data-testid="oldest-finding-wait-chip"
            role="status"
            title="Age of the oldest unanswered finding — live wait, not the historical median"
          >
            oldest {oldestWaitLabel}
          </span>
        )}
        {showUnblockChip && timeToUnblock?.medianMs != null && (
          <span
            className="time-to-unblock-pill"
            data-testid="time-to-unblock-chip"
            role="status"
            title={formatTimeToUnblockChipTitle(
              timeToUnblock.sampleCount,
              timeToUnblock.medianMs,
              timeToUnblock.windowMs,
            )}
          >
            {formatTimeToUnblockChipLabel(
              timeToUnblock.sampleCount,
              timeToUnblock.medianMs,
              timeToUnblock.windowMs,
            )}
          </span>
        )}
        {showFrictionChip && frictionCounts && (
          onOpenLiveFriction ? (
            <button
              type="button"
              className="live-friction-pill"
              data-testid="live-friction-chip"
              title={LIVE_FRICTION_CHIP_TITLE}
              aria-label={`${frictionLabel}. Open live friction diagnostics. Diagnostics only, does not reorder findings.`}
              onClick={onOpenLiveFriction}
            >
              {frictionLabel}
            </button>
          ) : (
            <span
              className="live-friction-pill"
              data-testid="live-friction-chip"
              role="status"
              title={LIVE_FRICTION_CHIP_TITLE}
            >
              {frictionLabel}
            </span>
          )
        )}
        <ResourceDisplay compact={compact} />
        {quotaStatus && <QuotaDisplay quota={quotaStatus} />}
        <OpsHealthPills onOpenCapacity={onOpenCapacity} onOpenDiagnostics={onOpenDiagnostics} />
        {sttUrl && <span className="stt-status-pill" title="Speech-to-text enabled">STT</span>}
        <button
          className={`btn-sound-toggle ${soundOn ? '' : 'muted'}`}
          onClick={toggleSound}
          title={soundTitle}
          aria-label={soundOn ? 'Mute alert sounds' : 'Unmute alert sounds'}
        >
          {soundOn ? '\u{1F50A}' : '\u{1F507}'}
        </button>
        <button
          className="btn-trophy"
          onClick={toggleAchievementsPanel}
          title={`Achievements${shortcutBindings ? ` (${formatShortcutBinding(shortcutBindings.toggle_achievements)})` : ''}`}
          aria-label="Achievements"
        >
          {'\u{1F3C6}'}
          {hasNewAchievements && <span className="trophy-badge-dot" />}
        </button>
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
      {compact && (
        <span className="statusbar-compact-actions">
          <button className="statusbar-action" onClick={onShowShortcuts}>Shortcuts</button>
        </span>
      )}
    </div>
  );
}
