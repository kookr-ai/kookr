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

/**
 * Persistent polite live region for undo toasts.
 *
 * Same announcement-timing fix as `Toasts`: the region must already be mounted
 * before its contents change, or screen readers drop the announcement.
 * Visible toast cards omit role/aria-live to avoid double-reads.
 */
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

  const politeText = actions.map((action) => action.summary).join(' ');

  return (
    <>
      <div
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-testid="destructive-undo-live-polite"
      >
        {politeText}
      </div>
      {actions.length > 0 && (
        <div className="toasts destructive-undo-toasts">
          {actions.map((action) => (
            <div key={action.id} className="toast toast-info toast-undo">
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
      )}
    </>
  );
}
