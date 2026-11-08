import type { AgentAdapter } from '../../adapters/agent-adapter.js';
import {
  AgentInputRefusedError,
  asInputRefusal,
  guardChoiceDialog,
  type AwaitingChoiceProbe,
} from '../../core/choice-dialog-guard.js';
import type { DeferredInteractionLogWriter } from '../../core/interaction-log.js';
import { nowISO } from '../../core/interaction-log.js';

export { AgentInputRefusedError, asInputRefusal, guardChoiceDialog, type AwaitingChoiceProbe };

interface BaseInputDeps {
  adapter: Pick<AgentAdapter, 'sendInput'>;
  interactionLog?: DeferredInteractionLogWriter;
  /**
   * Gates delivery (issue #3513). Optional only so narrow test doubles and
   * callers without a monitor stay valid; production wiring always supplies it.
   */
  isAwaitingChoice?: AwaitingChoiceProbe;
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
  const sendOpts = guardChoiceDialog(agentId, deps.isAwaitingChoice);
  try {
    await (sendOpts ? deps.adapter.sendInput(agentId, input, sendOpts) : deps.adapter.sendInput(agentId, input));
  } catch (err) {
    throw asInputRefusal(err, agentId);
  }

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
