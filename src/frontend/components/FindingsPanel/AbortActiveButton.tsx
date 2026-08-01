import React, { useState } from 'react';
import type { ClientMessage } from '../../../shared/protocol.js';
import { ConfirmDialog } from '../ConfirmDialog.js';

// Control-room bulk shutdown (issue #1325). One confirmed action interrupts
// every live session and cancels every active task in scope — replacing the
// old pattern of fanning out "abort your work" prose to each agent. The server
// answers with a concise result toast (aborted / already-finished / failed);
// retries are idempotent, so a double-click never double-cancels.
export function AbortActiveButton({
  taskIds,
  send,
}: {
  taskIds: string[];
  send: (msg: ClientMessage) => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Nothing active to abort → hide, so the label never promises a no-op.
  if (taskIds.length === 0) return null;

  const count = taskIds.length;
  const openConfirm = (e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmOpen(true);
  };
  const confirmAbort = () => {
    send({ type: 'batchAbortTasks', taskIds });
    setConfirmOpen(false);
  };

  return (
    <>
      <button
        type="button"
        className="btn-abort-active"
        onClick={openConfirm}
        aria-label="Abort all active tasks"
        title="Interrupt live sessions and cancel all active tasks"
      >
        Abort all
      </button>
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
    </>
  );
}
