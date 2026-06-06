/**
 * LocalDtachBackend — the session I/O hub.
 *
 * V8 (rfc-v8-tmux-removal.md) widens this backend's responsibilities:
 *
 *   - Session lifecycle (create, kill, list, isAlive).
 *   - Persistent per-session attach — one internal node-pty handle per
 *     session, opened in `createSession` and reused for every subsequent
 *     `write` / `captureBytes` / `onData`.
 *   - Per-session 1 MB ring buffer backed by a monotonic `head` counter
 *     (lock-free reads; no torn wraparound). Snapshotted to
 *     `<instanceDir>/rings/<sessionId>.{bin,meta.json}` on the configured
 *     flush interval and once during `close()` so the scrollback
 *     survives a Kookr restart that left the dtach masters running.
 *   - Per-session write mutex with a 2 s timeout that releases on
 *     `pty.write` backpressure so `captureBytes` and other consumers are
 *     never starved.
 *   - Lazy re-attach with a 3-per-60-s cap, surfacing
 *     `session-attach-recovered` on recovery and `session-attach-failed`
 *     on cap exhaustion.
 *   - Manifest pid verification via `/proc/<pid>/exe` + `/proc/<pid>/cmdline`
 *     (guards against pid recycling).
 *   - Manifest corruption recovery — on parse failure, the corrupt file is
 *     renamed to `.corrupt-<ts>` and entries are rebuilt from the socket
 *     directory; a `manifest-corrupt` error is emitted.
 *
 * See: docs/rfc/rfc-v8-tmux-removal.md
 * See: docs/adr/014-local-dtach-backend.md
 */
import { spawn as spawnChild } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  unlinkSync,
} from 'node:fs';
import { access as fsAccess } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn, type IPty } from 'node-pty';
import {
  type BackendError,
  type BackendStats,
  type SessionId,
  type SessionSpec,
  type TerminalBackend,
  SessionAttachFailedError,
  SessionGoneError,
  WriteTimeoutError,
} from './terminal-backend.js';
import {
  type DtachManifestEntry,
  type DtachManifestFile,
  DtachManifestStore,
} from './dtach-manifest-store.js';
import {
  DEFAULT_RING_FLUSH_INTERVAL_MS,
  type DtachRingState,
  DtachRingStore,
  RING_BUFFER_BYTES,
  createDtachRingState,
} from './dtach-ring-store.js';
import { killProcessTree } from './process-tree.js';

const PENDING_TTL_MS = 10_000;
/**
 * Caps session-ID length so the resulting socket path stays within the
 * platform's `sun_path` limit (108 bytes on Linux, 104 on macOS — both
 * including the trailing NUL, so 107 / 103 usable). The default base path
 * is `/tmp/kookr-dtach/<uid>/<instanceId>/`, which on a typical install is
 * ~31 chars, leaving ~72 / ~68 characters for the session ID — far above
 * 40 even on macOS.
 */
const DEFAULT_MAX_SESSION_ID_LEN = 40;
/** Bytes available in `sun_path` (excluding NUL) per platform. */
const SUN_PATH_LIMIT = process.platform === 'darwin' ? 103 : 107;
const KILL_WAIT_SECONDS = 10;
const DEFAULT_WRITE_TIMEOUT_MS = 2_000;
const REATTACH_WINDOW_MS = 60_000;
const REATTACH_CAP = 3;
/**
 * How often to persist each session's ring buffer to disk. The periodic flush
 * is the primary mechanism that lets a restarted Kookr rebuild the scrollback
 * for sessions whose dtach master survived the restart (most commonly after
 * `pnpm prod:update` / `pnpm prod:restart`). On startup the master is still
 * running and its hosted TUI is idle, so no new bytes arrive to repopulate the
 * ring — without persistence, browser attach sees a blank viewport.
 */
const RINGS_DIRNAME = 'rings';

/** Per-session in-memory state owned by the backend. */
interface AttachedSession extends DtachRingState {
  sock: string;
  /** Current attach child; null while transiently detached after a crash. */
  pty: IPty | null;
  /** Byte subscribers. */
  dataSubscribers: Set<(data: Uint8Array) => void>;
  /** Writer-mutex tail — chained Promise that sequences write/writeSequence. */
  writeMutex: Promise<void>;
  /** Count of callers currently queued or executing under `writeMutex`. */
  pendingWriters: number;
  /** Timestamps of recent re-attach attempts, used to enforce the 3-per-60s cap. */
  reattachWindow: number[];
  /** Cumulative count of re-attaches since session creation. */
  reattachCount: number;
  /**
   * Last known PTY size. Remembered so the backend can reapply it when the
   * attach child is respawned after a crash, keeping the TUI viewport stable
   * instead of snapping back to the 80x24 node-pty default. `null` until the
   * first create or resize supplies one.
   */
  currentSize: { cols: number; rows: number } | null;
}

export interface LocalDtachBackendOptions {
  /**
   * Where to store per-instance sockets + manifest. Defaults to
   * /tmp/kookr-dtach/<uid>/<instanceId>/.
   */
  socketDir?: string;

  /** Unique id for this Kookr instance. */
  instanceId?: string;

  /** Path to the dtach binary. Defaults to `dtach` on PATH. */
  dtachBinary?: string;

  /** Override write timeout for tests that want to assert the rejection quickly. */
  writeTimeoutMs?: number;

  /**
   * Override the per-session ring-buffer flush interval. Tests use a short
   * value so they don't have to sleep through the production cadence.
   */
  ringFlushIntervalMs?: number;
}

export class LocalDtachBackend implements TerminalBackend {
  private readonly instanceDir: string;
  private readonly manifestStore: DtachManifestStore;
  private readonly ringStore: DtachRingStore;
  private readonly dtachBinary: string;
  private readonly instanceId: string;
  private readonly writeTimeoutMs: number;

  /** Active attached sessions (persistent internal attaches). */
  private readonly attached = new Map<SessionId, AttachedSession>();

  /** Cumulative re-attach counters reported via `getStats`. */
  private readonly reattachCounts: Record<SessionId, number> = {};

  /** Subscribers to structured backend errors. */
  private readonly errorSubscribers = new Set<(err: BackendError) => void>();

  private lastError: BackendError | null = null;
  private errorCount = 0;

  /** Periodic ring-buffer snapshot timer; null after `close()`. */
  private flushTimer: NodeJS.Timeout | null = null;

  /** True after `close()` has torn down the backend. Prevents double-close. */
  private closed = false;

  constructor(options: LocalDtachBackendOptions = {}) {
    this.instanceId = options.instanceId ?? 'default';
    this.dtachBinary = options.dtachBinary ?? 'dtach';
    this.writeTimeoutMs = options.writeTimeoutMs ?? DEFAULT_WRITE_TIMEOUT_MS;

    // On macOS, `os.tmpdir()` returns `/var/folders/<XX>/<hash>/T` (~48 chars).
    // Combined with `kookr-dtach/<uid>/<instanceId>/<sessionId>.sock`, that
    // overflows macOS's 103-byte `sun_path` limit on any standard install.
    // `/tmp` is writable on both Linux and macOS (a symlink to `/private/tmp`
    // there) and keeps every realistic socket path well under the limit.
    const baseDir =
      options.socketDir ?? join('/tmp', 'kookr-dtach', String(process.getuid?.() ?? 'unknown'));
    this.instanceDir = join(baseDir, this.instanceId);
    mkdirSync(this.instanceDir, { recursive: true, mode: 0o700 });
    this.manifestStore = new DtachManifestStore(join(this.instanceDir, 'manifest.json'), this.instanceId);
    this.ringStore = new DtachRingStore(join(this.instanceDir, RINGS_DIRNAME));

    void this.recoverOnStartup();

    const flushInterval = options.ringFlushIntervalMs ?? DEFAULT_RING_FLUSH_INTERVAL_MS;
    this.flushTimer = setInterval(() => {
      this.flushAllRings();
    }, flushInterval);
    // Don't keep the event loop alive just for the flush timer.
    this.flushTimer.unref?.();
  }

  /**
   * Gracefully tear down this backend. Stops the periodic flush timer, runs a
   * final flush so in-flight bytes land on disk, and disposes every internal
   * attach child. The dtach masters themselves are not killed — they were
   * spawned via `setsid` and survive this call so the next Kookr restart can
   * re-attach to them. Idempotent.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    // Final flush first so disposal can't race the last snapshot.
    this.flushAllRings();
    for (const id of [...this.attached.keys()]) {
      this.disposeAttach(id);
    }
  }

  // ─── TerminalBackend surface ────────────────────────────────────────────

  async createSession(spec: SessionSpec): Promise<void> {
    this.validateSessionId(spec.id);
    const sock = this.socketPathFor(spec.id);

    // Step 1: write `pending` manifest entry before spawn so a mid-spawn crash
    // is recoverable.
    const startedAt = new Date().toISOString();
    await this.manifestStore.update((manifest) => {
      manifest.entries = manifest.entries.filter((e) => e.sessionId !== spec.id);
      manifest.entries.push({
        sessionId: spec.id,
        pid: -1,
        startedAt,
        status: 'pending',
        sock,
      });
    });

    // Step 2: spawn dtach master via setsid so it outlives this Kookr process.
    const dtachArgs = ['-n', sock, '-r', 'winch', '-E', spec.command, ...spec.args];
    const child = spawnChild('setsid', ['-f', this.dtachBinary, ...dtachArgs], {
      env: { ...process.env, ...spec.env },
      cwd: spec.cwd ?? process.cwd(),
      stdio: 'ignore',
      detached: true,
    });
    child.unref();

    // Step 3: wait for socket.
    const deadline = Date.now() + 3_000;
    while (!existsSync(sock) && Date.now() < deadline) {
      await sleep(25);
    }
    if (!existsSync(sock)) {
      await this.manifestStore.update((manifest) => {
        manifest.entries = manifest.entries.filter((e) => e.sessionId !== spec.id);
      });
      throw new Error(`dtach socket did not appear for session ${spec.id}`);
    }

    // Step 4: resolve dtach master pid (best-effort; -1 ok).
    const masterPid = await this.findDtachMasterPid(sock);

    // Step 5: flip manifest → active.
    await this.manifestStore.update((manifest) => {
      const entry = manifest.entries.find((e) => e.sessionId === spec.id);
      if (entry) {
        entry.status = 'active';
        entry.pid = masterPid;
      }
    });

    // Step 6: open the persistent internal attach. From this point all I/O
    // flows through `this.attached.get(id)`.
    this.openAttach(spec.id, sock, spec.size);
  }

  async listSessions(): Promise<SessionId[]> {
    const manifest = this.manifestStore.read();
    return manifest.entries
      .filter((e) => e.status === 'active' || e.status === 'recovered')
      .map((e) => e.sessionId);
  }

  async isAlive(id: SessionId): Promise<boolean> {
    const entry = await this.readEntry(id);
    if (!entry || entry.status === 'pending') return false;
    // Use async fs so a stuck filesystem (WSL fuse, NFS) does not block the
    // event loop and so callers can race the probe against a timeout.
    try {
      await fsAccess(entry.sock);
    } catch {
      return false;
    }
    if (entry.pid > 0) {
      try {
        process.kill(entry.pid, 0);
        return true;
      } catch {
        return false;
      }
    }
    return true;
  }

  async killSession(id: SessionId): Promise<void> {
    const entry = await this.readEntry(id);
    // Always dispose any internal attach, even if the manifest has no entry
    // (e.g. in recovery scenarios). Remove persisted ring files inline so a
    // concurrent flush tick can't resurrect them — `disposeAttach` has already
    // removed the session from `this.attached`, so `flushAllRings` won't see
    // it either.
    this.disposeAttach(id);
    this.ringStore.remove(id);

    if (!entry) return;

    // Resolve the dtach master pid. Recovered/rebuilt entries can carry pid -1
    // (the cmdline scan failed at create/recovery time); fall back to a live
    // scan keyed on the socket path so we still have a tree root to reap.
    let masterPid = entry.pid;
    if (masterPid <= 0) {
      masterPid = this.findDtachMasterPidSync(entry.sock);
    }

    // Reap the master AND its descendant tree. dtach forks the agent
    // (`claude`/`codex`) into its own session, so the agent is NOT in the
    // master's process group — signalling the master alone leaks the agent,
    // which ignores the pty's SIGHUP and survives reparented to init
    // (kookr-ai/kookr#784). killProcessTree snapshots the descendants from
    // /proc first, then SIGTERM → grace → SIGKILL.
    if (masterPid > 0) {
      await killProcessTree(masterPid, { graceMs: KILL_WAIT_SECONDS * 1000 });
    }

    if (existsSync(entry.sock)) {
      try {
        unlinkSync(entry.sock);
      } catch {
        // fine
      }
    }
    await this.manifestStore.update((manifest) => {
      manifest.entries = manifest.entries.filter((e) => e.sessionId !== id);
    });
  }

  async write(id: SessionId, data: Uint8Array): Promise<void> {
    const sess = this.ensureWritable(id);
    await this.runUnderMutex(sess, () => this.writeWithTimeout(sess, data));
  }

  async writeSequence(id: SessionId, payloads: Uint8Array[]): Promise<void> {
    if (payloads.length === 0) return;
    const sess = this.ensureWritable(id);
    await this.runUnderMutex(sess, async () => {
      for (const payload of payloads) {
        await this.writeWithTimeout(sess, payload);
      }
    });
  }

  async captureBytes(id: SessionId, maxBytes: number = RING_BUFFER_BYTES): Promise<Uint8Array> {
    // Read-only op: surface the ring buffer even if the attach is transiently
    // detached (re-attach would add latency and hit the cap during genuine
    // recovery windows). If no AttachedSession exists yet, open it so future
    // bytes are captured — but return empty for this call.
    const sess = this.ensureReadable(id);
    const cap = Math.min(maxBytes, RING_BUFFER_BYTES);
    // Read the monotonic head ONCE, then copy a bounded window. Head may
    // advance during the copy; the returned snapshot is always a prefix of
    // the buffer state at the moment `head` was frozen — no torn wraparound.
    const head = sess.ringHead;
    const available = Math.min(head, RING_BUFFER_BYTES);
    const size = Math.min(cap, available);
    const out = Buffer.alloc(size);
    this.copyFromRing(sess, head, size, out);
    return new Uint8Array(out);
  }

  onData(id: SessionId, cb: (data: Uint8Array) => void): () => void {
    const sess = this.ensureReadable(id);
    sess.dataSubscribers.add(cb);
    return () => {
      sess.dataSubscribers.delete(cb);
    };
  }

  onBackendError(cb: (err: BackendError) => void): () => void {
    this.errorSubscribers.add(cb);
    return () => {
      this.errorSubscribers.delete(cb);
    };
  }

  async resize(id: SessionId, cols: number, rows: number): Promise<void> {
    const sess = this.ensureWritable(id);
    // Remember the size even if the attach is currently detached — the size
    // will be reapplied to the next pty by `attachPtyInto` so re-attaches
    // keep the viewport stable.
    sess.currentSize = { cols, rows };
    if (!sess.pty) return;
    try {
      sess.pty.resize(cols, rows);
    } catch {
      // attach raced with exit; ignore.
    }
  }

  getStats(): BackendStats {
    let pending = 0;
    for (const s of this.attached.values()) pending += s.pendingWriters;
    return {
      attachedSessions: this.attached.size,
      reattachCounts: { ...this.reattachCounts },
      pendingWriters: pending,
      lastError: this.lastError,
      errorCount: this.errorCount,
    };
  }

  // ─── Persistent-attach internals ────────────────────────────────────────

  /**
   * Read-only access to the AttachedSession — never re-attaches a dead pty
   * (that would add latency to every `captureBytes`/`onData`). Opens a fresh
   * state entry if none exists yet so subscriptions can land before bytes
   * arrive.
   */
  private ensureReadable(id: SessionId): AttachedSession {
    const existing = this.attached.get(id);
    if (existing) return existing;

    const entry = this.manifestStore.read().entries.find((e) => e.sessionId === id);
    if (!entry || !existsSync(entry.sock)) {
      this.emitError({ kind: 'session-gone', id });
      throw new SessionGoneError(id);
    }
    this.openAttach(id, entry.sock, undefined);
    const sess = this.attached.get(id);
    if (!sess) throw new SessionAttachFailedError(id, 0);
    return sess;
  }

  /**
   * Get the `AttachedSession` for `id`, lazily re-attaching if the previous
   * attach child exited. Throws `SessionAttachFailedError` if the 3-per-60s
   * cap is exceeded, and `SessionGoneError` if the session does not exist.
   */
  private ensureWritable(id: SessionId): AttachedSession {
    let sess = this.attached.get(id);
    if (sess?.pty) return sess;

    const entry = this.manifestStore.read().entries.find((e) => e.sessionId === id);
    if (!entry || !existsSync(entry.sock)) {
      this.emitError({ kind: 'session-gone', id });
      throw new SessionGoneError(id);
    }

    if (sess) {
      // Detached — lazy re-attach, honoring the 3-per-60s cap.
      const now = Date.now();
      sess.reattachWindow = sess.reattachWindow.filter((t) => now - t < REATTACH_WINDOW_MS);
      if (sess.reattachWindow.length >= REATTACH_CAP) {
        this.emitError({
          kind: 'session-attach-failed',
          id,
          retries: sess.reattachWindow.length,
        });
        throw new SessionAttachFailedError(id, sess.reattachWindow.length);
      }
      sess.reattachWindow.push(now);
      sess.reattachCount += 1;
      this.reattachCounts[id] = sess.reattachCount;
      this.attachPtyInto(sess, entry.sock);
      this.emitError({
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
    sess = this.attached.get(id);
    if (!sess) throw new SessionAttachFailedError(id, 0);
    return sess;
  }

  /**
   * Spawn a `dtach -a <sock>` attach child and wire it into `this.attached`.
   * Creates a fresh `AttachedSession` if none exists yet.
   */
  private openAttach(
    id: SessionId,
    sock: string,
    initialSize: { cols: number; rows: number } | undefined,
  ): void {
    let sess = this.attached.get(id);
    if (!sess) {
      sess = {
        ...createDtachRingState(id),
        sock,
        pty: null,
        dataSubscribers: new Set(),
        writeMutex: Promise.resolve(),
        pendingWriters: 0,
        reattachWindow: [],
        reattachCount: 0,
        // `currentSize` is seeded by `attachPtyInto` below.
        currentSize: null,
      };
      // Seed from disk BEFORE wiring up the attach child so the very first
      // `captureBytes` after restart replays the persisted scrollback instead
      // of returning an empty ring. Fail-open if the file is missing or
      // malformed — a fresh ring is strictly better than a crash here.
      this.ringStore.load(sess);
      this.attached.set(id, sess);
    }
    this.attachPtyInto(sess, sock, initialSize);
  }

  private attachPtyInto(
    sess: AttachedSession,
    sock: string,
    initialSize?: { cols: number; rows: number },
  ): void {
    // Re-attaches after a crash pass `initialSize=undefined`; falling back to
    // the remembered size keeps the TUI viewport stable across the crash
    // instead of snapping back to the 80x24 default.
    const size = initialSize ?? sess.currentSize ?? { cols: 80, rows: 24 };
    sess.currentSize = size;
    // `dtach -a <sock> -E` — socket first, no detach escape char.
    const pty = spawn(this.dtachBinary, ['-a', sock, '-E'], {
      name: 'xterm-256color',
      cols: size.cols,
      rows: size.rows,
      env: process.env as Record<string, string>,
      cwd: process.cwd(),
      encoding: null,
    });

    pty.onData((data) => {
      const buf = typeof data === 'string' ? Buffer.from(data, 'binary') : Buffer.from(data);
      const bytes = new Uint8Array(buf);
      // Fan out to subscribers FIRST, then update the ring. `captureBytes` is
      // lock-free; subscribers see the stream before it is buffered for pull
      // consumers, which matches the v7 SessionBridge semantics.
      for (const cb of sess.dataSubscribers) {
        try {
          cb(bytes);
        } catch {
          // a listener threw — keep serving others
        }
      }
      this.copyIntoRing(sess, bytes);
    });

    pty.onExit(() => {
      // Only clear if this is still the current pty (defend against races
      // between kill + a stale onExit).
      if (sess.pty === pty) {
        sess.pty = null;
      }
    });

    sess.pty = pty;
  }

  /** Dispose any internal attach + clear subscribers for the given session. */
  private disposeAttach(id: SessionId): void {
    const sess = this.attached.get(id);
    if (!sess) return;
    if (sess.pty) {
      try {
        sess.pty.kill();
      } catch {
        // fine
      }
      sess.pty = null;
    }
    sess.dataSubscribers.clear();
    this.attached.delete(id);
  }

  // ─── Write mutex ────────────────────────────────────────────────────────

  /**
   * Acquire the per-session write mutex, run `fn`, release. Chains on a
   * Promise tail so concurrent callers queue. Counts pending writers for
   * `/api/health`.
   */
  private async runUnderMutex<T>(sess: AttachedSession, fn: () => Promise<T>): Promise<T> {
    sess.pendingWriters += 1;
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
  private async writeWithTimeout(sess: AttachedSession, data: Uint8Array): Promise<void> {
    const ptySnap = sess.pty;
    if (!ptySnap) {
      // We reach here only if the pty was cleared between mutex entry and
      // this point. Surface as attach-failed rather than looping.
      throw new SessionAttachFailedError(sess.id, sess.reattachCount);
    }

    const payload = Buffer.from(data).toString('binary');
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
        this.emitError({ kind: 'write-timed-out', id: sess.id, durationMs: duration });
        reject(new WriteTimeoutError(sess.id, duration));
      }, this.writeTimeoutMs);
    });

    try {
      await Promise.race([writeTask, timeoutTask]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // ─── Ring-buffer persistence ────────────────────────────────────────────

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
  private flushAllRings(): void {
    for (const sess of this.attached.values()) {
      if (sess.ringHead === sess.lastFlushedHead) continue;
      this.ringStore.persist(sess);
    }
  }

  private copyFromRing(sess: AttachedSession, head: number, size: number, out: Buffer): void {
    this.ringStore.copyFrom(sess, head, size, out);
  }

  private copyIntoRing(sess: AttachedSession, bytes: Uint8Array): void {
    this.ringStore.copyInto(sess, bytes);
  }

  // ─── Manifest persistence + recovery ────────────────────────────────────

  /**
   * Startup recovery. Handles two cases:
   *   1. Manifest parses: clean expired `pending` entries. Validate each
   *      `active` entry's pid via `/proc/<pid>/exe` + cmdline; entries that
   *      fail validation flip to `recovered` state.
   *   2. Manifest fails to parse: rename to `.corrupt-<ts>`, rebuild from
   *      socket dir scan, emit `manifest-corrupt`.
   */
  private async recoverOnStartup(): Promise<void> {
    await this.manifestStore.withLock(() => {
      const recovery = this.manifestStore.readForRecovery();
      if (recovery.kind === 'missing') return;

      let manifest: DtachManifestFile;
      if (recovery.kind === 'invalid') {
        this.manifestStore.renameCorrupt();
        manifest = this.rebuildManifestFromSocketDir();
        this.manifestStore.writeAtomic(manifest);
        this.emitError({ kind: 'manifest-corrupt', recoveredCount: manifest.entries.length });
        return;
      }
      manifest = recovery.manifest;

      const now = Date.now();
      const before = manifest.entries.length;

      manifest.entries = manifest.entries.flatMap((e) => {
        if (e.status === 'pending') {
          const age = now - new Date(e.startedAt).getTime();
          if (age < PENDING_TTL_MS) return [e];
          // Pending entry that never flipped to active and aged out — drop
          // any ring snapshot that may have been left behind (otherwise a
          // future session reusing this id would inherit stale scrollback
          // from a different agent process).
          this.ringStore.remove(e.sessionId);
          return [];
        }
        // Active or recovered: verify pid ownership. Unverifiable entries
        // go to 'recovered' (visible but flagged) rather than silent deletion.
        const ok = this.verifyEntryOwnership(e);
        if (ok) return [{ ...e, status: 'active' as const }];
        if (!existsSync(e.sock)) {
          // Manifest entry whose dtach master and socket are both gone — the
          // session is dead. Clean up its ring snapshot for the same reason
          // as the pending-aged-out branch above.
          this.ringStore.remove(e.sessionId);
          return [];
        }
        return [{ ...e, status: 'recovered' as const }];
      });

      if (manifest.entries.length !== before) {
        this.manifestStore.writeAtomic(manifest);
      }
    });
  }

  /**
   * Reconstruct manifest entries by scanning the instance's socket directory.
   * Each `.sock` file becomes a `recovered` entry (pid resolved if possible).
   * Used when the manifest fails to parse.
   */
  private rebuildManifestFromSocketDir(): DtachManifestFile {
    const entries: DtachManifestEntry[] = [];
    let socks: string[] = [];
    try {
      socks = readdirSync(this.instanceDir).filter((n) => n.endsWith('.sock'));
    } catch {
      socks = [];
    }
    for (const sockName of socks) {
      const sessionId = sockName.replace(/\.sock$/, '');
      const sock = join(this.instanceDir, sockName);
      let pid = -1;
      try {
        pid = this.findDtachMasterPidSync(sock);
      } catch {
        pid = -1;
      }
      entries.push({
        sessionId,
        pid,
        startedAt: new Date().toISOString(),
        status: 'recovered',
        sock,
      });
    }
    return { version: 1, instanceId: this.instanceId, entries };
  }

  /**
   * Verify a manifest entry's pid is actually our dtach master, not a
   * recycled pid that happens to be alive. Checks `/proc/<pid>/exe` resolves
   * to the dtach binary AND `/proc/<pid>/cmdline` contains the socket path.
   */
  private verifyEntryOwnership(entry: DtachManifestEntry): boolean {
    if (entry.pid <= 0) {
      // pid never resolved; fall back to socket-file presence only.
      return existsSync(entry.sock);
    }
    try {
      process.kill(entry.pid, 0);
    } catch {
      return false;
    }
    const procDir = `/proc/${entry.pid}`;
    try {
      const exe = readlinkSync(`${procDir}/exe`);
      const exeBase = exe.split('/').pop() ?? '';
      if (!exeBase.includes('dtach')) return false;
    } catch {
      // /proc unreadable — treat as unverified, caller will demote to 'recovered'.
      return false;
    }
    try {
      const cmdline = readFileSync(`${procDir}/cmdline`, 'utf-8').replace(/\0/g, ' ');
      if (!cmdline.includes(entry.sock)) return false;
    } catch {
      return false;
    }
    return existsSync(entry.sock);
  }

  // ─── Error emission ─────────────────────────────────────────────────────

  private emitError(err: BackendError): void {
    this.lastError = err;
    this.errorCount += 1;
    for (const cb of this.errorSubscribers) {
      try {
        cb(err);
      } catch {
        // subscriber threw — keep serving others
      }
    }
  }

  // ─── Helpers ────────────────────────────────────────────────────────────

  private socketPathFor(id: SessionId): string {
    return join(this.instanceDir, `${id}.sock`);
  }

  private validateSessionId(id: SessionId): void {
    if (!id || id.length === 0) throw new Error('session id cannot be empty');
    if (id.length > DEFAULT_MAX_SESSION_ID_LEN) {
      throw new Error(
        `session id too long (${id.length} > ${DEFAULT_MAX_SESSION_ID_LEN}); would risk overflowing the platform sun_path limit (${SUN_PATH_LIMIT} bytes on ${process.platform})`,
      );
    }
    const projected = this.socketPathFor(id).length;
    if (projected > SUN_PATH_LIMIT) {
      throw new Error(
        `socket path would be ${projected} bytes, exceeding the ${SUN_PATH_LIMIT}-byte sun_path limit on ${process.platform}; pass a shorter socketDir option or use a shorter instanceId`,
      );
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
      throw new Error(`session id must match [a-zA-Z0-9_-]+ (got ${id})`);
    }
  }

  private async findDtachMasterPid(sock: string): Promise<number> {
    try {
      return this.findDtachMasterPidSync(sock);
    } catch {
      return -1;
    }
  }

  /**
   * Resolve the dtach master pid for `sock` via a pure-Node `/proc` scan.
   *
   * The previous implementation shelled out to a per-pid bash loop over
   * `/proc/<pid>/cmdline` that piped `tr` into `grep`, spawning two
   * processes per pid. On a loaded host (hundreds of processes) that loop blew
   * past its 2 s timeout and returned -1, so the manifest pid was never
   * resolved — which made `killSession` a no-op and left the dtach master AND
   * its agent child resident. That unresolved-pid path was a primary driver of
   * the leak in kookr-ai/kookr#784. Reading the cmdline files directly is
   * allocation-light and spawns nothing, so it stays correct under load.
   *
   * Both the master (`dtach -n <sock> …`) and the read-side attach
   * (`dtach -a <sock> …`) carry the socket in their cmdline, so the master is
   * disambiguated by its `-n` flag; a sock-only match is used as a fallback.
   */
  private findDtachMasterPidSync(sock: string): number {
    let names: string[];
    try {
      names = readdirSync('/proc');
    } catch {
      return -1; // no /proc (non-Linux) — caller falls back to -1.
    }
    let fallback = -1;
    for (const name of names) {
      if (!/^\d+$/.test(name)) continue;
      let cmdline: string;
      try {
        cmdline = readFileSync(`/proc/${name}/cmdline`, 'utf-8');
      } catch {
        continue; // process exited between readdir and read, or unreadable
      }
      if (!cmdline.includes(sock)) continue;
      const tokens = cmdline.split('\0');
      if (tokens.includes('-n')) return Number(name);
      if (fallback < 0) fallback = Number(name);
    }
    return fallback;
  }

  private async readEntry(id: SessionId): Promise<DtachManifestEntry | null> {
    return this.manifestStore.getEntry(id);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
