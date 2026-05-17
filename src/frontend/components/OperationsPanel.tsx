import React, { useEffect, useRef } from 'react';
import type { ClientMessage } from '../../shared/protocol.js';
import { DetectionStatsPanel } from './DetectionStatsPanel.js';
import { CircuitBreakerPanel } from './CircuitBreakerPanel.js';
import { AudioAlertsPanel } from './AudioAlertsPanel.js';
import { useEscapeToClose } from '../hooks/useEscapeToClose.js';

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

interface Props {
  send: (msg: ClientMessage) => void;
  onClose: () => void;
}

export function OperationsPanel({ send, onClose }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const titleId = 'operations-panel-title';

  useEffect(() => {
    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    closeButtonRef.current?.focus();
    return () => {
      previousFocusRef.current?.focus();
      previousFocusRef.current = null;
    };
  }, []);
  useEscapeToClose(onClose);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Tab') return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      const first = focusable[0] ?? dialog;
      const last = focusable[focusable.length - 1] ?? dialog;

      if (!dialog.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
        return;
      }
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, []);

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div
        ref={dialogRef}
        className="dialog operations-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
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
          <CircuitBreakerPanel send={send} defaultExpanded showEmpty />
        </div>
      </div>
    </div>
  );
}
