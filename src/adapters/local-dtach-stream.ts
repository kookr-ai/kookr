/**
 * Attach-stream / ring / write path for LocalDtachBackend.
 *
 * Collaborator owning createAttachedState, openAttach, attachPtyInto,
 * dispose*, ensureReadable/Writable, write mutex, ring flush, and
 * captureCurrentFrame. Split from local-dtach-backend.ts (kookr-ai/kookr#1465).
 */
import { existsSync } from 'node:fs';
import { spawn, type IPty } from 'node-pty';
import type { TerminalSessionDataSource } from '../core/ports/terminal-session-stream-port.js';
import {
  type BackendError,
  type CaptureCurrentFrameOptions,
  type SessionId,
  SessionAttachFailedError,
  SessionGoneError,
  WriteTimeoutError,
} from './terminal-backend.js';
import type { DtachManifestStore } from './dtach-manifest-store.js';
import {
  type DtachRingStore,
  RING_BUFFER_BYTES,
  createDtachRingState,
} from './dtach-ring-store.js';
import {
  type AttachedSession,
  DEFAULT_FRAME_SNAPSHOT_MIN_HOLD_MS,
  DEFAULT_FRAME_SNAPSHOT_QUIET_MS,
  DEFAULT_FRAME_SNAPSHOT_TIMEOUT_MS,
  DEFAULT_RECOVERY_SETTLE_MS,
  REATTACH_CAP,
  REATTACH_WINDOW_MS,
} from './local-dtach-shared.js';

/** Host state the stream collaborator reads/mutates. */
export interface LocalDtachStreamHost {
  readonly attached: Map<SessionId, AttachedSession>;
  readonly ringStore: DtachRingStore;
  readonly manifestStore: DtachManifestStore;
  readonly dtachBinary: string;
  readonly writeTimeoutMs: number;
  readonly reattachCounts: Record<SessionId, number>;
  isClosed(): boolean;
  emitError(err: BackendError): void;
  /**
   * Observe aggregate write-mutex queue depth after a session's
   * `pendingWriters` changes (issue #1776 high-water tracking).
   */
  observeWriteQueueDepth(): void;
  /**
   * Called after a ring is created or otherwise changes fleet capacity so
   * the host can enforce `KOOKR_RING_FLEET_BUDGET_BYTES` (issue #1779).
   */
  onRingStateChanged(): void;
  /**
   * Try to restore a shrunken ring to full capacity when the fleet has room
   * (issue #1779). Returns true when the buffer grew.
   */
  tryExpandRing(sess: AttachedSession): boolean;
}

export class LocalDtachStream {
  constructor(private readonly host: LocalDtachStreamHost) {}

  /**
   * Snapshot the master's current screen via a temporary secondary `dtach -a`.
   * Does not dispose the primary attach, does not write input, and does not
   * count against the reconnect-transport cap — safe for every browser open
   * onto a dense absolute-position TUI (Grok).
   */
  async captureCurrentFrame(
    id: SessionId,
    options: CaptureCurrentFrameOptions = {},
  ): Promise<Uint8Array> {
    if (this.host.isClosed()) return new Uint8Array(0);

    const entry = await this.host.manifestStore.getEntry(id);
    if (!entry) throw new SessionGoneError(id);
    if (!existsSync(entry.sock)) return new Uint8Array(0);

    const remembered = this.host.attached.get(id)?.currentSize;
    const cols = options.cols && options.cols > 0
      ? options.cols
      : (remembered?.cols ?? 80);
    const rows = options.rows && options.rows > 0
      ? options.rows
      : (remembered?.rows ?? 24);
    const timeoutMs = options.timeoutMs && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_FRAME_SNAPSHOT_TIMEOUT_MS;
    const quietMs = options.quietMs && options.quietMs > 0
      ? options.quietMs
      : DEFAULT_FRAME_SNAPSHOT_QUIET_MS;
    const minHoldMs = options.minHoldMs && options.minHoldMs > 0
      ? options.minHoldMs
      : DEFAULT_FRAME_SNAPSHOT_MIN_HOLD_MS;

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let quietTimer: ReturnType<typeof setTimeout> | null = null;
    let minHoldTimer: ReturnType<typeof setTimeout> | null = null;
    let firstByteAt: number | null = null;
    let quietSatisfied = false;
    let minHoldSatisfied = false;
    let settled = false;

    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const tryFinish = (): void => {
      if (settled) return;
      // After first byte: need both quiet + min-hold. Hard timeout / pty exit
      // call finish() directly and skip this gate.
      if (firstByteAt === null) return;
      if (!quietSatisfied || !minHoldSatisfied) return;
      finish();
    };
    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (quietTimer) {
        clearTimeout(quietTimer);
        quietTimer = null;
      }
      if (minHoldTimer) {
        clearTimeout(minHoldTimer);
        minHoldTimer = null;
      }
      resolveDone();
    };

    let pty: IPty;
    try {
      pty = spawn(this.host.dtachBinary, ['-a', entry.sock, '-E'], {
        name: 'xterm-256color',
        cols,
        rows,
        env: process.env as Record<string, string>,
        cwd: process.cwd(),
        encoding: null,
      });
    } catch (err) {
      console.warn(
        `[local-dtach] captureCurrentFrame spawn failed for ${id}:`,
        err,
      );
      return new Uint8Array(0);
    }

    const hardTimer = setTimeout(finish, timeoutMs);

    const onDataDisposable = pty.onData((data) => {
      if (settled) return;
      const buf = typeof data === 'string' ? Buffer.from(data, 'utf-8') : Buffer.from(data);
      if (buf.length === 0) return;
      chunks.push(buf);
      totalBytes += buf.length;
      if (firstByteAt === null) {
        firstByteAt = Date.now();
        minHoldSatisfied = minHoldMs <= 0;
        if (!minHoldSatisfied) {
          minHoldTimer = setTimeout(() => {
            minHoldSatisfied = true;
            tryFinish();
          }, minHoldMs);
        }
      }
      quietSatisfied = false;
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = setTimeout(() => {
        quietSatisfied = true;
        tryFinish();
      }, quietMs);
    });

    const onExitDisposable = pty.onExit(() => {
      finish();
    });

    try {
      await done;
    } finally {
      clearTimeout(hardTimer);
      if (quietTimer) clearTimeout(quietTimer);
      if (minHoldTimer) clearTimeout(minHoldTimer);
      try {
        onDataDisposable.dispose();
      } catch {
        // listener already gone
      }
      try {
        onExitDisposable.dispose();
      } catch {
        // listener already gone
      }
      try {
        pty.kill();
      } catch {
        // already exited
      }
    }

    if (totalBytes === 0) return new Uint8Array(0);
    return new Uint8Array(Buffer.concat(chunks, totalBytes));
  }

  /**
   * Read-only access to the AttachedSession — never re-attaches a dead pty
   * (that would add latency to every `captureBytes`/`onData`). Opens a fresh
   * state entry if none exists yet so subscriptions can land before bytes
   * arrive.
   */
  ensureReadable(id: SessionId): AttachedSession {
    const existing = this.host.attached.get(id);
    if (existing) return existing;

    const entry = this.host.manifestStore.read().entries.find((e) => e.sessionId === id);
    if (!entry || !existsSync(entry.sock)) {
      this.host.emitError({ kind: 'session-gone', id });
      throw new SessionGoneError(id);
    }
    this.openAttach(id, entry.sock, undefined);
    const sess = this.host.attached.get(id);
    if (!sess) throw new SessionAttachFailedError(id, 0);
    return sess;
  }

  /**
   * Get the `AttachedSession` for `id`, lazily re-attaching if the previous
   * attach child exited. Throws `SessionAttachFailedError` if the 3-per-60s
   * cap is exceeded, and `SessionGoneError` if the session does not exist.
   */
  ensureWritable(id: SessionId): AttachedSession {
    let sess = this.host.attached.get(id);
    if (sess?.pty) return sess;

    const entry = this.host.manifestStore.read().entries.find((e) => e.sessionId === id);
    if (!entry || !existsSync(entry.sock)) {
      this.host.emitError({ kind: 'session-gone', id });
      throw new SessionGoneError(id);
    }

    if (sess) {
      // Detached — lazy re-attach, honoring the 3-per-60s cap.
      const now = Date.now();
      sess.reattachWindow = sess.reattachWindow.filter((t) => now - t < REATTACH_WINDOW_MS);
      if (sess.reattachWindow.length >= REATTACH_CAP) {
        this.host.emitError({
          kind: 'session-attach-failed',
          id,
          retries: sess.reattachWindow.length,
        });
        throw new SessionAttachFailedError(id, sess.reattachWindow.length);
      }
      sess.reattachWindow.push(now);
      sess.reattachCount += 1;
      this.host.reattachCounts[id] = sess.reattachCount;
      // This path is immediately followed by a user write. Keep its bytes in
      // the ring; replay suppression is reserved for explicit recovery probes
      // that are measuring post-restart transport liveness.
      this.attachPtyInto(sess, entry.sock, undefined, false, false);
      this.host.emitError({
        kind: 'session-attach-recovered',
        id,
        attempt: sess.reattachCount,
      });
      // eslint-disable-next-line no-console
      console.warn(
        `[dtach-backend] session ${id} attach recovered (attempt ${sess.reattachCount}/${REATTACH_CAP})`,
      );
      return sess;
    }

    // Cold path: first writable access after manifest-recovery startup.
    this.openAttach(id, entry.sock, undefined);
    sess = this.host.attached.get(id);
    if (!sess) throw new SessionAttachFailedError(id, 0);
    return sess;
  }

  /**
   * Spawn a `dtach -a <sock>` attach child and wire it into `this.attached`.
   * Creates a fresh `AttachedSession` if none exists yet.
   */
  openAttach(
    id: SessionId,
    sock: string,
    initialSize: { cols: number; rows: number } | undefined,
  ): void {
    const sess = this.createAttachedState(id, sock);
    // A newly created session has no historical screen to discount. Keep its
    // first response in the ring; replay suppression is only for recovered
    // attach generations that explicitly opt into it.
    this.attachPtyInto(sess, sock, initialSize, false, false);
  }

  /**
   * Get or create the in-memory `AttachedSession` for `id` WITHOUT opening an
   * attach child. Splitting this out of {@link openAttach} lets
   * reconnectTransport rebuild only the internal attach child while
   * preserving the session's ring buffer, `onData` subscribers, and remembered
   * size across the swap.
   */
  createAttachedState(id: SessionId, sock: string): AttachedSession {
    const existing = this.host.attached.get(id);
    if (existing) return existing;
    const sess: AttachedSession = {
      ...createDtachRingState(id),
      sock,
      pty: null,
      dataSubscribers: new Set(),
      writeMutex: Promise.resolve(),
      pendingWriters: 0,
      reattachWindow: [],
      reattachCount: 0,
      // `currentSize` is seeded by `attachPtyInto`.
      currentSize: null,
      lastAttachAt: null,
      attachReplayUntil: 0,
      attachReplayPending: false,
      disposePtyListeners: null,
      attachGeneration: 0,
    };
    // Seed from disk BEFORE wiring up the attach child so the very first
    // `captureBytes` after restart replays the persisted scrollback instead
    // of returning an empty ring. Fail-open if the file is missing or
    // malformed — a fresh ring is strictly better than a crash here.
    this.host.ringStore.load(sess);
    this.host.attached.set(id, sess);
    // New full-size ring may push the fleet over budget — reclaim idle capacity.
    this.host.onRingStateChanged();
    return sess;
  }

  attachPtyInto(
    sess: AttachedSession,
    sock: string,
    initialSize?: { cols: number; rows: number },
    suppressAttachReplay = false,
    classifyFirstChunkAsReplay = true,
  ): void {
    if (this.host.isClosed()) return;
    // Re-attaches after a crash pass `initialSize=undefined`; falling back to
    // the remembered size keeps the TUI viewport stable across the crash
    // instead of snapping back to the 80x24 default.
    const size = initialSize ?? sess.currentSize ?? { cols: 80, rows: 24 };
    sess.currentSize = size;
    sess.attachReplayUntil = suppressAttachReplay ? Date.now() + DEFAULT_RECOVERY_SETTLE_MS : 0;
    // The first non-empty chunk from normal and recovery attaches is the dtach
    // redraw/replay, even if delayed beyond the settle timer. A lazy reattach
    // is immediately followed by a user write, so its first chunk remains live
    // to preserve genuine response bytes in the ring.
    sess.attachReplayPending = classifyFirstChunkAsReplay;
    // `dtach -a <sock> -E` — socket first, no detach escape char.
    const pty = spawn(this.host.dtachBinary, ['-a', sock, '-E'], {
      name: 'xterm-256color',
      cols: size.cols,
      rows: size.rows,
      env: process.env as Record<string, string>,
      cwd: process.cwd(),
      encoding: null,
    });

    const onDataDisposable = pty.onData((data) => {
      // With `encoding: null` node-pty emits Buffers, so the string branch is
      // defensive only. If it ever fires, the string was produced by node-pty's
      // default UTF-8 decode — re-encode with UTF-8 to invert it. (A 'binary'
      // i.e. Latin-1 re-encode here corrupted multi-byte UTF-8: "—" became
      // "â" in the activity stream.)
      const buf = typeof data === 'string' ? Buffer.from(data, 'utf-8') : Buffer.from(data);
      const bytes = new Uint8Array(buf);
      const isAttachReplay = sess.attachReplayPending || Date.now() < sess.attachReplayUntil;
      if (sess.attachReplayPending && bytes.length > 0) sess.attachReplayPending = false;
      const source: TerminalSessionDataSource = isAttachReplay ? 'attach-replay' : 'live';
      // Fan out to subscribers FIRST, then update the ring. `captureBytes` is
      // lock-free; subscribers see the stream before it is buffered for pull
      // consumers, which matches the v7 SessionBridge semantics.
      for (const cb of sess.dataSubscribers) {
        try {
          cb(bytes, source);
        } catch {
          // a listener threw — keep serving others
        }
      }
      if (source === 'live') {
        this.copyIntoRing(sess, bytes);
      }
    });

    const onExitDisposable = pty.onExit(() => {
      // Only clear if this is still the current pty (defend against races
      // between kill + a stale onExit).
      if (sess.pty === pty) {
        sess.pty = null;
      }
    });

    sess.pty = pty;
    sess.lastAttachAt = Date.now();
    sess.disposePtyListeners = () => {
      try {
        onDataDisposable.dispose();
      } catch {
        // fine
      }
      try {
        onExitDisposable.dispose();
      } catch {
        // fine
      }
    };
    sess.attachGeneration += 1;
  }

  /**
   * Dispose ONLY the internal attach child, preserving the `AttachedSession`
   * (ring buffer, `onData` subscribers, remembered size, attach generation).
   * The reconnect-transport path (kookr-ai/kookr#1347) uses this so every
   * SessionBridge consumer stays subscribed across the attach swap and the
   * fresh attach reuses the same ring. The dtach master + agent are untouched:
   * `pty.kill()` closes only Kookr's `dtach -a` read-side child.
   */
  disposeAttachChildOnly(sess: AttachedSession): void {
    if (!sess.pty) return;
    // Detach listeners BEFORE kill so trailing teardown bytes from this attach
    // cannot reach the ring / subscribers (and be miscounted as the next
    // generation's fresh-liveness signal).
    sess.disposePtyListeners?.();
    sess.disposePtyListeners = null;
    try {
      sess.pty.kill();
    } catch {
      // fine
    }
    sess.pty = null;
  }

  /** Dispose any internal attach + clear subscribers for the given session. */
  disposeAttach(id: SessionId): void {
    const sess = this.host.attached.get(id);
    if (!sess) return;
    if (sess.pty) {
      sess.disposePtyListeners?.();
      sess.disposePtyListeners = null;
      try {
        sess.pty.kill();
      } catch {
        // fine
      }
      sess.pty = null;
    }
    sess.dataSubscribers.clear();
    this.host.attached.delete(id);
  }

  /**
   * Acquire the per-session write mutex, run `fn`, release. Chains on a
   * Promise tail so concurrent callers queue. Counts pending writers for
   * `/api/health` and `/metrics` terminalWrite gauges.
   */
  async runUnderMutex<T>(sess: AttachedSession, fn: () => Promise<T>): Promise<T> {
    sess.pendingWriters += 1;
    this.host.observeWriteQueueDepth();
    const prev = sess.writeMutex;
    let release!: () => void;
    sess.writeMutex = new Promise<void>((res) => {
      release = res;
    });
    try {
      await prev;
      return await fn();
    } finally {
      sess.pendingWriters -= 1;
      release();
    }
  }

  /**
   * Write `data` under a bounded timeout. For real node-pty, `write` is
   * fire-and-forget and returns synchronously — the timeout only fires if the
   * write throws asynchronously or the underlying impl returns a thenable.
   * Test doubles that simulate blocked PTYs return a never-resolving Promise;
   * those cases are exactly what the timeout catches.
   */
  async writeWithTimeout(sess: AttachedSession, data: Uint8Array): Promise<void> {
    const ptySnap = sess.pty;
    if (!ptySnap) {
      // We reach here only if the pty was cleared between mutex entry and
      // this point. Surface as attach-failed rather than looping.
      throw new SessionAttachFailedError(sess.id, sess.reattachCount);
    }

    // Pass the bytes to node-pty as a Buffer so they reach the PTY verbatim.
    // The previous `Buffer.from(data).toString('binary')` round trip decoded
    // the bytes as Latin-1 and node-pty re-encoded the string as UTF-8,
    // corrupting every multi-byte UTF-8 character (e.g. the em-dash "—",
    // 0xE2 0x80 0x94, arrived at the agent as the six bytes of "â").
    const payload = Buffer.from(data);
    const start = Date.now();

    const writeTask = new Promise<void>((resolve, reject) => {
      try {
        const result = ptySnap.write(payload) as unknown;
        if (result && typeof (result as { then?: unknown }).then === 'function') {
          (result as Promise<void>).then(() => resolve(), reject);
        } else {
          resolve();
        }
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });

    let timer: NodeJS.Timeout | undefined;
    const timeoutTask = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const duration = Date.now() - start;
        this.host.emitError({ kind: 'write-timed-out', id: sess.id, durationMs: duration });
        reject(new WriteTimeoutError(sess.id, duration));
      }, this.host.writeTimeoutMs);
    });

    try {
      await Promise.race([writeTask, timeoutTask]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Snapshot every active session's ring buffer to disk. Called periodically
   * by `flushTimer` and once during `close()`. Idle sessions whose `ringHead`
   * has not advanced since the last flush are skipped — common case for
   * sessions parked at a prompt waiting for user input.
   *
   * Failures are swallowed (best-effort): a missing snapshot only degrades
   * to "blank terminal on restart", which is the pre-fix behavior — strictly
   * worse to crash the backend over a tmp-disk hiccup.
   */
  flushAllRings(): void {
    for (const sess of this.host.attached.values()) {
      if (sess.ringHead === sess.lastFlushedHead) continue;
      this.host.ringStore.persist(sess);
    }
  }

  copyFromRing(sess: AttachedSession, head: number, size: number, out: Buffer): void {
    this.host.ringStore.copyFrom(sess, head, size, out);
  }

  copyIntoRing(sess: AttachedSession, bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    // Active sessions under budget regain full scrollback capacity.
    if (sess.ringBuffer.length < RING_BUFFER_BYTES) {
      this.host.tryExpandRing(sess);
    }
    sess.lastByteAt = Date.now();
    this.host.ringStore.copyInto(sess, bytes);
  }

  captureBytes(id: SessionId, maxBytes: number = RING_BUFFER_BYTES): Uint8Array {
    // Read-only op: surface the ring buffer even if the attach is transiently
    // detached (re-attach would add latency and hit the cap during genuine
    // recovery windows). If no AttachedSession exists yet, open it so future
    // bytes are captured — but return empty for this call.
    const sess = this.ensureReadable(id);
    const ringCap = sess.ringBuffer.length;
    const cap = Math.min(maxBytes, ringCap);
    // Read the monotonic head ONCE, then copy a bounded window. Head may
    // advance during the copy; the returned snapshot is always a prefix of
    // the buffer state at the moment `head` was frozen — no torn wraparound.
    const head = sess.ringHead;
    const available = Math.min(head, ringCap);
    const size = Math.min(cap, available);
    const out = Buffer.alloc(size);
    this.copyFromRing(sess, head, size, out);
    return new Uint8Array(out);
  }
}
