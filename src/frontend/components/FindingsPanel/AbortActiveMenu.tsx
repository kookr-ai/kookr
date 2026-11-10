import React, { useEffect, useRef, useState } from 'react';
import type { ClientMessage } from '../../../shared/protocol.js';
import { ConfirmDialog } from '../ConfirmDialog.js';

// Control-room bulk shutdown (issue #1325). One confirmed action interrupts
// every live session and cancels every active task in scope — replacing the
// old pattern of fanning out "abort your work" prose to each agent. The server
// answers with a concise result toast (aborted / already-finished / failed);
// retries are idempotent, so a double-click never double-cancels.
//
// Quiet chrome (issue #3561 slice 2): a destructive action never sits on screen
// at rest. "Abort all" lives in a "More actions" menu in the rail header, and
// choosing it still opens the confirmation dialog before anything is sent.
export function AbortActiveMenu({
  taskIds,
  send,
}: {
  taskIds: string[];
  send: (msg: ClientMessage) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    itemRef.current?.focus();
    const onMouseDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setMenuOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  // Nothing active to abort → hide, so the menu never promises a no-op.
  if (taskIds.length === 0) return null;

  const count = taskIds.length;
  const toggleMenu = (e: React.MouseEvent) => {
    e.stopPropagation();
    setMenuOpen((open) => !open);
  };
  const chooseAbort = (e: React.MouseEvent) => {
    e.stopPropagation();
    setMenuOpen(false);
    setConfirmOpen(true);
  };
  const confirmAbort = () => {
    send({ type: 'batchAbortTasks', taskIds });
    setConfirmOpen(false);
  };

  return (
    <span className="rail-actions-menu" ref={wrapRef}>
      <button
        ref={triggerRef}
        type="button"
        className="rail-actions-trigger"
        onClick={toggleMenu}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label="More actions"
        title="More actions"
        data-testid="rail-actions-trigger"
      >
        <span aria-hidden="true">⋯</span>
      </button>
      {menuOpen && (
        <span className="rail-actions-popup" role="menu" aria-label="More actions">
          <button
            ref={itemRef}
            type="button"
            role="menuitem"
            className="rail-actions-item rail-actions-item-danger"
            onClick={chooseAbort}
            title="Interrupt live sessions and cancel all active tasks"
          >
            Abort all active tasks…
          </button>
        </span>
      )}
      {confirmOpen && (
        <ConfirmDialog
          title="Abort active tasks"
          message={`Abort ${count} active task${count === 1 ? '' : 's'}? Live sessions are interrupted and the tasks are cancelled.`}
          confirmLabel="Abort"
          confirmClass="btn-danger"
          onConfirm={confirmAbort}
          onClose={() => setConfirmOpen(false)}
        />
      )}
    </span>
  );
}
