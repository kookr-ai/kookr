import { InputSubmitAbortedError, type SendInputOptions } from './ports/agent-interaction-port.js';

/** True when the agent is sitting on a choice dialog (see `Monitor.isAwaitingChoice`). */
export type AwaitingChoiceProbe = (agentId: string) => boolean;

/**
 * Thrown when typing into the session would answer a choice dialog (issue
 * #3513): the agent is showing a permission prompt or an `AskUserQuestion`
 * menu, where the pasted text is discarded and the trailing Enter selects the
 * highlighted option on the caller's behalf.
 */
export class AgentInputRefusedError extends Error {
  readonly code = 'awaiting_choice' as const;

  constructor(agentId: string) {
    super(
      `agent ${agentId} is waiting on a choice (permission prompt or question menu); ` +
        'typing a reply would press Enter and pick the highlighted option, so it was not sent. ' +
        'Read the menu with `kookr peek`, then answer it in the Kookr dashboard ' +
        '(permission buttons, or keys typed in the task terminal).',
    );
    this.name = 'AgentInputRefusedError';
  }
}

/**
 * Refuse up front if the agent is on a choice dialog, and build the
 * `beforeSubmit` re-check that vetoes the trailing Enter if one appears while
 * the text is being typed. Shared by every free-text input path.
 */
export function guardChoiceDialog(
  agentId: string,
  isAwaitingChoice: AwaitingChoiceProbe | undefined,
): SendInputOptions | undefined {
  if (!isAwaitingChoice) return undefined;
  if (isAwaitingChoice(agentId)) throw new AgentInputRefusedError(agentId);
  return { beforeSubmit: () => !isAwaitingChoice(agentId) };
}

/** Map an adapter-level submit veto to the caller-facing refusal. */
export function asInputRefusal(err: unknown, agentId: string): unknown {
  return err instanceof InputSubmitAbortedError ? new AgentInputRefusedError(agentId) : err;
}
