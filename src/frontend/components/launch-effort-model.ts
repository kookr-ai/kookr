import {
  effortLevelsForAgent,
  isAgentType,
  modelsForAgent,
  type AgentSelection,
} from '../../shared/protocol.js';

/**
 * Optional pins for a dashboard launch payload.
 *
 * Empty strings mean "leave unset" so the server applies the per-agent
 * default (or the agent CLI / env default). The WS schema rejects empty
 * strings, so callers must omit those keys rather than send them blank.
 */
export function optionalLaunchPins(
  effort: string,
  model: string,
): { effort?: string; model?: string } {
  return {
    ...(effort.trim() ? { effort: effort.trim() } : {}),
    ...(model.trim() ? { model: model.trim() } : {}),
  };
}

/** Effort levels for a concrete agent; empty when the selection is unresolved. */
export function effortOptionsForSelection(agentType: AgentSelection): readonly string[] {
  return isAgentType(agentType) ? effortLevelsForAgent(agentType) : [];
}

/** Known model ids for a concrete agent; empty when that agent rejects a pin. */
export function modelOptionsForSelection(agentType: AgentSelection): readonly string[] {
  return isAgentType(agentType) ? modelsForAgent(agentType) : [];
}
