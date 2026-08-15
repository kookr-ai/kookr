import React, { useState } from 'react';
import type { AgentState, ClientMessage } from '../../../shared/protocol.js';
import { SnoozeDialog } from '../SnoozeDialog.js';

// Bulk snooze for the findings rail (issue #2421). Snooze is otherwise per-card;
// after a meeting or a noisy burst the whole attention queue has to be parked one
// click at a time. This control fans out the existing `snooze` message — one per
// visible finding — at a single chosen duration, so no new protocol type is added.
// Only the findings bucket is passed in, so healthy / pending / completed rows are
// never touched. The duration-picker modal (naming the count) is the required
// confirm step: closing it (Esc / backdrop) sends nothing.
export function SnoozeAllButton({
  findings,
  send,
}: {
  findings: AgentState[];
  send: (msg: ClientMessage) => void;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);

  // Nothing in scope → hide, so the label never promises a no-op. Mirrors the
  // hide-when-empty behaviour of "Abort all" (#1325) and "Clear completed".
  const count = findings.length;
  if (count === 0) return null;

  const label = `${count} finding${count === 1 ? '' : 's'}`;

  const openDialog = (e: React.MouseEvent) => {
    e.stopPropagation();
    setDialogOpen(true);
  };

  const snoozeAll = (durationMs: number) => {
    for (const agent of findings) {
      send({ type: 'snooze', agentId: agent.agentId, taskId: agent.taskId, durationMs });
    }
    setDialogOpen(false);
  };

  return (
    <>
      <button
        type="button"
        className="btn-snooze-all"
        onClick={openDialog}
        aria-label="Snooze all findings"
        title="Snooze the findings shown here for a chosen duration"
      >
        Snooze all
      </button>
      {dialogOpen && (
        <SnoozeDialog
          title={<>Snooze all <strong>{label}</strong></>}
          telemetry={{ bulk: true, count }}
          onSnooze={snoozeAll}
          onClose={() => setDialogOpen(false)}
        />
      )}
    </>
  );
}
