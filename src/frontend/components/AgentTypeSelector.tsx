import React from 'react';
import type { AgentSelection, AvailableAgentSelection } from '../../shared/protocol.js';

/** Empty string means "use server default" (no schedule pin). */
export type AgentTypeSelectorValue = AgentSelection | '';

interface Props {
  value: AgentTypeSelectorValue;
  onChange: (value: AgentTypeSelectorValue) => void;
  options: AvailableAgentSelection[];
  label?: string;
  compact?: boolean;
  /** Label for the empty/server-default option. When set, prepends that choice. */
  defaultOptionLabel?: string;
}

export function AgentTypeSelector({
  value,
  onChange,
  options,
  label = 'Agent',
  compact = false,
  defaultOptionLabel,
}: Props) {
  return (
    <label className={compact ? 'agent-type-select compact' : 'agent-type-select'}>
      <span className="agent-type-select-label">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as AgentTypeSelectorValue)}
      >
        {defaultOptionLabel !== undefined && (
          <option value="">{defaultOptionLabel}</option>
        )}
        {options.map((option) => (
          <option key={option.type} value={option.type}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
