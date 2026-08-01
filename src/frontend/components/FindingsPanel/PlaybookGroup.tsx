import React, { useState } from 'react';
import type { AgentState, ClientMessage } from '../../../shared/protocol.js';
import type { SchedulePrefill } from '../SchedulesDialog.js';
import { isSelectedAgent, agentRowKey } from './shared.js';
import { HealthyRow } from './HealthyRow.js';
import { SchedulePlaybookButton } from './SchedulePlaybookButton.js';

export function PlaybookGroup({ playbookId, agents, selectedAgentId, selectedTaskId, send, onSchedulePlaybook }: {
  playbookId: string;
  agents: AgentState[];
  selectedAgentId: string | null;
  selectedTaskId: string | null;
  send: (msg: ClientMessage) => void;
  onSchedulePlaybook?: (prefill: SchedulePrefill) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const latest = agents[0]; // Most recent iteration (agents sorted by startedAt descending)

  return (
    <div className="playbook-group">
      <div
        className="playbook-group-header"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="playbook-group-toggle">{expanded ? '▾' : '▸'}</span>
        <span className="playbook-group-name">{latest.taskName ?? playbookId}</span>
        <span className="playbook-group-count">{agents.length} runs</span>
        <SchedulePlaybookButton agent={latest} onSchedule={onSchedulePlaybook} />
      </div>
      {/* Rows inside a group don't repeat the schedule button — the group header
          already carries one for the shared playbook. */}
      {expanded && agents.map((agent) => (
        <HealthyRow
          key={agentRowKey(agent)}
          agent={agent}
          selected={isSelectedAgent(agent, selectedAgentId, selectedTaskId)}
          send={send}
        />
      ))}
      {!expanded && (
        <HealthyRow
          agent={latest}
          selected={isSelectedAgent(latest, selectedAgentId, selectedTaskId)}
          send={send}
        />
      )}
    </div>
  );
}
