import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useKookrStore } from '../store/useStore.js';
import { useSoundPreference } from '../audio/sound.js';
import { useAudioAlertLog, type LocalAudioAlertDecision } from '../audio/audio-alert-log.js';
import {
  cpuSeverity,
  eventLoopSeverity,
  formatResourceDetails,
  formatResourcePercent,
  isResourceStatusStale,
  memorySeverity,
  RESOURCE_STATUS_STALE_AFTER_MS,
} from '../resource-status.js';
import { formatShortcutBinding, type ShortcutBindingMap } from '../../shared/contracts/shortcut-bindings.js';
import {
  TIME_TO_UNBLOCK_MIN_SAMPLES,
  formatTimeToUnblockChipLabel,
  formatTimeToUnblockChipTitle,
  type TimeToUnblockSnapshot,
} from '../../shared/contracts/time-to-unblock.js';
import { getLiveFrictionCalibration, getTimeToUnblock } from '../api/index.js';
import type {
  CapacityResidualStatus,
  LaunchDependenciesStatus,
  PausedSchedulesStatus,
  ProdSmokeTickStatus,
  ResourceWatchdogStatus,
  TimerHealthStatus,
} from '../store/store-types.js';
import type { SystemResourceStatus } from '../../shared/protocol.js';
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

/*
 * System detail (issue #3561 slice 2, "quiet chrome"). The readouts that used
 * to sit in the status bar at all times (host resources, ops-health pills,
 * time-to-unblock, live friction, speech-to-text, sound and achievements) now
 * live behind the System indicator in the top bar. The status bar keeps only
 * counts, spend and quota.
 *
 * Hiding a readout must not hide a warning: `systemAttentionReasons` lists
 * every degraded condition the hidden readouts can show, and the indicator
 * turns amber (waiting on you) while that list is non-empty. It reads the
 * store directly so the signal stays live while the detail is closed.
 */

export interface SystemAttentionInput {
  prodSmokeTick?: ProdSmokeTickStatus | null;
  resourceWatchdog?: ResourceWatchdogStatus | null;
  capacityResidual?: CapacityResidualStatus | null;
  launchDependencies?: LaunchDependenciesStatus | null;
  pausedSchedules?: PausedSchedulesStatus | null;
  timerHealth?: TimerHealthStatus | null;
  resourceStatus?: SystemResourceStatus | null;
  /** True when the resource sample is too old to trust (then it raises nothing). */
  resourceStale?: boolean;
}

/** Short reasons, one per degraded condition; empty when the system is healthy. */
export function systemAttentionReasons(input: SystemAttentionInput): string[] {
  const reasons: string[] = [];
  const smokeFailures = input.prodSmokeTick?.consecutiveFailures ?? 0;
  if (smokeFailures >= 1) reasons.push('prod smoke tick failing');
  // The watchdog is off by default, so "off" alone is the normal state and
  // stays a passive readout in the detail; it needs a look only when host
  // pressure is building while it is off.
  if (input.resourceWatchdog?.enabled === false && input.resourceWatchdog.pressureWhileDisabled) {
    reasons.push('host pressure while the resource watchdog is off');
  }
  const residual = input.capacityResidual;
  if (residual != null && shouldShowFaaResidualPill(
    residual.finishedAwaitingAck ?? 0,
    residual.oldestFinishedAwaitingAckAgeMs ?? null,
  )) {
    reasons.push('finished tasks holding capacity');
  }
  if (shouldShowLaunchDepsPill(input.launchDependencies ?? null)) reasons.push('launch dependencies degraded');
  if (shouldShowPausedSchedulesPill(input.pausedSchedules ?? null)) reasons.push('schedules paused');
  if (shouldShowTimerOverduePill(input.timerHealth ?? null)) reasons.push('lifecycle timers overdue');
  const resources = input.resourceStatus;
  if (resources && !input.resourceStale) {
    const hot = (severity: string) => severity === 'high' || severity === 'critical';
    if (hot(cpuSeverity(resources.host.cpuUsagePercent))) reasons.push('CPU high');
    if (hot(memorySeverity(resources))) reasons.push('memory high');
    if (hot(eventLoopSeverity(resources.server.eventLoopDelayP95Ms))) reasons.push('server event loop slow');
  }
  return reasons;
}

/**
 * Whether the latest resource sample is stale, re-evaluated as time passes.
 * One timeout fires when the current sample crosses the stale threshold, so a
 * frozen sample stops raising attention without a new store update and without
 * a per-second render loop in the top bar.
 */
export function useResourceStatusStale(): boolean {
  const receivedAtMs = useKookrStore((s) => s.resourceStatusReceivedAtMs);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const stale = isResourceStatusStale(receivedAtMs, nowMs);

  useEffect(() => {
    if (receivedAtMs == null) return;
    const now = Date.now();
    // A new sample arrived: re-read the clock so a fresh sample is not judged
    // against an old `nowMs`.
    if (isResourceStatusStale(receivedAtMs, now) !== stale) {
      setNowMs(now);
      return;
    }
    if (stale) return;
    const delayMs = receivedAtMs + RESOURCE_STATUS_STALE_AFTER_MS - now + 1;
    const timer = setTimeout(() => setNowMs(Date.now()), Math.max(0, delayMs));
    return () => clearTimeout(timer);
  }, [receivedAtMs, stale]);

  return stale;
}

/** Live attention reasons for the System indicator, read from the store. */
export function useSystemAttentionReasons(): string[] {
  const prodSmokeTick = useKookrStore((s) => s.prodSmokeTick);
  const resourceWatchdog = useKookrStore((s) => s.resourceWatchdog);
  const capacityResidual = useKookrStore((s) => s.capacityResidual);
  const launchDependencies = useKookrStore((s) => s.launchDependencies);
  const pausedSchedules = useKookrStore((s) => s.pausedSchedules);
  const timerHealth = useKookrStore((s) => s.timerHealth);
  const resourceStatus = useKookrStore((s) => s.resourceStatus);
  const resourceStale = useResourceStatusStale();
  return useMemo(() => systemAttentionReasons({
    prodSmokeTick,
    resourceWatchdog,
    capacityResidual,
    launchDependencies,
    pausedSchedules,
    timerHealth,
    resourceStatus,
    resourceStale,
  }), [
    prodSmokeTick,
    resourceWatchdog,
    capacityResidual,
    launchDependencies,
    pausedSchedules,
    timerHealth,
    resourceStatus,
    resourceStale,
  ]);
}

export interface SystemQuietNotesInput {
  resourceStatus?: SystemResourceStatus | null;
  resourceStale?: boolean;
  soundMuted?: boolean;
}

/**
 * Non-urgent states that the status bar used to show at rest: muted alert
 * sounds and "elevated" (below high) CPU or RAM. They are not "waiting on
 * you", so they never turn System amber; the indicator shows them neutrally
 * (a muted glyph, a grey dot) and names them in its label.
 */
export function systemQuietNotes(input: SystemQuietNotesInput): string[] {
  const notes: string[] = [];
  if (input.soundMuted) notes.push('alert sounds muted');
  const resources = input.resourceStatus;
  if (resources && !input.resourceStale) {
    if (cpuSeverity(resources.host.cpuUsagePercent) === 'elevated') notes.push('CPU elevated');
    if (memorySeverity(resources) === 'elevated') notes.push('memory elevated');
  }
  return notes;
}

/** Live quiet notes for the System indicator, read from the store. */
export function useSystemQuietNotes(): string[] {
  const resourceStatus = useKookrStore((s) => s.resourceStatus);
  const resourceStale = useResourceStatusStale();
  const soundMuted = !useSoundPreference().enabled;
  return useMemo(
    () => systemQuietNotes({ resourceStatus, resourceStale, soundMuted }),
    [resourceStatus, resourceStale, soundMuted],
  );
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
 * schedules (issue #2432 / click-through #3399), and overdue lifecycle
 * timers (issue #2643). Hidden when healthy / enabled / residual clear /
 * no data yet.
 */
function OpsHealthPills({
  onOpenCapacity,
  onOpenDiagnostics,
  onOpenSchedules,
}: {
  onOpenCapacity?: () => void;
  onOpenDiagnostics?: () => void;
  onOpenSchedules?: () => void;
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
    showPausedSchedules && pausedSchedules
      ? [
          formatPausedSchedulesTitle(pausedSchedules),
          onOpenSchedules ? 'Open Schedules' : null,
        ].filter(Boolean).join(' · ')
      : '';

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
        onOpenSchedules ? (
          <button
            type="button"
            className="ops-health-pill ops-health-paused-schedules"
            data-testid="ops-health-paused-schedules-pill"
            title={pausedSchedulesTitle}
            aria-label={`${pausedSchedulesLabel}. Open Schedules`}
            onClick={onOpenSchedules}
          >
            {pausedSchedulesLabel}
          </button>
        ) : (
          <span
            className="ops-health-pill ops-health-paused-schedules"
            data-testid="ops-health-paused-schedules-pill"
            title={pausedSchedulesTitle}
            role="status"
          >
            {pausedSchedulesLabel}
          </span>
        )
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

export interface SystemStatusDetailsProps {
  /** Open the capacity settings section from the FAA residual pill (issue #2082). */
  onOpenCapacity?: () => void;
  /** Open Diagnostics at the live-friction panel (issue #2596). */
  onOpenLiveFriction?: () => void;
  /** Open Diagnostics from the overdue-timer or time-to-unblock chip. */
  onOpenDiagnostics?: () => void;
  /** Open the Schedules dialog from the paused-schedules pill (issue #3399). */
  onOpenSchedules?: () => void;
  shortcutBindings?: ShortcutBindingMap;
}

/**
 * The System detail body: everything the status bar no longer shows at rest.
 * Mounted only while the System popover is open, so its two polls (time to
 * unblock, live friction) run only while someone is looking at them.
 */
export function SystemStatusDetails({
  onOpenCapacity,
  onOpenLiveFriction,
  onOpenDiagnostics,
  onOpenSchedules,
  shortcutBindings,
}: SystemStatusDetailsProps) {
  const sttUrl = useKookrStore((s) => s.sttUrl);
  const achievements = useKookrStore((s) => s.achievements);
  const toggleAchievementsPanel = useKookrStore((s) => s.toggleAchievementsPanel);
  const sound = useSoundPreference();
  const audioAlertSnapshot = useAudioAlertLog(1);
  const soundOn = sound.enabled;
  const soundTitle = soundToggleTitle(soundOn, audioAlertSnapshot.lastDecision);
  const [timeToUnblock, setTimeToUnblock] = useState<TimeToUnblockSnapshot | null>(null);
  const [liveFriction, setLiveFriction] = useState<LiveFrictionSnapshot | null>(null);

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

  const showUnblockChip = timeToUnblock !== null
    && timeToUnblock.sampleCount >= TIME_TO_UNBLOCK_MIN_SAMPLES
    && timeToUnblock.medianMs !== null
    && Number.isFinite(timeToUnblock.medianMs);
  const unblockLabel = showUnblockChip && timeToUnblock?.medianMs != null
    ? formatTimeToUnblockChipLabel(
      timeToUnblock.sampleCount,
      timeToUnblock.medianMs,
      timeToUnblock.windowMs,
    )
    : '';
  const unblockTitle = showUnblockChip && timeToUnblock?.medianMs != null
    ? formatTimeToUnblockChipTitle(
      timeToUnblock.sampleCount,
      timeToUnblock.medianMs,
      timeToUnblock.windowMs,
    )
    : '';

  const showFrictionChip = shouldShowLiveFrictionChip(liveFriction);
  const frictionCounts = liveFriction ? liveFrictionChipCounts(liveFriction) : null;
  const frictionLabel = frictionCounts ? formatLiveFrictionChipLabel(frictionCounts) : '';

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
    <div className="system-status-details" data-testid="system-status-details">
      <ResourceDisplay compact={false} />
      <OpsHealthPills
        onOpenCapacity={onOpenCapacity}
        onOpenDiagnostics={onOpenDiagnostics}
        onOpenSchedules={onOpenSchedules}
      />
      {showUnblockChip && (
        onOpenDiagnostics ? (
          <button
            type="button"
            className="time-to-unblock-pill"
            data-testid="time-to-unblock-chip"
            title={unblockTitle}
            aria-label={`${unblockLabel}. Open Diagnostics`}
            onClick={onOpenDiagnostics}
          >
            {unblockLabel}
          </button>
        ) : (
          <span
            className="time-to-unblock-pill"
            data-testid="time-to-unblock-chip"
            role="status"
            title={unblockTitle}
          >
            {unblockLabel}
          </span>
        )
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
      <span className="system-status-controls">
        {sttUrl && <span className="stt-status-pill" title="Speech-to-text enabled">STT</span>}
        <button
          type="button"
          className={`btn-sound-toggle ${soundOn ? '' : 'muted'}`}
          onClick={toggleSound}
          title={soundTitle}
          aria-label={soundOn ? 'Mute alert sounds' : 'Unmute alert sounds'}
        >
          {soundOn ? '\u{1F50A}' : '\u{1F507}'}
        </button>
        <button
          type="button"
          className="btn-trophy"
          onClick={toggleAchievementsPanel}
          title={`Achievements${shortcutBindings ? ` (${formatShortcutBinding(shortcutBindings.toggle_achievements)})` : ''}`}
          aria-label="Achievements"
        >
          {'\u{1F3C6}'}
          {hasNewAchievements && <span className="trophy-badge-dot" />}
        </button>
      </span>
    </div>
  );
}
