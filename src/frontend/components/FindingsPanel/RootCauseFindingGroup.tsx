import React, { useState, useEffect } from 'react';
import type { AgentState, ClientMessage } from '../../../shared/protocol.js';
import { visibleFindingAgents, isSelectedAgent, agentRowKey } from './shared.js';
import { FindingCard } from './FindingCard.js';
import { FindingGroupRenderCap } from './FindingGroupRenderCap.js';

export const RootCauseFindingGroup = React.memo(function RootCauseFindingGroup({ root, related, selectedAgentId, selectedTaskId, send }: {
  root: AgentState;
  related: AgentState[];
  selectedAgentId: string | null;
  selectedTaskId: string | null;
  send: (msg: ClientMessage) => void;
}): React.ReactElement {
  const [expanded, setExpanded] = useState(true);
  const [showAllRelated, setShowAllRelated] = useState(false);
  const visibleRelated = visibleFindingAgents(related, selectedAgentId, selectedTaskId, showAllRelated);
  const selectedInRelated = related.some((agent) => isSelectedAgent(agent, selectedAgentId, selectedTaskId));

  useEffect(() => {
    if (selectedInRelated) setExpanded(true);
  }, [selectedInRelated]);

  return (
    <div className="root-cause-group">
      <div className="root-cause-root">
        <FindingCard
          agent={root}
          selected={isSelectedAgent(root, selectedAgentId, selectedTaskId)}
          send={send}
        />
        <button
          type="button"
          className="root-cause-toggle"
          aria-label={expanded ? 'Hide related findings' : 'Show related findings'}
          title={expanded ? 'Hide related findings' : 'Show related findings'}
          aria-expanded={expanded}
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((value) => !value);
          }}
        >
          {expanded ? '▾' : '▸'}
        </button>
      </div>
      {expanded && (
        <div className="root-cause-related">
          {visibleRelated.map((agent) => (
            <FindingCard
              key={agentRowKey(agent)}
              agent={agent}
              selected={isSelectedAgent(agent, selectedAgentId, selectedTaskId)}
              send={send}
            />
          ))}
          <FindingGroupRenderCap
            visibleCount={visibleRelated.length}
            totalCount={related.length}
            label="related findings"
            onShowAll={() => setShowAllRelated(true)}
          />
        </div>
      )}
    </div>
  );
});
