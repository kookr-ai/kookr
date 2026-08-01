import React, { useState, useEffect } from 'react';
import type { AgentState, ClientMessage } from '../../../shared/protocol.js';
import { track } from '../../telemetry.js';
import { useKookrStore } from '../../store/useStore.js';
import { Tooltip } from '../Tooltip.js';
import { TaskIdCopyButton } from '../TaskIdCopyButton.js';
import { ChildRollupPill } from '../RelatedTasksSection.js';
import { agentProjectLabel, agentProjectColor } from './shared.js';
import { RailRowSelectionTarget } from './RailRowSelectionTarget.js';
import { AgentProviderMark } from './AgentProviderMark.js';
import { PriorityBadge } from './PriorityBadge.js';
import { SpeakTaskSummaryControl } from './SpeakTaskSummaryControl.js';
import { TaskPriorityButton } from './TaskPriorityButton.js';

function formatCountdown(snoozedUntil: number): string {
  const remaining = Math.max(0, snoozedUntil - Date.now());
  if (remaining === 0) return 'resuming...';
  const totalSec = Math.ceil(remaining / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `resumes in ${h}h ${m}m`;
  if (m > 0) return `resumes in ${m}m ${s}s`;
  return `resumes in ${s}s`;
}

export function SnoozedRow({ agent, selected, send }: {
  agent: AgentState;
  selected: boolean;
  send: (msg: ClientMessage) => void;
}) {
  const [, setTick] = useState(0);
  const projectLabelText = agentProjectLabel(agent);
  const colorIdx = projectLabelText ? agentProjectColor(agent) : -1;

  // Update countdown every second
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  function selectSnoozedAgent() {
    track({ type: 'agent_clicked', agentId: agent.agentId, source: 'snoozed_row', anomalyType: agent.anomaly?.type ?? null });
    useKookrStore.getState().selectAgent(agent.agentId, agent.taskId);
  }

  return (
    <Tooltip text={agent.description}>
      <div
        className={`snoozed-row${selected ? ' selected' : ''}`}
        onClick={selectSnoozedAgent}
      >
        <RailRowSelectionTarget
          label={agent.taskName ?? agent.agentId}
          selected={selected}
          onActivate={selectSnoozedAgent}
        />
        <div className="snoozed-row-top">
          <AgentProviderMark agent={agent} state="snoozed" />
          {projectLabelText && (
            <span className={`project-badge color-${colorIdx}`} title={agent.cwd}>
              {projectLabelText}
            </span>
          )}
          <span className="snoozed-row-name" title={agent.taskName ?? agent.agentId}>
            {agent.taskName ?? agent.agentId}
          </span>
          <PriorityBadge agent={agent} />
          <ChildRollupPill agent={agent} />
          <TaskIdCopyButton taskId={agent.taskId} compact />
          <SpeakTaskSummaryControl agent={agent} selected={selected} />
        </div>
        <div className="snoozed-countdown">
          {agent.suppressed ? 'Paused' : `Snoozed · ${formatCountdown(agent.snoozedUntil!)}`}
          <TaskPriorityButton agent={agent} send={send} />
          {!agent.suppressed && (
            <button
              className="btn-xs"
              onClick={(e) => {
                e.stopPropagation();
                send({ type: 'cancelSnooze', agentId: agent.agentId, taskId: agent.taskId });
              }}
            >
              Resume now
            </button>
          )}
        </div>
      </div>
    </Tooltip>
  );
}
