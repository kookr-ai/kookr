import React, { useRef } from 'react';
import type { ClientMessage } from '../../shared/protocol.js';
import { DetectionStatsPanel } from './DetectionStatsPanel.js';
import { CircuitBreakerPanel } from './CircuitBreakerPanel.js';
import { AudioAlertsPanel } from './AudioAlertsPanel.js';
import { FindingEvidenceDiagnosticsPanel } from './FindingEvidenceDiagnosticsPanel.js';
import { useEscapeToClose } from '../hooks/useEscapeToClose.js';
import { useDialogFocus } from '../hooks/useDialogFocus.js';

interface Props {
  send: (msg: ClientMessage) => void;
  onClose: () => void;
}

export function OperationsPanel({ send, onClose }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const titleId = 'operations-panel-title';

  useDialogFocus({ dialogRef, initialFocusRef: closeButtonRef });
  useEscapeToClose(onClose);

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div
        ref={dialogRef}
        className="dialog operations-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="dialog-header operations-panel-header">
          <h3 id={titleId}>Diagnostics</h3>
          <button
            ref={closeButtonRef}
            type="button"
            className="dialog-close operations-panel-close"
            onClick={onClose}
            aria-label="Close diagnostics"
          >
            <span aria-hidden="true">&times;</span>
          </button>
        </div>
        <div className="operations-panel-body">
          <AudioAlertsPanel />
          <DetectionStatsPanel defaultExpanded showEmpty />
          <FindingEvidenceDiagnosticsPanel />
          <CircuitBreakerPanel send={send} defaultExpanded showEmpty />
        </div>
      </div>
    </div>
  );
}
