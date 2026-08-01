import React, { useState, useEffect, useMemo } from 'react';
import type { AgentState, ClientMessage } from '../../../shared/protocol.js';
import { trackClick } from '../../telemetry.js';
import { groupIdenticalPendingPrompts, groupLabel } from '../../group-findings.js';
import { useKookrStore } from '../../store/useStore.js';
import { severityClass, severityLabel, visibleFindingAgents, isSelectedAgent, agentRowKey } from './shared.js';
import { FindingCard } from './FindingCard.js';
import { FindingGroupRenderCap } from './FindingGroupRenderCap.js';

export const FindingGroup = React.memo(function FindingGroup({ type, agents, selectedAgentId, selectedTaskId, send }: {
  type: string;
  agents: AgentState[];
  selectedAgentId: string | null;
  selectedTaskId: string | null;
  send: (msg: ClientMessage) => void;
}): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  const [showAllAgents, setShowAllAgents] = useState(false);
  const setRespondAllAgentIds = useKookrStore((s) => s.setRespondAllAgentIds);
  const selectAgent = useKookrStore((s) => s.selectAgent);
  const selectedInGroup = agents.some((agent) => isSelectedAgent(agent, selectedAgentId, selectedTaskId));
  // A `needs_input` group can mix completed turns and explicit AskUserQuestion
  // waits. The header should only read as a completed turn when every member
  // is one — otherwise pick a non-completed member so it stays "Needs Input".
  // See issue #358.
  const headerAgent = agents.find((a) => a.turnState !== 'completed_turn') ?? agents[0];
  const cls = headerAgent ? severityClass(headerAgent) : '';
  const visibleAgents = visibleFindingAgents(agents, selectedAgentId, selectedTaskId, showAllAgents);
  const identicalPromptGroups = useMemo(() => groupIdenticalPendingPrompts(agents), [agents]);

  useEffect(() => {
    if (selectedInGroup) setExpanded(true);
  }, [selectedInGroup]);

  function handleRespondAll(e: React.MouseEvent, targetAgents = agents, trackingTarget = 'respond_all') {
    e.stopPropagation();
    if (targetAgents.length === 0) return;
    const agentIds = targetAgents.map(a => a.agentId);
    setRespondAllAgentIds(agentIds);
    // Select the first agent so the detail panel has context
    selectAgent(targetAgents[0].agentId, targetAgents[0].taskId);
    // Re-set respondAllAgentIds since selectAgent clears it
    useKookrStore.getState().setRespondAllAgentIds(agentIds);
    trackClick(trackingTarget);
    // Focus the response input after React re-renders
    requestAnimationFrame(() => {
      const input = document.querySelector('.response-area textarea') as HTMLTextAreaElement | null;
      input?.focus();
    });
  }

  function handleSkipAll(e: React.MouseEvent) {
    e.stopPropagation();
    trackClick('skip_all');
    send({ type: 'skipAll', agentIds: agents.map(a => a.agentId) });
  }

  function handleApproveIdenticalPrompt(
    e: React.MouseEvent,
    targetAgents: AgentState[],
    approvalResponse: string,
  ) {
    e.stopPropagation();
    if (targetAgents.length === 0) return;
    trackClick('approve_identical_prompt');
    send({ type: 'respondAll', agentIds: targetAgents.map((agent) => agent.agentId), input: approvalResponse });
  }

  function handleIdenticalPromptAction(
    e: React.MouseEvent,
    group: ReturnType<typeof groupIdenticalPendingPrompts>[number],
  ) {
    if (group.approvalResponse) {
      handleApproveIdenticalPrompt(e, group.agents, group.approvalResponse);
      return;
    }

    handleRespondAll(e, group.agents, 'respond_identical_prompt');
  }

  return (
    <div className={`finding-group ${cls}`}>
      <div
        className="finding-group-header"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="finding-group-toggle">{expanded ? '▾' : '▸'}</span>
        <span className={`finding-severity ${cls}`}>{severityLabel(headerAgent)}</span>
        <span className="finding-group-label">
          {agents.length} agents {groupLabel(type)}
        </span>
        <span className="finding-group-actions">
          <button className="btn-xs" onClick={handleSkipAll}>Skip All</button>
          <button className="btn-xs btn-primary-xs" onClick={handleRespondAll}>Respond to All</button>
        </span>
      </div>
      {identicalPromptGroups.length > 0 && (
        <div className="finding-identical-prompts" aria-label="Identical pending prompts">
          {identicalPromptGroups.map((group) => (
            <button
              key={group.key}
              type="button"
              className={`btn-xs finding-identical-prompt-action${group.approvalResponse ? ' finding-identical-prompt-action--approve' : ''}`}
              aria-label={`${group.approvalResponse ? 'Approve' : 'Reply to'} matching prompt "${group.prompt}" for ${group.agents.length} agents`}
              title={group.prompt}
              onClick={(e) => handleIdenticalPromptAction(e, group)}
            >
              {group.approvalResponse ? 'Approve' : 'Reply to'} matching ({group.agents.length})
            </button>
          ))}
        </div>
      )}
      {expanded && (
        <>
          {visibleAgents.map((agent) => (
            <FindingCard
              key={agentRowKey(agent)}
              agent={agent}
              selected={isSelectedAgent(agent, selectedAgentId, selectedTaskId)}
              send={send}
            />
          ))}
          <FindingGroupRenderCap
            visibleCount={visibleAgents.length}
            totalCount={agents.length}
            label="findings in this group"
            onShowAll={() => setShowAllAgents(true)}
          />
        </>
      )}
    </div>
  );
});
