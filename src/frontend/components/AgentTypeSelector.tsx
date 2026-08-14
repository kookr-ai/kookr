import React from 'react';
import {
  previewRoundRobinNextLabel,
  ROUND_ROBIN_AGENT_TYPE,
  type AgentSelection,
  type AgentType,
  type AvailableAgentSelection,
} from '../../shared/protocol.js';

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
  /**
   * Server-advertised concrete agent for the next round-robin launch. When it
   * is still in `options`, the preview uses this instead of resolving from
   * {@link roundRobinIndex}.
   */
  nextAgentType?: AgentType;
  /** Rotation cursor matching the launch service's `roundRobinIndex`. */
  roundRobinIndex?: number;
  /**
   * When false, Grok is dropped from the preview rotation (same as launch
   * skipping an unusable grok-build). Omitted / true is fail-open.
   */
  grokAuthUsable?: boolean;
}

export function AgentTypeSelector({
  value,
  onChange,
  options,
  label = 'Agent',
  compact = false,
  defaultOptionLabel,
  nextAgentType,
  roundRobinIndex,
  grokAuthUsable,
}: Props) {
  const nextLabel = value === ROUND_ROBIN_AGENT_TYPE
    ? previewRoundRobinNextLabel(options, {
      cursor: roundRobinIndex,
      advertisedNext: nextAgentType,
      grokAuthUsable,
    })
    : undefined;

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
      {nextLabel && (
        <span className="agent-type-select-next">Next: {nextLabel}</span>
      )}
    </label>
  );
}
