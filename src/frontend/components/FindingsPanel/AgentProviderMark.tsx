import React from 'react';
import type { AgentState } from '../../../shared/protocol.js';
import { agentProviderPresentation } from '../../presentation.js';

export function AgentProviderMark({
  agent,
  state,
}: {
  agent: AgentState;
  state: 'running' | 'done' | 'pending' | 'snoozed' | 'completed' | 'cancelled' | 'terminated' | 'finding';
}): React.ReactElement {
  if (!agent.agentType) {
    return <span className={`agent-provider-mark agent-provider-mark--fallback agent-provider-mark--${state}`} aria-hidden="true" />;
  }

  const provider = agentProviderPresentation(agent.agentType);
  const title = `${provider.label} by ${provider.provider}`;

  return (
    <span
      className={`agent-provider-mark agent-provider-mark--${agent.agentType} agent-provider-mark--${state}`}
      title={title}
      role="img"
      aria-label={title}
    >
      <svg className="agent-provider-mark-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d={provider.iconPath} />
      </svg>
    </span>
  );
}
