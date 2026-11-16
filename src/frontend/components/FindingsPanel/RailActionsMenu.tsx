import React, { useEffect, useRef, useState } from 'react';
import type { ClientMessage } from '../../../shared/protocol.js';
import { useKookrStore } from '../../store/useStore.js';
import { ConfirmDialog } from '../ConfirmDialog.js';
import { MigrateInterruptedDialog } from './MigrateInterruptedDialog.js';

// The rail header's "More actions" menu. It holds the bulk actions that would
// otherwise crowd the "Tasks" title at 280-340 px (#3617): collapse or expand
// every section, migrate interrupted tasks, and abort every active task.
//
// Quiet chrome (issue #3561 slice 2): a destructive action never sits on screen
// at rest. Choosing "Abort all" still opens a confirmation dialog before
// anything is sent (control-room bulk shutdown, issue #1325; the server
// answers with one result toast and retries are idempotent).
//
// An item appears only when it would do something, and the trigger hides when
// no item applies, so the menu never promises a no-op.
export function RailActionsMenu({
  taskIds,
  send,
  sections,
}: {
  taskIds: string[];
  send: (msg: ClientMessage) => void;
  /** Collapse/expand all; null when no collapsible section is rendered. */
  sections: { allCollapsed: boolean; onToggle: () => void } | null;
}) {
  const canMigrate = useKookrStore((s) => s.availableAgentTypes.length >= 2);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmAbortOpen, setConfirmAbortOpen] = useState(false);
  const [migrateOpen, setMigrateOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLSpanElement>(null);
  const canAbort = taskIds.length > 0;
  const hasItems = sections !== null || canMigrate || canAbort;

  // When the last item goes away the trigger unmounts; drop the open state so
  // the menu does not spring open by itself when an item comes back.
  useEffect(() => {
    if (!hasItems) setMenuOpen(false);
  }, [hasItems]);
  // Nothing left to abort: drop a pending confirmation, so it cannot come
  // back by itself (and abort other tasks) when new tasks become active.
  useEffect(() => {
    if (!canAbort) setConfirmAbortOpen(false);
  }, [canAbort]);

  useEffect(() => {
    if (!menuOpen) return;
    const items = () => Array.from(popupRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
    items()[0]?.focus();
    const onMouseDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMenuOpen(false);
        triggerRef.current?.focus();
        return;
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const list = items();
      if (list.length === 0) return;
      e.preventDefault();
      const at = list.indexOf(document.activeElement as HTMLButtonElement);
      const step = e.key === 'ArrowDown' ? 1 : -1;
      list[(at + step + list.length) % list.length]?.focus();
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  // The dialogs live outside the popup, so closing the menu never unmounts one.
  const dialogs = (
    <>
      {migrateOpen && <MigrateInterruptedDialog onClose={() => setMigrateOpen(false)} />}
      {confirmAbortOpen && canAbort && (
        <ConfirmDialog
          title="Abort active tasks"
          message={`Abort ${taskIds.length} active task${taskIds.length === 1 ? '' : 's'}? Live sessions are interrupted and the tasks are cancelled.`}
          confirmLabel="Abort"
          confirmClass="btn-danger"
          onConfirm={() => {
            send({ type: 'batchAbortTasks', taskIds });
            setConfirmAbortOpen(false);
          }}
          onClose={() => setConfirmAbortOpen(false)}
        />
      )}
    </>
  );
  if (!hasItems) return dialogs;

  const choose = (action: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    setMenuOpen(false);
    // The chosen item unmounts with the popup; keep focus on the trigger so a
    // dialog opened by the item hands focus back there when it closes.
    triggerRef.current?.focus();
    action();
  };

  return (
    <span className="rail-actions-menu" ref={wrapRef}>
      <button
        ref={triggerRef}
        type="button"
        className="rail-actions-trigger"
        onClick={(e) => {
          e.stopPropagation();
          setMenuOpen((open) => !open);
        }}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label="More actions"
        title="More actions"
        data-testid="rail-actions-trigger"
      >
        <span aria-hidden="true">⋯</span>
      </button>
      {menuOpen && (
        <span className="rail-actions-popup" role="menu" aria-label="More actions" ref={popupRef}>
          {sections && (
            <button
              type="button"
              role="menuitem"
              className="rail-actions-item"
              onClick={choose(sections.onToggle)}
              aria-label={sections.allCollapsed ? 'Expand all findings sections' : 'Collapse all findings sections'}
            >
              {sections.allCollapsed ? 'Expand all' : 'Collapse all'}
            </button>
          )}
          {canMigrate && (
            <button
              type="button"
              role="menuitem"
              className="rail-actions-item"
              onClick={choose(() => setMigrateOpen(true))}
              aria-label="Migrate interrupted tasks to a different agent"
              title="Continue interrupted tasks under a different agent"
            >
              Migrate interrupted…
            </button>
          )}
          {canAbort && (
            <button
              type="button"
              role="menuitem"
              className="rail-actions-item rail-actions-item-danger"
              onClick={choose(() => setConfirmAbortOpen(true))}
              title="Interrupt live sessions and cancel all active tasks"
            >
              Abort all active tasks…
            </button>
          )}
        </span>
      )}
      {dialogs}
    </span>
  );
}
