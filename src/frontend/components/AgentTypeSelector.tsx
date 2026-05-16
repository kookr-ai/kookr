import React from 'react';
import type { AgentSelection, AvailableAgentSelection } from '../../shared/protocol.js';

interface Props {
  value: AgentSelection;
  onChange: (value: AgentSelection) => void;
  options: AvailableAgentSelection[];
  label?: string;
  compact?: boolean;
}

export function AgentTypeSelector({ value, onChange, options, label = 'Agent', compact = false }: Props) {
  return (
    <label className={compact ? 'agent-type-select compact' : 'agent-type-select'}>
      <span className="agent-type-select-label">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value as AgentSelection)}>
        {options.map((option) => (
          <option key={option.type} value={option.type}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
