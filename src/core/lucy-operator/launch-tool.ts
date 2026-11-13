/**
 * `propose_launch`: the only tool of hers that leads to a change, and the reason it is not
 * in `tools.ts` (whose header says a tool that changes something does not belong there).
 *
 * The tool is a signal and nothing more. It has no arguments. When the model calls it, the
 * server writes the task description itself, from the operator's own words in this
 * conversation (see `launch-proposal.ts`), checks it, and holds it as a proposal that only
 * the operator can confirm. Whatever the model put in the call's arguments is never read, so
 * text an agent wrote cannot reach a proposal through the model.
 *
 * Confirming is not a tool either. It happens in the server, before the model is called,
 * on the operator's next turn, or through the confirm route.
 */

import type { LlmFunctionTool } from '../llm-types.js';
import { LUCY_PROPOSE_LAUNCH_TOOL } from '../../shared/contracts/lucy-turn.js';
import type { LucyLaunchProposalView } from '../../shared/contracts/lucy-launch.js';

export const LUCY_PROPOSE_LAUNCH: LlmFunctionTool = {
  type: 'function',
  function: {
    name: LUCY_PROPOSE_LAUNCH_TOOL,
    description:
      'Call this when the operator asks you to start work: investigate something, fix something, build something. It takes no arguments: Kookr writes the task from the operator\'s own words and shows them a card to confirm. Nothing starts until they confirm. Do not call it for a question about status.',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
};

/** What the server did with a request to propose. */
export type LucyProposeResult =
  /** A proposal is now held. `say` is the read-back she speaks, written by the server. */
  | { ok: true; proposal: LucyLaunchProposalView; say: string }
  /** No proposal: `say` is a question or a reason, written by the server, for her to speak as it is. */
  | { ok: false; say: string; why: string };

/** The server side of `propose_launch`. */
export interface LucyLaunchPort {
  /**
   * Make a proposal from the operator's words. `operatorWords` are the operator's own messages
   * of this conversation, oldest first, ending with the current one. Nothing else is passed.
   */
  propose(input: { conversationId: string; operatorWords: readonly string[]; spoken?: boolean; signal?: AbortSignal }): Promise<LucyProposeResult>;
}
