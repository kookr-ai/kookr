import React from 'react';
import type { AgentState } from '../../../shared/protocol.js';

export function PriorityBadge({ agent }: { agent: AgentState }): React.ReactElement | null {
  if (agent.priority !== 'high') return null;
  return (
    <span className="task-priority-badge" title="High priority">
      High
    </span>
  );
}
