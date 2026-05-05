import React from 'react';
import type { AgentType, AutonomyLevel, AvailableAgentType } from '../../shared/protocol.js';
import { AgentTypeSelector } from './AgentTypeSelector.js';

interface Props {
  agentType: AgentType;
  onAgentTypeChange: (value: AgentType) => void;
  autonomy: AutonomyLevel;
  onAutonomyChange: (value: AutonomyLevel) => void;
  agentOptions: AvailableAgentType[];
}

export function AgentExecutionConfig({
  agentType,
  onAgentTypeChange,
  autonomy,
  onAutonomyChange,
  agentOptions,
}: Props) {
  return (
    <>
      <AgentTypeSelector
        value={agentType}
        onChange={onAgentTypeChange}
        options={agentOptions}
      />
      <label className="autonomy-toggle">
        <span className="autonomy-toggle-label">Autonomy</span>
        <div className="autonomy-options">
          <button
            type="button"
            className={`autonomy-option${autonomy === 'supervised' ? ' active' : ''}`}
            onClick={() => onAutonomyChange('supervised')}
          >
            Supervised
          </button>
          <button
            type="button"
            className={`autonomy-option${autonomy === 'autonomous' ? ' active' : ''}`}
            onClick={() => onAutonomyChange('autonomous')}
          >
            Autonomous
          </button>
        </div>
      </label>
    </>
  );
}
