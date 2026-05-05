import React, { useEffect } from 'react';
import { useEscapeToClose } from '../hooks/useEscapeToClose.js';

interface Props {
  title: string;
  message: string;
  confirmLabel: string;
  confirmClass?: string;
  onConfirm: () => void;
  onClose: () => void;
}

export function ConfirmDialog({ title, message, confirmLabel, confirmClass, onConfirm, onClose }: Props) {
  useEscapeToClose(onClose);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        onConfirm();
      }
    }
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [onConfirm]);

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="confirm-dialog-title">{title}</div>
        <div className="confirm-dialog-message">{message}</div>
        <div className="confirm-dialog-actions">
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className={confirmClass ?? 'btn-primary'} onClick={onConfirm}>{confirmLabel}</button>
        </div>
        <div className="confirm-dialog-hint">
          <kbd>Enter</kbd> confirm · <kbd>Esc</kbd> cancel
        </div>
      </div>
    </div>
  );
}
