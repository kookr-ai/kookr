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
  formatFaaResidualAge,
  formatFaaResidualLabel,
  shouldShowFaaResidualPill,
} from './faa-residual-pill.js';

interface Props {
  findings: number;
  total: number;
  compact?: boolean;
  onShowShortcuts: () => void;
  /**
   * Open the capacity settings section when the FAA residual pill is clicked
   * (issue #2082). Optional so isolated StatusBar tests need no App wiring.
   */
  onOpenCapacity?: () => void;
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

function QuotaDisplay({ quota }: { quota: QuotaStatus }) {
  const staleSec = Math.floor((Date.now() - quota.updatedAt) / 1000);
  const stale = staleSec > 300; // >5 min = stale
  // The raw "5h: 31% (1h 56m) · 7d: 8%" pills are cryptic — spell out that
  // these are the Claude plan's rolling rate-limit windows.
  const explainer = 'Claude plan rate-limit usage — 5h: rolling 5-hour window (resets in the time shown) · 7d: rolling 7-day window';
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
 * (issue #2037), and chronic finishedAwaitingAck residual (issue #2082).
 * Hidden when healthy / enabled / residual clear / no data yet.
 */
function OpsHealthPills({ onOpenCapacity }: { onOpenCapacity?: () => void }) {
  const prodSmokeTick = useKookrStore((s) => s.prodSmokeTick);
  const resourceWatchdog = useKookrStore((s) => s.resourceWatchdog);
  const capacityResidual = useKookrStore((s) => s.capacityResidual);

  const smokeFailures = prodSmokeTick?.consecutiveFailures ?? 0;
  const showSmoke = smokeFailures >= 1;
  const showWatchdog = resourceWatchdog != null && resourceWatchdog.enabled === false;
  const faaCount = capacityResidual?.finishedAwaitingAck ?? 0;
  const faaAgeMs = capacityResidual?.oldestFinishedAwaitingAckAgeMs ?? null;
  const showFaa = capacityResidual != null && shouldShowFaaResidualPill(faaCount, faaAgeMs);

  if (!showSmoke && !showWatchdog && !showFaa) return null;

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
    </span>
  );
}

export function StatusBar({
  findings,
  total,
  compact = false,
  onShowShortcuts,
  onOpenCapacity,
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
        <ResourceDisplay compact={compact} />
        {quotaStatus && <QuotaDisplay quota={quotaStatus} />}
        <OpsHealthPills onOpenCapacity={onOpenCapacity} />
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
