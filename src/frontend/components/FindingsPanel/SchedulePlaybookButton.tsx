import React from 'react';
import type { AgentState } from '../../../shared/protocol.js';
import { trackClick } from '../../telemetry.js';
import type { SchedulePrefill } from '../SchedulesDialog.js';
import { ScheduleIcon } from './icons.js';

/**
 * Small icon button shown on playbook-backed task rows. Clicking it opens the
 * Schedules dialog pre-seeded with this task's playbook + working directory, so
 * the user only has to choose a cron. Renders nothing for tasks not launched
 * from a playbook, and nothing when no scheduler callback is wired.
 */
export function SchedulePlaybookButton({ agent, onSchedule }: {
  agent: AgentState;
  onSchedule?: (prefill: SchedulePrefill) => void;
}): React.ReactElement | null {
  if (!onSchedule || !agent.playbookId) return null;
  const playbookId = agent.playbookId;
  return (
    <button
      type="button"
      className="btn-xs schedule-playbook-btn"
      title="Schedule this playbook"
      aria-label="Schedule this playbook"
      onClick={(e) => {
        e.stopPropagation();
        trackClick('schedule_playbook');
        onSchedule({
          cwd: agent.cwd ?? '',
          playbookSource: agent.playbookSource,
          playbookParameterValues: agent.playbookParameterValues,
          name: agent.taskName ?? playbookId,
        });
      }}
    >
      <ScheduleIcon />
    </button>
  );
}
