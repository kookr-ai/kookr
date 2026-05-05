import React, { useState, useRef, useEffect } from 'react';
import { track } from '../telemetry.js';
import { useEscapeToClose } from '../hooks/useEscapeToClose.js';

const PRESETS = [
  { key: '1', label: '5m', ms: 5 * 60 * 1000 },
  { key: '2', label: '1h', ms: 60 * 60 * 1000 },
  { key: '3', label: '12h', ms: 12 * 60 * 60 * 1000 },
  { key: '4', label: '24h', ms: 24 * 60 * 60 * 1000 },
] as const;

interface Props {
  agentId: string;
  agentName: string;
  onSnooze: (durationMs: number) => void;
  onClose: () => void;
}

export function SnoozeDialog({ agentId, agentName, onSnooze, onClose }: Props) {
  const [manual, setManual] = useState(false);
  const [manualValue, setManualValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEscapeToClose(onClose);

  useEffect(() => {
    if (manual) {
      inputRef.current?.focus();
      return;
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'm' || e.key === 'M') {
        e.preventDefault();
        setManual(true);
        return;
      }
      const preset = PRESETS.find((p) => p.key === e.key);
      if (preset) {
        e.preventDefault();
        track({ type: 'finding_snoozed', agentId, anomalyType: null, durationMs: preset.ms, method: 'shortcut' });
        onSnooze(preset.ms);
      }
    }
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [manual, agentId, onSnooze]);

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

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="snooze-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="snooze-dialog-title">
          Snooze <strong>{agentName}</strong>
        </div>
        {!manual ? (
          <div className="snooze-dialog-options">
            {PRESETS.map((p) => (
              <button
                key={p.key}
                className="snooze-dialog-btn"
                onClick={() => {
                  track({ type: 'finding_snoozed', agentId, anomalyType: null, durationMs: p.ms, method: 'shortcut' });
                  onSnooze(p.ms);
                }}
              >
                <kbd>{p.key}</kbd> {p.label}
              </button>
            ))}
            <button className="snooze-dialog-btn" onClick={() => setManual(true)}>
              <kbd>M</kbd> Manual
            </button>
          </div>
        ) : (
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
        )}
        <div className="snooze-dialog-hint">
          <kbd>Esc</kbd> cancel
        </div>
      </div>
    </div>
  );
}
