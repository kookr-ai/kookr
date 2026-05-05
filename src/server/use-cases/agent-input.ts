import type { AgentAdapter } from '../../adapters/agent-adapter.js';
import type { DeferredInteractionLogWriter } from '../../core/interaction-log.js';
import { nowISO } from '../../core/interaction-log.js';
import type { AutonomyOrchestrator } from '../autonomy-orchestrator.js';

interface BaseInputDeps {
  adapter: Pick<AgentAdapter, 'sendInput'>;
  interactionLog?: DeferredInteractionLogWriter;
  autonomyOrchestrator?: Pick<AutonomyOrchestrator, 'onDirectReply' | 'onRestInput'>;
}

export interface DirectAgentInputResult {
  timestamp: string;
}

export async function sendDirectAgentInput(
  deps: BaseInputDeps,
  agentId: string,
  input: string,
  source: 'direct_reply' | 'rest_api',
): Promise<DirectAgentInputResult> {
  if (source === 'direct_reply') {
    deps.autonomyOrchestrator?.onDirectReply(agentId);
  } else {
    deps.autonomyOrchestrator?.onRestInput(agentId);
  }

  await deps.adapter.sendInput(agentId, input);

  const timestamp = nowISO();
  await deps.interactionLog?.append({
    type: 'user_input',
    agentId,
    content: input,
    timestamp,
  });

  return { timestamp };
}
