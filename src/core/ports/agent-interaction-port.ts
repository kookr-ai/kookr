export interface AgentInteractionPort {
  /** Send developer input to an agent's terminal session. */
  sendInput(sessionId: string, text: string): Promise<void>;

  /** Send a single keystroke without trailing Enter. */
  sendKeystroke(sessionId: string, key: string): Promise<void>;
}
