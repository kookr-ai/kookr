import type { AgentAdapter } from '../../adapters/agent-adapter.js';
import type { DeferredInteractionLogWriter } from '../../core/interaction-log.js';
import { nowISO } from '../../core/interaction-log.js';

interface BaseInputDeps {
  adapter: Pick<AgentAdapter, 'sendInput'>;
  interactionLog?: DeferredInteractionLogWriter;
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
