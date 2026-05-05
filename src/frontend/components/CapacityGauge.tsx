import React from 'react';
import type { AgentState } from '../../shared/protocol.js';
import { healthyDotClass } from '../presentation.js';

/**
 * Plain-text capacity indicator: "N/M running" in the top bar.
 * Green when under half capacity, amber over half, red when full.
 */
export function CapacityGauge({ agents }: { agents: AgentState[] }) {
  const runningCount = agents.filter((a) =>
    healthyDotClass(a.events) === 'running'
  ).length;

  const totalAgents = agents.length;

  let colorClass = 'cap-green';
  if (totalAgents > 0) {
    if (runningCount >= totalAgents) colorClass = 'cap-red';
    else if (runningCount > totalAgents / 2) colorClass = 'cap-amber';
  }

  return (
    <span
      className={`capacity-text ${colorClass}`}
      title={`${runningCount} of ${totalAgents} agent slot${totalAgents !== 1 ? 's' : ''} in use`}
    >
      {runningCount}/{totalAgents} running
    </span>
  );
}
