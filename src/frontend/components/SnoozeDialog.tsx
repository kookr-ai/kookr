import React, { useState, useRef, useEffect, useId } from 'react';
import { track } from '../telemetry.js';
import { useDialogFocus } from '../hooks/useDialogFocus.js';
import { useEscapeToClose } from '../hooks/useEscapeToClose.js';
import { SNOOZE_UNTIL_NEXT_CHANGE_DURATION_MS } from '../../shared/contracts/messages.js';

const PRESETS = [
  { key: '1', label: '5m', ms: 5 * 60 * 1000 },
  { key: '2', label: '1h', ms: 60 * 60 * 1000 },
  { key: '3', label: '12h', ms: 12 * 60 * 60 * 1000 },
  { key: '4', label: '24h', ms: 24 * 60 * 60 * 1000 },
  { key: 'C', label: 'Until next change', ms: SNOOZE_UNTIL_NEXT_CHANGE_DURATION_MS },
] as const;

/** "End of day" shortcut target — the last minute before midnight. */
export const END_OF_DAY = '23:59';

/**
 * Duration in milliseconds from `now` until the next occurrence of the wall-clock
 * time `hhmm` (24-hour `"HH:MM"`, as produced by an `<input type="time">`).
 *
 * A time that is earlier than — or exactly equal to — `now` rolls forward to the
 * same wall-clock time tomorrow, so the result is always strictly positive. The
 * rollover advances the calendar day (rather than adding a fixed 24h) so a DST
 * transition night still lands on the intended wall-clock time. Returns `null`
 * for unparseable/out-of-range input, and (as a defensive guard) for any
 * non-positive result, so callers can treat `null` as "don't snooze".
 */
export function msUntilClockTime(hhmm: string, now: number = Date.now()): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;

  const target = new Date(now);
  target.setHours(hours, minutes, 0, 0);
  if (target.getTime() <= now) {
    target.setDate(target.getDate() + 1); // already passed today → same wall-clock time tomorrow (DST-safe)
  }
  const durationMs = target.getTime() - now;
  return durationMs > 0 ? durationMs : null;
}

type Mode = 'presets' | 'manual' | 'time';

interface Props {
  agentId: string;
  agentName: string;
  onSnooze: (durationMs: number) => void;
  onClose: () => void;
}

export function SnoozeDialog({ agentId, agentName, onSnooze, onClose }: Props) {
  const [mode, setMode] = useState<Mode>('presets');
  const [manualValue, setManualValue] = useState('');
  const [timeValue, setTimeValue] = useState('09:00');
  const inputRef = useRef<HTMLInputElement>(null);
  const firstPresetRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEscapeToClose(onClose);
  useDialogFocus({ dialogRef, initialFocusRef: firstPresetRef });

  useEffect(() => {
    if (mode !== 'presets') {
      inputRef.current?.focus();
      return;
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'm' || e.key === 'M') {
        if (hasShortcutModifier(e)) return;
        e.preventDefault();
        setMode('manual');
        return;
      }
      if (e.key === 't' || e.key === 'T') {
        if (hasShortcutModifier(e)) return;
        e.preventDefault();
        setMode('time');
        return;
      }
      const preset = PRESETS.find((p) => p.key.toLowerCase() === e.key.toLowerCase());
      if (preset) {
        if (hasShortcutModifier(e)) return;
        e.preventDefault();
        track({ type: 'finding_snoozed', agentId, anomalyType: null, durationMs: preset.ms, method: 'shortcut' });
        onSnooze(preset.ms);
      }
    }
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [mode, agentId, onSnooze]);

  function handleManualSubmit() {
    const minutes = parseInt(manualValue, 10);
    if (isNaN(minutes) || minutes <= 0) {
      onClose();
      return;
    }
    const ms = minutes * 60 * 1000;
    track({ type: 'finding_snoozed', agentId, anomalyType: null, durationMs: ms, method: 'shortcut_manual' });
    onSnooze(ms);
  }

  function snoozeUntil(hhmm: string) {
    const ms = msUntilClockTime(hhmm, Date.now());
    if (ms == null) {
      onClose();
      return;
    }
    track({ type: 'finding_snoozed', agentId, anomalyType: null, durationMs: ms, method: 'shortcut_time' });
    onSnooze(ms);
  }

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div
        ref={dialogRef}
        className="snooze-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div id={titleId} className="snooze-dialog-title">
          Snooze <strong>{agentName}</strong>
        </div>
        {mode === 'presets' ? (
          <div className="snooze-dialog-options">
            {PRESETS.map((p, index) => (
              <button
                key={p.key}
                ref={index === 0 ? firstPresetRef : undefined}
                className="snooze-dialog-btn"
                onClick={() => {
                  track({ type: 'finding_snoozed', agentId, anomalyType: null, durationMs: p.ms, method: 'shortcut' });
                  onSnooze(p.ms);
                }}
              >
                <kbd>{p.key}</kbd> {p.label}
              </button>
            ))}
            <button className="snooze-dialog-btn" onClick={() => setMode('time')}>
              <kbd>T</kbd> Until time…
            </button>
            <button className="snooze-dialog-btn" onClick={() => setMode('manual')}>
              <kbd>M</kbd> Manual
            </button>
          </div>
        ) : mode === 'manual' ? (
          <div className="snooze-dialog-manual">
            <label>Duration in minutes:</label>
            <input
              ref={inputRef}
              type="number"
              min="1"
              placeholder="minutes"
              value={manualValue}
              onChange={(e) => setManualValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleManualSubmit();
              }}
            />
          </div>
        ) : (
          <div className="snooze-dialog-manual snooze-dialog-time">
            <label>Snooze until:</label>
            <input
              ref={inputRef}
              type="time"
              value={timeValue}
              onChange={(e) => setTimeValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') snoozeUntil(timeValue);
              }}
            />
            <div className="snooze-dialog-time-actions">
              <button className="snooze-dialog-btn" onClick={() => snoozeUntil(timeValue)}>
                Snooze
              </button>
              <button className="snooze-dialog-btn" onClick={() => snoozeUntil(END_OF_DAY)}>
                End of day
              </button>
            </div>
          </div>
        )}
        <div className="snooze-dialog-hint">
          <kbd>Esc</kbd> cancel
        </div>
      </div>
    </div>
  );
}

function hasShortcutModifier(e: KeyboardEvent): boolean {
  return e.ctrlKey || e.metaKey || e.altKey;
}
