import React from 'react';
import type { AgentState, ClientMessage } from '../../../shared/protocol.js';

// Bulk resume for the Snoozed section header (issue #2550). Snooze already has a
// bulk control ("Snooze all", #2421) but un-snoozing was per-row only ("Resume
// now" on each SnoozedRow), so recovering from a broad snooze was tedious —
// proportional to the number of snoozed findings. This fans out the existing
// `cancelSnooze` message — one per snoozed agent — so no new protocol type,
// store, or server change is added. It mirrors the co-located, hide-when-empty
// shape of "Clear completed" and "Snooze all".
//
// Suppressed agents are excluded: they are Paused (audio suppressed / DnD), not
// timer-snoozed, and their SnoozedRow renders no per-row "Resume now" — so the
// bulk action must not touch them either. Resume is non-destructive (a resumed
// finding can simply be snoozed again), so no confirm step is needed for a first
// cut, matching the per-row "Resume now" which also acts on a single click.
export function ResumeAllButton({
  snoozed,
  send,
}: {
  snoozed: AgentState[];
  send: (msg: ClientMessage) => void;
}) {
  // Only timer-snoozed agents are resumable; suppressed (Paused) rows are out of
  // scope — see note above.
  const resumable = snoozed.filter((agent) => !agent.suppressed);

  // Nothing in scope → hide, so the label never promises a no-op. Mirrors the
  // hide-when-empty behaviour of "Snooze all" and "Clear completed".
  if (resumable.length === 0) return null;

  const resumeAll = (e: React.MouseEvent) => {
    // The button sits inside the clickable section header; stop the click from
    // bubbling to the section toggle / panel selection handler.
    e.stopPropagation();
    for (const agent of resumable) {
      send({ type: 'cancelSnooze', agentId: agent.agentId, taskId: agent.taskId });
    }
  };

  return (
    <button
      type="button"
      className="btn-resume-all"
      onClick={resumeAll}
      aria-label="Resume all snoozed findings"
      title="Resume every snoozed finding now"
    >
      Resume all
    </button>
  );
}
