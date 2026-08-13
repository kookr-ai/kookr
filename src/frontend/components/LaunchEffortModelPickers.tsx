import React from 'react';
import type { AgentSelection } from '../../shared/protocol.js';
import { effortOptionsForSelection, modelOptionsForSelection } from './launch-effort-model.js';

interface Props {
  agentType: AgentSelection;
  effort: string;
  model: string;
  onEffortChange: (value: string) => void;
  onModelChange: (value: string) => void;
  compact?: boolean;
}

/**
 * Per-task effort and model selects for a dashboard launch.
 *
 * Each select appears only when the resolved agent accepts that pin.
 * Grok Build hides both (no validated effort or model allowlist). Codex
 * shows effort and hides model. Round-robin hides both until a concrete
 * agent is chosen — the server validates against the resolved type.
 */
export function LaunchEffortModelPickers({
  agentType,
  effort,
  model,
  onEffortChange,
  onModelChange,
  compact = false,
}: Props) {
  const effortLevels = effortOptionsForSelection(agentType);
  const modelIds = modelOptionsForSelection(agentType);
  if (effortLevels.length === 0 && modelIds.length === 0) return null;

  const selectClass = compact ? 'agent-type-select compact' : 'agent-type-select';

  return (
    <div className={compact ? 'launch-effort-model-pickers compact' : 'launch-effort-model-pickers'}>
      {effortLevels.length > 0 && (
        <label className={selectClass}>
          <span className="agent-type-select-label">Effort</span>
          <select
            aria-label="Reasoning effort"
            value={effort}
            onChange={(e) => onEffortChange(e.target.value)}
          >
            <option value="">Agent default</option>
            {effortLevels.map((level) => (
              <option key={level} value={level}>{level}</option>
            ))}
          </select>
        </label>
      )}
      {modelIds.length > 0 && (
        <label className={selectClass}>
          <span className="agent-type-select-label">Model</span>
          <select
            aria-label="Model"
            value={model}
            onChange={(e) => onModelChange(e.target.value)}
          >
            <option value="">Agent default</option>
            {modelIds.map((id) => (
              <option key={id} value={id}>{id}</option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}
