import React, { useEffect, useId } from 'react';
import { useEscapeToClose } from '../hooks/useEscapeToClose.js';

interface Props {
  title: string;
  message: string;
  confirmLabel: string;
  confirmClass?: string;
  onConfirm: () => void;
  onClose: () => void;
  /** Optional content rendered between the message and the action buttons. */
  children?: React.ReactNode;
  /**
   * Optional content rendered between the message and the action row. Used by
   * the complete path to embed task-completion-feedback thumbs UI inside the
   * existing confirm dialog (RFC v4 §2.1).
   */
  footer?: React.ReactNode;
  /**
   * When true, the global Enter-confirms shortcut is disabled. The footer is
   * responsible for handling Enter inside any of its inputs (textareas etc.).
   * Set this whenever the footer contains user-text inputs so a newline
   * keystroke doesn't accidentally submit the dialog.
   */
  suppressEnterToConfirm?: boolean;
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  confirmClass,
  onConfirm,
  onClose,
  children,
  footer,
  suppressEnterToConfirm,
}: Props) {
  const titleId = useId();
  useEscapeToClose(onClose);

  useEffect(() => {
    if (suppressEnterToConfirm) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        onConfirm();
      }
    }
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [onConfirm, suppressEnterToConfirm]);

  // Overlay click must both close the dialog and stop bubbling. When the
  // dialog is rendered as a descendant of a clickable element (e.g. a section
  // header that toggles its collapse state), unguarded bubbling would both
  // close the dialog AND re-trigger the ancestor handler.
  const handleOverlayClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onClose();
  };

  return (
    <div className="dialog-overlay" onClick={handleOverlayClick}>
      <div
        className="confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="confirm-dialog-title" id={titleId}>{title}</div>
        <div className="confirm-dialog-message">{message}</div>
        {children && <div className="confirm-dialog-extra">{children}</div>}
        {footer && <div className="confirm-dialog-footer">{footer}</div>}
        <div className="confirm-dialog-actions">
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className={confirmClass ?? 'btn-primary'} onClick={onConfirm}>{confirmLabel}</button>
        </div>
        <div className="confirm-dialog-hint">
          {suppressEnterToConfirm ? <><kbd>Esc</kbd> cancel</> : <><kbd>Enter</kbd> confirm · <kbd>Esc</kbd> cancel</>}
        </div>
      </div>
    </div>
  );
}
