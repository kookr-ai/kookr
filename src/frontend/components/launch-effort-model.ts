import {
  effortLevelsForAgent,
  isAgentType,
  modelSuggestionsForAgent,
  isValidLaunchPin,
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

/** Effort levels for a concrete agent; empty when the selection is unresolved. */
export function effortOptionsForSelection(agentType: AgentSelection): readonly string[] {
  return isAgentType(agentType) ? effortLevelsForAgent(agentType) : [];
}

/** Current model suggestions for a concrete agent; custom values remain valid. */
export function modelOptionsForSelection(agentType: AgentSelection): readonly string[] {
  return isAgentType(agentType) ? modelSuggestionsForAgent(agentType) : [];
}

function acceptedPin(value: string): string {
  return value && isValidLaunchPin(value) ? value : '';
}

/**
 * Keep only lexically safe pins. Capability suggestions are advisory, so a
 * valid custom value remains editable even when the agent has no enumeration.
 */
export function sanitizeLaunchPins(
  effort: string,
  model: string,
): { effort: string; model: string } {
  return {
    effort: acceptedPin(effort),
    model: acceptedPin(model),
  };
}

/** Restore last-sent pins that are still safe to send. */
export function restoreLastLaunchPins(): { effort: string; model: string } {
  return sanitizeLaunchPins(loadLastEffort() ?? '', loadLastModel() ?? '');
}
