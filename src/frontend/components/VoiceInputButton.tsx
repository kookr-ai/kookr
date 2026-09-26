/**
 * VoiceInputButton — Microphone button for speech-to-text input.
 *
 * Dynamically imported only when STT is enabled (KOOKR_STT_URL set).
 * Connects to the configured STT service via WebSocket.
 *
 * Each instance owns its own useSTT hook. A Zustand store field
 * (activeSTTInputId) enforces that only one button records at a time.
 */

import React, { useEffect, useId, useLayoutEffect, useState } from 'react';
import { useSTT, type STTState, type UseSTTResult } from '../hooks/useSTT.js';
import { useKookrStore } from '../store/useStore.js';
import { isSTTLanguage } from '../store/stt-language.js';
import { track } from '../telemetry.js';
import { copyText } from '../clipboard.js';
import { formatShortcutBinding, type ShortcutBinding } from '../../shared/contracts/shortcut-bindings.js';

interface Props {
  inputId: string;
  /** Stable draft/task identity, separate from the DOM shortcut input ID. */
  recoveryKey?: string;
  recoveryLabel?: string;
  onTranscript: (text: string) => void;
  /** Keep launch controls aware of capture and unresolved partial text. */
  onPendingChange?: (pending: boolean) => void;
  onRecoveryResolved?: () => void;
  disabled?: boolean;
  shortcutBinding?: ShortcutBinding;
}

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function stateTitle(state: STTState, shortcutBinding?: ShortcutBinding): string {
  if (state === 'idle') {
    const suffix = shortcutBinding ? ` (${formatShortcutBinding(shortcutBinding)})` : '';
    return `Click to start voice input${suffix}`;
  }
  return STATE_TITLES[state];
}

const STATE_TITLES: Record<Exclude<STTState, 'idle'>, string> = {
  starting: 'Starting microphone...',
  recording: 'Recording... click to stop',
  processing: 'Processing transcription...',
  error: '',
};

const AUDIO_SIGNAL_LABELS: Record<UseSTTResult['audioSignal']['status'], string> = {
  waiting: 'Waiting for audio',
  receiving: 'Sound detected',
  quiet: 'No sound detected',
  weak: 'Low input',
  interrupted: 'No audio received',
  clipping: 'Input too loud',
};
const METER_BAR_SCALES = [0.45, 0.65, 0.85, 1, 0.85, 0.65, 0.45];

export function VoiceInputButton({ inputId, recoveryKey = inputId, recoveryLabel = 'this input', onTranscript, onPendingChange, onRecoveryResolved, disabled, shortcutBinding }: Props) {
  const signalId = useId();
  const [copyStatus, setCopyStatus] = useState('');
  const sttUrl = useKookrStore((s) => s.sttUrl);
  const activeSTTInputId = useKookrStore((s) => s.activeSTTInputId);
  const setActiveSTTInput = useKookrStore((s) => s.setActiveSTTInput);
  const language = useKookrStore((s) => s.sttLanguage);
  const setLanguage = useKookrStore((s) => s.setSTTLanguage);
  const { state, transcript, error, degraded, retrying, elapsed, audioSignal, start, stop, retryHealth, recovery, restoreRecovery, discardRecovery } = useSTT(sttUrl, language, onTranscript, recoveryKey);

  const busy = state === 'starting' || state === 'recording' || state === 'processing';
  useLayoutEffect(() => {
    onPendingChange?.(busy || Boolean(recovery));
    return () => onPendingChange?.(false);
  }, [busy, recovery, onPendingChange]);

  const otherRecording = activeSTTInputId !== null && activeSTTInputId !== inputId;
  useEffect(() => setCopyStatus(''), [recovery?.id]);

  // Keep store in sync with hook state
  useEffect(() => {
    if (state === 'starting' || state === 'recording') {
      setActiveSTTInput(inputId);
    } else if (activeSTTInputId === inputId && state !== 'processing') {
      setActiveSTTInput(null);
    }
  }, [state, inputId, activeSTTInputId, setActiveSTTInput]);

  // The hook cancels recording on unmount; release the shared microphone lock.
  useLayoutEffect(() => {
    return () => {
      if (useKookrStore.getState().activeSTTInputId === inputId) {
        useKookrStore.getState().setActiveSTTInput(null);
      }
    };
  }, [inputId]);

  function handleClick() {
    const activeInput = useKookrStore.getState().activeSTTInputId;
    if (disabled || (activeInput !== null && activeInput !== inputId) || retrying) return;

    if (degraded) {
      track({ type: 'shortcut_used', key: 'mic_button', action: 'stt_retry', context: inputId });
      void retryHealth();
      return;
    }

    if (state === 'recording') {
      track({ type: 'shortcut_used', key: 'mic_button', action: 'stt_stop', context: inputId });
      stop();
    } else if ((state === 'idle' || state === 'error') && !recovery) {
      track({ type: 'shortcut_used', key: 'mic_button', action: 'stt_start', context: inputId });
      setActiveSTTInput(inputId);
      void start();
    }
  }

  // Prevent blur on parent input (e.g., QuickLaunch onBlur={onClose})
  function handleMouseDown(e: React.MouseEvent) {
    e.preventDefault();
  }

  const title = degraded
    ? retrying
      ? 'Checking speech-to-text health...'
      : `Speech-to-text unavailable${error ? `: ${error}` : ''}. Click to retry.`
    : state === 'error' && error ? error
      : recovery && (state === 'idle' || state === 'error') ? 'Restore or discard incomplete dictation before recording again'
        : stateTitle(state, shortcutBinding);
  const classState = degraded ? 'error' : state;

  return (
    <span className="voice-input">
      <span className="voice-input-controls">
        <button
          type="button"
          className={`btn-voice ${classState}`}
          onClick={handleClick}
          onMouseDown={handleMouseDown}
          disabled={disabled || otherRecording || state === 'starting' || state === 'processing' || retrying || Boolean(recovery && !busy && !degraded)}
          title={title}
          aria-label={title}
          aria-describedby={state === 'recording' ? signalId : undefined}
        >
          {degraded ? (
            <span className="voice-icon error" aria-hidden="true">&#9888;</span>
          ) : state === 'recording' ? (
            <>
              <span className="voice-icon recording" aria-hidden="true">&#9632;</span>
              <span className={`voice-meter ${audioSignal.status}`} aria-hidden="true">
                {METER_BAR_SCALES.map((scale, index) => (
                  <span key={index} className="voice-meter-bar" style={{ height: `${Math.max(2, audioSignal.level * 18 * scale)}px` }} />
                ))}
              </span>
              <span className="voice-elapsed">{formatElapsed(elapsed)}</span>
            </>
          ) : state === 'starting' || state === 'processing' ? (
            <span className="voice-icon processing" aria-hidden="true">&#8987;</span>
          ) : state === 'error' ? (
            <span className="voice-icon error" aria-hidden="true">&#9888;</span>
          ) : (
            <span className="voice-icon idle" aria-hidden="true">&#127908;</span>
          )}
        </button>
        <select
          className="voice-language"
          aria-label="Dictation language"
          title="Dictation language"
          value={language}
          disabled={disabled || activeSTTInputId !== null}
          onChange={(event) => {
            if (isSTTLanguage(event.target.value)) setLanguage(event.target.value);
          }}
        >
          <option value="auto">Auto</option>
          <option value="fr" lang="fr">Français</option>
          <option value="en" lang="en">English</option>
        </select>
      </span>
      {state === 'recording' && (
        <span id={signalId} className={`voice-signal ${audioSignal.status}`} role="status" aria-live="polite" aria-atomic="true">
          {AUDIO_SIGNAL_LABELS[audioSignal.status]}
        </span>
      )}
      {busy && (
        <span className="voice-preview" role="status" aria-live="polite" aria-atomic="true" tabIndex={0}>
          {transcript || (state === 'processing' ? 'Finishing dictation...' : 'Listening...')}
        </span>
      )}
      {!busy && recovery && (
        <span className="voice-recovery" role="group" aria-label={`Incomplete dictation for ${recoveryLabel}`}>
          <span className="voice-recovery-label">Incomplete dictation — {recoveryLabel}</span>
          <span>Captured <time dateTime={new Date(recovery.capturedAt).toISOString()}>{new Date(recovery.capturedAt).toLocaleString()}</time>. Expires after 24 hours.</span>
          <span className="voice-preview" tabIndex={0}>{recovery.text}</span>
          {recovery.truncated && <span>Only the first 100,000 characters were retained.</span>}
          {!recovery.persisted && <span role="status">Browser storage is unavailable. Keep this tab open or copy the text before reloading.</span>}
          <span className="voice-recovery-actions">
            <button type="button" onMouseDown={handleMouseDown} disabled={disabled} onClick={() => { restoreRecovery(); onRecoveryResolved?.(); }}>Restore to {recoveryLabel}</button>
            <button type="button" onMouseDown={handleMouseDown} onClick={(event) => {
              const button = event.currentTarget;
              void copyText(recovery.text).then(
                () => setCopyStatus('Copied'),
                () => setCopyStatus('Copy failed. Select the text to copy it manually.'),
              ).finally(() => { if (button.isConnected) button.focus(); });
            }}>Copy</button>
            <button type="button" onMouseDown={handleMouseDown} onClick={() => { discardRecovery(); onRecoveryResolved?.(); }}>Discard</button>
          </span>
          {copyStatus && <span role="status">{copyStatus}</span>}
          <span>Restore appends these unverified words. Restore or discard before recording again.</span>
        </span>
      )}
      {error && <span className="voice-error" role="alert">{error}</span>}
    </span>
  );
}
