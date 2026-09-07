import {
  effortLevelsForAgent,
  isAgentType,
  modelsForAgent,
  type AgentSelection,
} from '../../shared/protocol.js';
import { loadLastEffort, loadLastModel } from '../store/last-launch-pins.js';

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

/** Effort levels for a concrete agent/model pair; empty when the agent is unresolved. */
export function effortOptionsForSelection(
  agentType: AgentSelection,
  model?: string,
): readonly string[] {
  return isAgentType(agentType) ? effortLevelsForAgent(agentType, model) : [];
}

/** Known model ids for a concrete agent; empty when that agent rejects a pin. */
export function modelOptionsForSelection(agentType: AgentSelection): readonly string[] {
  return isAgentType(agentType) ? modelsForAgent(agentType) : [];
}

function acceptedPin(value: string, options: readonly string[]): string {
  return value && options.includes(value) ? value : '';
}

/**
 * Keep only pins the resolved agent can show in its pickers.
 * Anything else becomes "" so the menu stays on "Agent default".
 */
export function sanitizeLaunchPins(
  agentType: AgentSelection,
  effort: string,
  model: string,
): { effort: string; model: string } {
  const acceptedModel = acceptedPin(model, modelOptionsForSelection(agentType));
  return {
    effort: acceptedPin(effort, effortOptionsForSelection(agentType, acceptedModel)),
    model: acceptedModel,
  };
}

/** Restore last-sent pins that the current agent still accepts. */
export function restoreLastLaunchPins(agentType: AgentSelection): { effort: string; model: string } {
  return sanitizeLaunchPins(agentType, loadLastEffort() ?? '', loadLastModel() ?? '');
}
