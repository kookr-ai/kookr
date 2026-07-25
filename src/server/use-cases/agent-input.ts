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
  /** Attributed caller id (issue #1526 Phase B — see actor-attribution.ts). Optional so existing callers stay unchanged. */
  actor?: string,
): Promise<DirectAgentInputResult> {
  await deps.adapter.sendInput(agentId, input);

  const timestamp = nowISO();
  await deps.interactionLog?.append({
    type: 'user_input',
    agentId,
    content: input,
    timestamp,
    ...(actor ? { actor } : {}),
  });

  return { timestamp };
}
