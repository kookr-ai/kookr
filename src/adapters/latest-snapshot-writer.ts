interface SnapshotWriterOptions {
  commit(id: string, bytes: Uint8Array): Promise<void>;
  onError(id: string, error: unknown): void;
  maxBytes?: number;
  maxSessions?: number;
}
interface SessionWrite {
  active: Promise<void> | null;
  pending: Uint8Array | null;
  retiring: boolean;
}

/**
 * Persists a bounded set of snapshots without queuing every flush tick. Each
 * session has one disk write and at most one newer snapshot waiting behind it.
 */
export function createLatestSnapshotWriter(options: SnapshotWriterOptions) {
  const maxBytes = options.maxBytes ?? 32 * 1024 * 1024;
  const maxSessions = options.maxSessions ?? 256;
  const sessions = new Map<string, SessionWrite>();
  let pendingBytes = 0;
  let rejected = 0;

  function start(id: string, state: SessionWrite, bytes: Uint8Array) {
    // Invoke commit immediately but contain synchronous implementations too.
    let commit: Promise<void>;
    try { commit = options.commit(id, bytes); } catch (error) { commit = Promise.reject(error); }
    state.active = commit.catch((error) => {
      try { options.onError(id, error); } catch { /* Reporting cannot strand disk ownership. */ }
    }).then(() => {
      pendingBytes -= bytes.byteLength;
      state.active = null;
      const next = state.pending;
      state.pending = null;
      if (next && !state.retiring) start(id, state, next);
      else if (!state.retiring) sessions.delete(id);
    });
  }

  async function drainSession(state: SessionWrite) {
    while (state.active) await state.active;
  }

  return {
    /** Takes ownership of an already-copied snapshot only when admitted. */
    enqueue(id: string, bytes: Uint8Array): boolean {
      let state = sessions.get(id);
      const oldBytes = state?.pending?.byteLength ?? 0;
      if (state?.retiring || (!state && sessions.size >= maxSessions)
        || pendingBytes - oldBytes + bytes.byteLength > maxBytes) { rejected++; return false; }
      if (!state) {
        state = { active: null, pending: null, retiring: false };
        sessions.set(id, state);
      }
      pendingBytes += bytes.byteLength - oldBytes;
      if (state.active) state.pending = bytes;
      else start(id, state, bytes);
      return true;
    },
    /** True while any write or removal still owns this session's file. */
    owns(id: string): boolean { return sessions.has(id); },
    /** Fence removal against an in-flight atomic rename and reject new flushes. */
    async retire(id: string): Promise<void> {
      let state = sessions.get(id);
      if (!state) {
        state = { active: null, pending: null, retiring: true };
        sessions.set(id, state);
      }
      state.retiring = true;
      pendingBytes -= state.pending?.byteLength ?? 0;
      state.pending = null;
      await drainSession(state);
    },
    /** Called only after the owner's removal has completed. */
    release(id: string) {
      const state = sessions.get(id);
      if (state?.retiring && !state.active) sessions.delete(id);
    },
    async drain(): Promise<void> {
      await Promise.all([...sessions.values()].map(drainSession));
    },
    stats() { return { pendingBytes, sessions: sessions.size, rejected }; },
  };
}
