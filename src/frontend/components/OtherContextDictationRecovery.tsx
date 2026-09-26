import React, { useEffect, useState, type RefObject } from 'react';
import { copyText } from '../clipboard.js';
import { DICTATION_RECOVERY_TTL_MS, discardDictationRecovery, type DictationRecovery } from '../store/dictation-recovery.js';

interface Props {
  recovery: DictationRecovery;
  fieldLabel?: string;
  onChange: () => void;
  inputRef: RefObject<HTMLInputElement | HTMLTextAreaElement | null>;
}

/** Retain access when a task/project context changes, without restoring into another input. */
export function OtherContextDictationRecovery({ recovery, fieldLabel, onChange, inputRef }: Props) {
  const [notice, setNotice] = useState('');
  useEffect(() => {
    const timer = setTimeout(onChange, Math.max(0, recovery.capturedAt + DICTATION_RECOVERY_TTL_MS - Date.now()));
    return () => clearTimeout(timer);
  }, [recovery.capturedAt, onChange]);
  const label = `Incomplete dictation from another context${fieldLabel ? ` — ${fieldLabel}` : ''}`;
  return (
    <div className="voice-recovery voice-hidden-recovery" role="group" aria-label={label}>
      <span className="voice-recovery-label">{label}</span>
      <span>Captured <time dateTime={new Date(recovery.capturedAt).toISOString()}>{new Date(recovery.capturedAt).toLocaleString()}</time>. Expires after 24 hours.</span>
      <span className="voice-preview" tabIndex={0}>{recovery.text}</span>
      <span>The original task, project or directory is no longer selected. Copy the words to keep them, or discard them before launching.</span>
      {recovery.truncated && <span>Only the first 100,000 characters were retained.</span>}
      {!recovery.persisted && <span>Browser storage is unavailable. Copy the text before reloading.</span>}
      <span className="voice-recovery-actions">
        <button type="button" onMouseDown={event => event.preventDefault()} onClick={event => {
          const button = event.currentTarget;
          void copyText(recovery.text).then(
            () => setNotice('Copied'),
            () => setNotice('Copy failed. Select the text to copy it manually.'),
          ).finally(() => { if (button.isConnected) button.focus(); });
        }}>Copy</button>
        <button type="button" onMouseDown={event => event.preventDefault()} onClick={() => {
          discardDictationRecovery(recovery.owner, recovery.id);
          onChange();
          inputRef.current?.focus();
        }}>Discard</button>
      </span>
      {notice && <span role="status">{notice}</span>}
    </div>
  );
}
