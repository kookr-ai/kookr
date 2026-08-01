import React, { useState } from 'react';
import { ConfirmDialog } from '../ConfirmDialog.js';
import type { QueueClearCompletedHandler } from './shared.js';

// Clear-completed control lives inside the Completed section header so the
// action is co-located with the content it acts on. Confirmation uses the
// shared modal ConfirmDialog — the familiar OK/Cancel shape matches the rest
// of the app (cancel/complete task dialogs) and gives Enter/Escape bindings
// for free. Default scope sweeps user-initiated terminal states (completed +
// cancelled); terminated is opt-in via the checkbox inside the dialog. See
// rfc-task-loss-prevention.md D2.
//
export function ClearCompletedButton({
  finishedCount,
  terminatedCount,
  finishedTaskIds,
  terminatedTaskIds,
  projectId,
  onQueueClearCompleted,
}: {
  finishedCount: number;
  terminatedCount: number;
  finishedTaskIds: string[];
  terminatedTaskIds: string[];
  projectId?: string;
  onQueueClearCompleted?: QueueClearCompletedHandler;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [includeTerminated, setIncludeTerminated] = useState(false);

  // Hide when there is nothing we would sweep by default. The "Clear completed"
  // label would otherwise promise an action that produces a silent no-op —
  // the exact failure mode this PR set out to eliminate. Terminated-only cases
  // are handled by the per-row Ack / Reopen flow, not by bulk sweep.
  if (finishedCount === 0) return null;

  const openConfirm = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIncludeTerminated(false);
    setConfirmOpen(true);
  };
  const cancelConfirm = () => setConfirmOpen(false);
  const confirmClear = () => {
    const taskIds = includeTerminated
      ? [...finishedTaskIds, ...terminatedTaskIds]
      : finishedTaskIds;
    onQueueClearCompleted?.({
      includeTerminated,
      ...(projectId ? { projectId } : {}),
      taskIds,
      count: taskIds.length,
    });
    setConfirmOpen(false);
  };

  return (
    <>
      <button
        className="btn-clear-completed"
        onClick={openConfirm}
        aria-label="Clear completed tasks"
        title="Remove finished tasks (completed and cancelled) from the list"
      >
        Clear
      </button>
      {confirmOpen && (
        <ConfirmDialog
          title="Clear completed tasks"
          message={`Delete ${finishedCount} finished task${finishedCount === 1 ? '' : 's'}?`}
          confirmLabel="Delete"
          confirmClass="btn-danger"
          onConfirm={confirmClear}
          onClose={cancelConfirm}
        >
          {terminatedCount > 0 && (
            <label className="clear-completed-include-terminated">
              <input
                type="checkbox"
                checked={includeTerminated}
                onChange={(e) => setIncludeTerminated(e.target.checked)}
              />
              Also delete {terminatedCount} terminated task{terminatedCount === 1 ? '' : 's'}
            </label>
          )}
        </ConfirmDialog>
      )}
    </>
  );
}
