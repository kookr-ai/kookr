import React from 'react';
import type { AgentState, ClientMessage } from '../../../shared/protocol.js';
import { track } from '../../telemetry.js';
import { useKookrStore } from '../../store/useStore.js';
import type { SchedulePrefill } from '../SchedulesDialog.js';
import { Tooltip } from '../Tooltip.js';
import { TaskIdCopyButton } from '../TaskIdCopyButton.js';
import { CoordinatorTaskChipView, coordinatorChipForTask } from '../CoordinatorSurfaces.js';
import { ChildRollupPill } from '../RelatedTasksSection.js';
import { agentProjectLabel, agentProjectColor } from './shared.js';
import { RailRowSelectionTarget } from './RailRowSelectionTarget.js';
import { AgentProviderMark } from './AgentProviderMark.js';
import { PriorityBadge } from './PriorityBadge.js';
import { SpeakTaskSummaryControl } from './SpeakTaskSummaryControl.js';
import { TaskPriorityButton } from './TaskPriorityButton.js';
import { SchedulePlaybookButton } from './SchedulePlaybookButton.js';

export function PendingRow({ agent, selected, send, onSchedulePlaybook }: {
  agent: AgentState;
  selected: boolean;
  send: (msg: ClientMessage) => void;
  onSchedulePlaybook?: (prefill: SchedulePrefill) => void;
}) {
  const projectLabelText = agentProjectLabel(agent);
  const colorIdx = projectLabelText ? agentProjectColor(agent) : -1;
  const coordinatorChip = coordinatorChipForTask(useKookrStore((s) => s.coordinator), agent.taskId);
  function selectPendingAgent() {
    track({ type: 'agent_clicked', agentId: agent.agentId, source: 'pending_row', anomalyType: null });
    useKookrStore.getState().selectAgent(agent.agentId, agent.taskId);
  }
  return (
    <Tooltip text={agent.description}>
      <div
        className={`pending-row${selected ? ' selected' : ''}`}
        onClick={selectPendingAgent}
      >
        <RailRowSelectionTarget
          label={agent.taskName ?? agent.agentId}
          selected={selected}
          onActivate={selectPendingAgent}
        />
        <div className="pending-row-top">
          <AgentProviderMark agent={agent} state="pending" />
          {projectLabelText && (
            <span className={`project-badge color-${colorIdx}`} title={agent.cwd}>
              {projectLabelText}
            </span>
          )}
          <span className="pending-row-name" title={agent.taskName ?? agent.agentId}>
            {agent.taskName ?? agent.agentId}
          </span>
          <PriorityBadge agent={agent} />
          <ChildRollupPill agent={agent} />
          <TaskIdCopyButton taskId={agent.taskId} compact />
          <SpeakTaskSummaryControl agent={agent} selected={selected} />
        </div>
        <div className="pending-row-meta">
          Queued · waiting for slot
          <TaskPriorityButton agent={agent} send={send} />
          <SchedulePlaybookButton agent={agent} onSchedule={onSchedulePlaybook} />
          {agent.taskId && (
            <button className="btn-xs btn-danger-xs" onClick={(e) => {
              e.stopPropagation();
              send({ type: 'cancelTask', taskId: agent.taskId! });
            }}>Cancel</button>
          )}
        </div>
        <CoordinatorTaskChipView chip={coordinatorChip} agent={agent} send={send} />
      </div>
    </Tooltip>
  );
}
