export interface SendInputOptions {
  /**
   * Checked immediately before the trailing Enter is written. Returning
   * `false` aborts the submit (the adapter throws `InputSubmitAbortedError`),
   * so a choice dialog that appeared while the text was being typed is not
   * answered by that Enter (issue #3513).
   */
  beforeSubmit?: () => boolean | Promise<boolean>;
}

export interface AgentInteractionPort {
  /** Send developer input to an agent's terminal session. */
  sendInput(sessionId: string, text: string, opts?: SendInputOptions): Promise<void>;

  /** Send a single keystroke without trailing Enter. */
  sendKeystroke(sessionId: string, key: string): Promise<void>;
}

/**
 * Thrown when a `beforeSubmit` / `beforeFinalPayload` check vetoes the submit
 * Enter (issue #3513): the agent began showing a choice dialog while the
 * message was being typed, and Enter would select its highlighted option.
 */
export class InputSubmitAbortedError extends Error {
  constructor(sessionId: string) {
    super(`input to ${sessionId} was not submitted: the agent began waiting on a choice before Enter`);
    this.name = 'InputSubmitAbortedError';
  }
}
