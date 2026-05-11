import React from 'react';
import type { ClientMessage } from '../../shared/protocol.js';
import { DetectionStatsPanel } from './DetectionStatsPanel.js';
import { CircuitBreakerPanel } from './CircuitBreakerPanel.js';

interface Props {
  send: (msg: ClientMessage) => void;
  onClose: () => void;
}

export function OperationsPanel({ send, onClose }: Props) {
  return (
    <div className="operations-panel" role="dialog" aria-modal="false" aria-label="Diagnostics and circuit breakers">
      <div className="operations-panel-header">
        <h2>Diagnostics</h2>
        <button type="button" className="btn-icon operations-panel-close" onClick={onClose} aria-label="Close diagnostics">
          ×
        </button>
      </div>
      <div className="operations-panel-body">
        <DetectionStatsPanel defaultExpanded showEmpty />
        <CircuitBreakerPanel send={send} defaultExpanded showEmpty />
      </div>
    </div>
  );
}
