import React, { useCallback, useMemo } from 'react';
import { useAudioAlertLog, type AudioAlertOutcome, type LocalAudioAlertDecision } from '../audio/audio-alert-log.js';
import { maybePlayChime, useSoundPreference } from '../audio/sound.js';
import { CHIME_SOUND_LABELS, formatSoundVolume, type ChimeSound } from '../audio/sound-preference.js';
import { useDnd } from '../hooks/useDnd.js';

const OUTCOME_LABEL: Record<AudioAlertOutcome, string> = {
  scheduled: 'Scheduled',
  suppressed_muted: 'Muted',
  suppressed_dnd: 'DND',
  suppressed_debounced: 'Debounced',
  suppressed_rate_limited: 'Rate Limited',
  audio_context_unavailable: 'No AudioContext',
  audio_context_error: 'AudioContext Error',
  audio_context_suspended: 'Suspended',
};

function isAudioAlertOutcome(outcome: string): outcome is AudioAlertOutcome {
  return outcome in OUTCOME_LABEL;
}

function formatTime(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatDndExpiry(expiresAt: number | null): string {
  if (expiresAt === null) return 'indefinite';
  const diffMs = expiresAt - Date.now();
  if (diffMs <= 0) return 'expired';
  const minutes = Math.ceil(diffMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remain = minutes % 60;
  return remain > 0 ? `${hours}h ${remain}m` : `${hours}h`;
}

function describeDecision(decision: LocalAudioAlertDecision): string {
  if (decision.source === 'finding') {
    const base = `${decision.anomalyType ?? 'finding'} ${decision.severity ?? ''}`.trim();
    const target = decision.taskName ?? decision.agentId ?? 'unknown agent';
    const extra = decision.candidateCount && decision.candidateCount > 1
      ? ` (+${decision.candidateCount - 1} more)`
      : '';
    return `${base} on ${target}${extra}`;
  }
  if (decision.source === 'task_completion') {
    return `${decision.previousStatus ?? 'unknown'} -> ${decision.nextStatus ?? 'unknown'} on ${decision.taskName ?? decision.agentId ?? 'focused task'}`;
  }
  if (decision.source === 'completion_signal') {
    const target = decision.taskName ?? decision.agentId ?? 'task';
    const extra = decision.candidateCount && decision.candidateCount > 1
      ? ` (+${decision.candidateCount - 1} more)`
      : '';
    return `Signaled complete on ${target}${extra}`;
  }
  return decision.reason;
}

function DecisionRow({ decision }: { decision: LocalAudioAlertDecision }) {
  return (
    <div className={`audio-alert-row audio-alert-row--${decision.outcome}`}>
      <span className="audio-alert-time">{formatTime(decision.timestamp)}</span>
      <span className="audio-alert-outcome">{OUTCOME_LABEL[decision.outcome]}</span>
      <span className="audio-alert-source">{decision.source}</span>
      <span className="audio-alert-description">{describeDecision(decision)}</span>
      {decision.repeatCount && decision.repeatCount > 1 && (
        <span className="audio-alert-repeat">x{decision.repeatCount}</span>
      )}
    </div>
  );
}

export function AudioAlertsPanel() {
  const snapshot = useAudioAlertLog(20);
  const sound = useSoundPreference();
  const dnd = useDnd();
  const lastScheduled = useMemo(
    () => snapshot.entries.find((entry) => entry.outcome === 'scheduled') ?? null,
    [snapshot.entries],
  );
  const tabId = snapshot.lastDecision?.clientTabId ?? 'not recorded yet';

  const handleManualTest = useCallback(() => {
    maybePlayChime({
      source: 'manual_test',
      reason: 'operator_test',
      primaryCause: 'manual_test',
    });
  }, []);

  const handleVolumeChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    sound.setVolume(Number(event.target.value));
  }, [sound]);

  const handleChimeSoundChange = useCallback((event: React.ChangeEvent<HTMLSelectElement>) => {
    sound.setChimeSound(event.target.value as ChimeSound);
  }, [sound]);

  return (
    <div className="audio-alerts-section">
      <div className="section-header">
        <span className="section-chevron"> </span>
        <span className="stats-label">
          Audio Alerts
          <span className="stats-summary">current browser tab</span>
        </span>
        <button
          type="button"
          className="audio-alert-test-btn"
          onClick={handleManualTest}
          title="Test alert policy"
          aria-label="Test audio alert policy"
        >
          Test
        </button>
      </div>
      <div className="audio-alerts-body" aria-live="polite">
        <div className="audio-alert-summary-grid">
          <span>Sound</span>
          <strong>{sound.enabled ? 'on' : 'muted'}</strong>
          <span>Volume</span>
          <strong>{formatSoundVolume(sound.volume)}</strong>
          <span>Chime</span>
          <strong>{CHIME_SOUND_LABELS[sound.chimeSound]}</strong>
          <span>Source</span>
          <strong>{sound.source}</strong>
          <span>DND</span>
          <strong>{dnd.enabled ? formatDndExpiry(dnd.expiresAt) : 'off'}</strong>
          <span>Tab</span>
          <strong>{tabId}</strong>
        </div>

        <div className="audio-alert-controls">
          <label className="audio-alert-control audio-alert-volume">
            <span>Volume</span>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={sound.volume}
              onChange={handleVolumeChange}
              aria-label="Audio alert volume"
            />
            <strong>{formatSoundVolume(sound.volume)}</strong>
          </label>
          <label className="audio-alert-control">
            <span>Chime</span>
            <select
              value={sound.chimeSound}
              onChange={handleChimeSoundChange}
              aria-label="Audio alert chime sound"
            >
              {Object.entries(CHIME_SOUND_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
        </div>

        <div className="audio-alert-counts" role="group" aria-label="Audio alert counts by outcome">
          {Object.entries(snapshot.countsByOutcome)
            .filter((entry): entry is [AudioAlertOutcome, number] => isAudioAlertOutcome(entry[0]))
            .map(([outcome, count]) => (
              <span key={outcome} className={`audio-alert-count audio-alert-count--${outcome}`}>
                {OUTCOME_LABEL[outcome]} {count}
              </span>
            ))}
        </div>

        {lastScheduled && (
          <div className="audio-alert-last">
            Last scheduled: {formatTime(lastScheduled.timestamp)} {describeDecision(lastScheduled)}
          </div>
        )}

        {snapshot.entries.length === 0 ? (
          <div className="stats-row muted">No audio alert decisions recorded yet</div>
        ) : (
          <div className="audio-alert-list">
            {snapshot.entries.map((decision) => (
              <DecisionRow key={decision.id} decision={decision} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
