import type { TerminalSourceRange, TerminalStreamSnapshot } from '../shared/terminal-stream.js';
import type { SessionId } from './terminal-backend.js';

/** Synchronous read of a session's retained ring, as `captureStreamSnapshot` returns it. */
export interface TerminalRingReader {
  captureStreamSnapshot(id: SessionId): TerminalStreamSnapshot;
}

/**
 * Sees every byte a session's ring retains, in order, as it is retained
 * (issue #3564, step 2: live screen models).
 *
 * Called synchronously on the PTY data path, so an implementation must only
 * record the bytes and return; anything costly belongs on another thread.
 * It must not throw: the backend swallows a throw, but the bytes are then lost
 * to the observer.
 */
export interface TerminalRingObserver {
  /**
   * `bytes` were just appended to the ring of `id`; `range` gives their source
   * positions and the PTY geometry they were written at. `ring` reads the ring
   * as it is now (already including `bytes`).
   */
  onRingAppend(id: SessionId, bytes: Uint8Array, range: TerminalSourceRange, ring: TerminalRingReader): void;
  /** The session's attach was disposed: no more bytes will follow for it. */
  onSessionDisposed(id: SessionId): void;
}
