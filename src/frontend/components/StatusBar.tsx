import React, { useState, useCallback, useMemo } from 'react';
import { useKookrStore } from '../store/useStore.js';
import type { FocusZone } from '../store/useStore.js';
import type { QuotaStatus } from '../../shared/protocol.js';
import { isSoundEnabled, setSoundEnabled } from '../hooks/useAudibleAlert.js';

interface Props {
  findings: number;
  total: number;
  compact?: boolean;
  onShowShortcuts: () => void;
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

function QuotaDisplay({ quota }: { quota: QuotaStatus }) {
  const staleSec = Math.floor((Date.now() - quota.updatedAt) / 1000);
  const stale = staleSec > 300; // >5 min = stale
  return (
    <span className={`quota-display ${stale ? 'quota-stale' : ''}`} title={stale ? `Quota data is ${Math.floor(staleSec / 60)}m old` : 'Plan quota usage'}>
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

export function StatusBar({
  findings,
  total,
  compact = false,
  onShowShortcuts,
  reflectionSuggestion,
  onReflect,
  onDismissReflection,
}: Props) {
  const focusZone = useKookrStore((s) => s.focusZone);
  const sttUrl = useKookrStore((s) => s.sttUrl);
  const quotaStatus = useKookrStore((s) => s.quotaStatus);
  const achievements = useKookrStore((s) => s.achievements);
  const toggleAchievementsPanel = useKookrStore((s) => s.toggleAchievementsPanel);
  const zoneLabel = ZONE_LABELS[focusZone];
  const [soundOn, setSoundOn] = useState(isSoundEnabled);

  const hasNewAchievements = useMemo(() => {
    const lastOpen = typeof localStorage !== 'undefined'
      ? Number(localStorage.getItem('kookr-last-achievement-panel-open')) || Date.now()
      : Date.now();
    return Object.values(achievements).some(ts => new Date(ts).getTime() > lastOpen);
  }, [achievements]);

  const toggleSound = useCallback(() => {
    setSoundOn((prev) => {
      const next = !prev;
      setSoundEnabled(next);
      return next;
    });
  }, []);

  return (
    <div className={`statusbar${compact ? ' compact' : ''}`}>
      <span className="statusbar-left">
        {zoneLabel && <span className="focus-zone-pill">{zoneLabel}</span>}
        <span>{total} task{total !== 1 ? 's' : ''} · {findings} finding{findings !== 1 ? 's' : ''}</span>
        {quotaStatus && <QuotaDisplay quota={quotaStatus} />}
        {sttUrl && <span className="stt-status-pill" title="Speech-to-text enabled">STT</span>}
        <button
          className={`btn-sound-toggle ${soundOn ? '' : 'muted'}`}
          onClick={toggleSound}
          title={soundOn ? 'Mute alert sounds' : 'Unmute alert sounds'}
          aria-label={soundOn ? 'Mute alert sounds' : 'Unmute alert sounds'}
        >
          {soundOn ? '\u{1F50A}' : '\u{1F507}'}
        </button>
        <button
          className="btn-trophy"
          onClick={toggleAchievementsPanel}
          title="Achievements (Alt+A)"
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
