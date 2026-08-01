import React from 'react';
import type { AgentState } from '../../../shared/protocol.js';

export function RalphLoopBadge({ agent }: { agent: AgentState }): React.ReactElement | null {
  const loop = agent.ralphLoop;
  if (!loop) return null;
  return (
    <span
      className="ralph-loop-badge"
      title={`Ralph loop: iteration ${loop.currentIteration}/${loop.iterationCap} (${loop.status})`}
    >
      {loop.currentIteration}/{loop.iterationCap}
    </span>
  );
}
