import type { TerminalSourceRange } from '../../shared/terminal-stream.js';

export type TerminalSessionDataSource = 'attach-replay' | 'live';

export interface TerminalSessionStreamPort {
  /** Enumerate currently-known terminal sessions. */
  listSessions(): Promise<string[]>;

  /**
   * Subscribe to bytes emitted by a terminal session as they arrive.
   * Returns an unsubscribe function.
   */
  onData(id: string, cb: (data: Uint8Array, source?: TerminalSessionDataSource, range?: TerminalSourceRange) => void): () => void;
  /** Loss invalidates relay cursors immediately, including when no later byte arrives. */
  onStreamGap?(cb: (id: string) => void): () => void;
}
