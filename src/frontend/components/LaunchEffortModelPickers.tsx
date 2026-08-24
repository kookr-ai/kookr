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
 * Both controls are available for every concrete agent. Suggestions are
 * capability hints; custom values remain editable while harnesses evolve.
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
  if (agentType === 'round-robin') return null;

  const selectClass = compact ? 'agent-type-select compact' : 'agent-type-select';

  return (
    <div className={compact ? 'launch-effort-model-pickers compact' : 'launch-effort-model-pickers'}>
      <label className={selectClass}>
        <span className="agent-type-select-label">Effort</span>
        {effortLevels.length > 0 ? (<>
          <select
            aria-label="Reasoning effort"
            value={effort}
            onChange={(e) => onEffortChange(e.target.value)}
          >
            <option value="">Agent default</option>
            {effortLevels.map((level) => (
              <option key={level} value={level}>{level}</option>
            ))}
            {effort && !effortLevels.includes(effort) && <option value={effort}>{effort} (custom)</option>}
          </select>
          <input
            aria-label="Custom reasoning effort"
            value={effort && !effortLevels.includes(effort) ? effort : ''}
            placeholder="Custom effort"
            onChange={(e) => onEffortChange(e.target.value)}
          />
        </>) : (
          <input
            aria-label="Reasoning effort"
            value={effort}
            placeholder="Agent default or custom"
            onChange={(e) => onEffortChange(e.target.value)}
          />
        )}
      </label>
      <label className={selectClass}>
        <span className="agent-type-select-label">Model</span>
        {modelIds.length > 0 ? (<>
          <select
            aria-label="Model"
            value={model}
            onChange={(e) => onModelChange(e.target.value)}
          >
            <option value="">Agent default</option>
            {modelIds.map((id) => (
              <option key={id} value={id}>{id}</option>
            ))}
            {model && !modelIds.includes(model) && <option value={model}>{model} (custom)</option>}
          </select>
          <input
            aria-label="Custom model"
            value={model && !modelIds.includes(model) ? model : ''}
            placeholder="Custom model"
            onChange={(e) => onModelChange(e.target.value)}
          />
        </>) : (
          <input
            aria-label="Model"
            value={model}
            placeholder="Agent default or custom"
            onChange={(e) => onModelChange(e.target.value)}
          />
        )}
      </label>
    </div>
  );
}
