export interface TerminalSessionStreamPort {
  /** Enumerate currently-known terminal sessions. */
  listSessions(): Promise<string[]>;

  /**
   * Subscribe to bytes emitted by a terminal session as they arrive.
   * Returns an unsubscribe function.
   */
  onData(id: string, cb: (data: Uint8Array) => void): () => void;
}
