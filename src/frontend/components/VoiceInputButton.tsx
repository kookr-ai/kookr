/**
 * VoiceInputButton — Microphone button for speech-to-text input.
 *
 * Dynamically imported only when STT is enabled (KOOKR_STT_URL set).
 * Connects directly to the external aegiscore STT service via WebSocket.
 *
 * Each instance owns its own useSTT hook. A Zustand store field
 * (activeSTTInputId) enforces that only one button records at a time.
 */

import React, { useEffect } from 'react';
import { useSTT, type STTState } from '../hooks/useSTT.js';
import { useKookrStore } from '../store/useStore.js';
import { track } from '../telemetry.js';
import { formatShortcutBinding, type ShortcutBinding } from '../../shared/contracts/shortcut-bindings.js';

interface Props {
  inputId: string;
  onTranscript: (text: string) => void;
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
  recording: 'Recording... click to stop',
  processing: 'Processing transcription...',
  error: '',
};

export function VoiceInputButton({ inputId, onTranscript, disabled, shortcutBinding }: Props) {
  const sttUrl = useKookrStore((s) => s.sttUrl);
  const activeSTTInputId = useKookrStore((s) => s.activeSTTInputId);
  const setActiveSTTInput = useKookrStore((s) => s.setActiveSTTInput);
  const { state, error, elapsed, start, stop } = useSTT(sttUrl, onTranscript);

  const otherRecording = activeSTTInputId !== null && activeSTTInputId !== inputId;

  // Keep store in sync with hook state
  useEffect(() => {
    if (state === 'recording') {
      setActiveSTTInput(inputId);
    } else if (activeSTTInputId === inputId && state !== 'processing') {
      setActiveSTTInput(null);
    }
  }, [state, inputId, activeSTTInputId, setActiveSTTInput]);

  // Cleanup on unmount: stop recording if this button is active
  useEffect(() => {
    return () => {
      if (useKookrStore.getState().activeSTTInputId === inputId) {
        stop();
        useKookrStore.getState().setActiveSTTInput(null);
      }
    };
  }, [inputId, stop]);

  function handleClick() {
    if (disabled || otherRecording) return;

    if (state === 'recording') {
      track({ type: 'shortcut_used', key: 'mic_button', action: 'stt_stop', context: inputId });
      stop();
    } else if (state === 'idle' || state === 'error') {
      track({ type: 'shortcut_used', key: 'mic_button', action: 'stt_start', context: inputId });
      void start();
    }
  }

  // Prevent blur on parent input (e.g., QuickLaunch onBlur={onClose})
  function handleMouseDown(e: React.MouseEvent) {
    e.preventDefault();
  }

  const title = state === 'error' && error ? error : stateTitle(state, shortcutBinding);

  return (
    <button
      className={`btn-voice ${state}`}
      onClick={handleClick}
      onMouseDown={handleMouseDown}
      disabled={disabled || otherRecording || state === 'processing'}
      title={title}
      aria-label={title}
    >
      {state === 'recording' ? (
        <>
          <span className="voice-icon recording" aria-hidden="true">&#9632;</span>
          <span className="voice-elapsed">{formatElapsed(elapsed)}</span>
        </>
      ) : state === 'processing' ? (
        <span className="voice-icon processing" aria-hidden="true">&#8987;</span>
      ) : state === 'error' ? (
        <span className="voice-icon error" aria-hidden="true">&#9888;</span>
      ) : (
        <span className="voice-icon idle" aria-hidden="true">&#127908;</span>
      )}
    </button>
  );
}
