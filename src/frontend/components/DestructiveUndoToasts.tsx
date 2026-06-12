import React, { useEffect, useState } from 'react';

export interface DestructiveUndoToastAction {
  id: string;
  summary: string;
  expiresAt: number;
}

function formatPendingActionDetails(expiresAt: number): string {
  const remainingSeconds = Math.max(1, Math.ceil((expiresAt - Date.now()) / 1000));
  return `Will run in ${remainingSeconds}s.`;
}

export function DestructiveUndoToasts({
  actions,
  onUndo,
}: {
  actions: DestructiveUndoToastAction[];
  onUndo: (id: string) => void;
}) {
  const [, setTick] = useState(0);

  useEffect(() => {
    if (actions.length === 0) return;
    const interval = window.setInterval(() => setTick((value) => value + 1), 1000);
    return () => window.clearInterval(interval);
  }, [actions.length]);

  if (actions.length === 0) return null;

  return (
    <div className="toasts destructive-undo-toasts">
      {actions.map((action) => (
        <div
          key={action.id}
          className="toast toast-info toast-undo"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          <span className="toast-message">
            <span>{action.summary}</span>
            <span className="toast-details" aria-hidden="true">{formatPendingActionDetails(action.expiresAt)}</span>
          </span>
          <button
            type="button"
            className="toast-action"
            aria-label={`Undo ${action.summary.toLowerCase()}`}
            onClick={() => onUndo(action.id)}
          >
            Undo
          </button>
        </div>
      ))}
    </div>
  );
}
