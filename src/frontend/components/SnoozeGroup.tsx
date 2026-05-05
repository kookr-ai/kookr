import React, { useState, useRef, useEffect } from 'react';
import { track } from '../telemetry.js';

const PRESETS = [
  { label: '5m', ms: 5 * 60 * 1000 },
  { label: '1h', ms: 60 * 60 * 1000 },
  { label: '12h', ms: 12 * 60 * 60 * 1000 },
  { label: '24h', ms: 24 * 60 * 60 * 1000 },
] as const;

interface Props {
  agentId: string;
  onSnooze: (durationMs: number) => void;
}

export function SnoozeGroup({ agentId, onSnooze }: Props) {
  const [showManual, setShowManual] = useState(false);
  const [manualValue, setManualValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (showManual) inputRef.current?.focus();
  }, [showManual]);

  function handlePreset(preset: typeof PRESETS[number]) {
    track({ type: 'finding_snoozed', agentId, anomalyType: null, durationMs: preset.ms, method: 'button' });
    onSnooze(preset.ms);
  }

  function handleManualSubmit() {
    const minutes = parseInt(manualValue, 10);
    if (isNaN(minutes) || minutes <= 0) {
      setShowManual(false);
      setManualValue('');
      return;
    }
    const ms = minutes * 60 * 1000;
    track({ type: 'finding_snoozed', agentId, anomalyType: null, durationMs: ms, method: 'manual' });
    onSnooze(ms);
    setShowManual(false);
    setManualValue('');
  }

  return (
    <span className="snooze-group" onClick={(e) => e.stopPropagation()}>
      {PRESETS.map((p) => (
        <button key={p.label} className="btn-snooze" onClick={() => handlePreset(p)}>
          {p.label}
        </button>
      ))}
      {showManual ? (
        <input
          ref={inputRef}
          className="snooze-manual-input"
          type="number"
          min="1"
          placeholder="min"
          value={manualValue}
          onChange={(e) => setManualValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleManualSubmit();
            if (e.key === 'Escape') { setShowManual(false); setManualValue(''); }
          }}
          onBlur={handleManualSubmit}
        />
      ) : (
        <button className="btn-snooze" onClick={() => setShowManual(true)}>
          Manual
        </button>
      )}
    </span>
  );
}
