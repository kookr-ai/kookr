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
 *     on Linux, or a `ps` command-line check on macOS (guards against pid
 *     recycling).
 *   - Manifest corruption recovery — on parse failure, the corrupt file is
 *     renamed to `.corrupt-<ts>` and entries are rebuilt from the socket
 *     directory; a `manifest-corrupt` error is emitted.
 *
 * Capability modules (kookr-ai/kookr#1465):
 *   - local-dtach-shared.ts — constants, types, buildDtachSpawn
 *   - local-dtach-process-identity.ts — pid/socket ownership helpers
 *   - local-dtach-stream.ts — attach / ring / write path
 *   - local-dtach-recovery.ts — startup recovery + reconnect
 *
 * See: docs/rfc/rfc-v8-tmux-removal.md
 * See: docs/adr/014-local-dtach-backend.md
 */
import { spawn as spawnChild } from 'node:child_process';
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  unlinkSync,
} from 'node:fs';
import { access as fsAccess } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import type { TerminalSessionDataSource } from '../core/ports/terminal-session-stream-port.js';
import {
  type BackendError,
  type BackendStats,
  type CaptureCurrentFrameOptions,
  type ReconnectTransportOptions,
  type ReconnectTransportResult,
  type SessionId,
  type SessionSpec,
  type TerminalBackend,
  type VerifyRecoveredSessionOptions,
  type VerifyRecoveredSessionResult,
} from './terminal-backend.js';
import type {
  TerminalSessionDiagnostics,
  TerminalSessionDiagnosticsSource,
} from './terminal-session-diagnostics.js';
import {
  type DtachManifestEntry,
  DtachManifestStore,
} from './dtach-manifest-store.js';
import {
  DEFAULT_RING_FLUSH_INTERVAL_MS,
  DtachRingStore,
  RING_BUFFER_BYTES,
  RING_IDLE_CAPACITY_BYTES,
  enforceRingFleetBudget,
  expandRing,
  ringFleetBudgetSnapshot,
  totalRingFleetBytes,
} from './dtach-ring-store.js';
import { killProcessTree } from './process-tree.js';
import { ensureInteractiveTermEnv } from './session-term-env.js';
import {
  findAgentPidSync as findAgentPidSyncImpl,
  findDtachMasterPid,
  findDtachMasterPidSync as findDtachMasterPidSyncImpl,
  verifyMasterIdentity,
} from './local-dtach-process-identity.js';
import { LocalDtachRecovery } from './local-dtach-recovery.js';
import {
  type AttachedSession,
  type LocalDtachBackendOptions,
  DEFAULT_MAX_SESSION_ID_LEN,
  DEFAULT_WRITE_TIMEOUT_MS,
  KILL_WAIT_SECONDS,
  RECONNECT_COOLDOWN_MS,
  RINGS_DIRNAME,
  SUN_PATH_LIMIT,
  buildDtachSpawn,
  sleep,
} from './local-dtach-shared.js';
import { LocalDtachStream } from './local-dtach-stream.js';

export type { LocalDtachBackendOptions } from './local-dtach-shared.js';
export { buildDtachSpawn } from './local-dtach-shared.js';

export class LocalDtachBackend implements TerminalBackend, TerminalSessionDiagnosticsSource {
  private readonly instanceDir: string;
  private readonly manifestStore: DtachManifestStore;
  private readonly ringStore: DtachRingStore;
  private readonly dtachBinary: string;
  private readonly instanceId: string;
  private readonly writeTimeoutMs: number;
  private readonly reconnectCooldownMs: number;
  /** Fleet sum of ring capacities; `0` disables shrink (issue #1779). */
  private readonly ringFleetBudgetBytes: number;

  /**
   * Per-session in-flight reconnect. A duplicate `reconnectTransport` call
   * while one is running collapses onto the same promise (serialization +
   * idempotency, kookr-ai/kookr#1347).
   */
  private readonly reconnectInFlight = new Map<SessionId, Promise<ReconnectTransportResult>>();
  /** Per-session timestamps of recent completed reconnects, for the cap + cooldown. */
  private readonly reconnectHistory = new Map<SessionId, number[]>();

  /** Sessions whose internal transport is currently being repaired. */
  private readonly recoveryInProgress = new Set<SessionId>();

  /** Active attached sessions (persistent internal attaches). */
  private readonly attached = new Map<SessionId, AttachedSession>();

  /** Cumulative re-attach counters reported via `getStats`. */
  private readonly reattachCounts: Record<SessionId, number> = {};

  /** Subscribers to structured backend errors. */
  private readonly errorSubscribers = new Set<(err: BackendError) => void>();

  private lastError: BackendError | null = null;
  private errorCount = 0;
  /** High-water mark of aggregate writeMutex queue depth (issue #1776). */
  private maxPendingWriters = 0;
  /** Cumulative write-timed-out errors (issue #1776). */
  private writeTimeoutCount = 0;
  /** Cumulative ring shrink events under fleet budget pressure (issue #1779). */
  private ringShrinkCount = 0;
  /** Last observed over-budget residual after enforce (issue #1779). */
  private ringFleetOverBudgetBytes = 0;

  /** Periodic ring-buffer snapshot timer; null after `close()`. */
  private flushTimer: NodeJS.Timeout | null = null;

  /** True after `close()` has torn down the backend. Prevents double-close. */
  private closed = false;
  /** Resolves in-flight recovery waits immediately when shutdown starts. */
  private readonly closeWaiters = new Set<() => void>();

  private readonly stream: LocalDtachStream;
  private readonly recovery: LocalDtachRecovery;

  constructor(options: LocalDtachBackendOptions = {}) {
    this.instanceId = options.instanceId ?? 'default';
    this.dtachBinary = options.dtachBinary ?? 'dtach';
    this.writeTimeoutMs = options.writeTimeoutMs ?? DEFAULT_WRITE_TIMEOUT_MS;
    this.reconnectCooldownMs = options.reconnectCooldownMs ?? RECONNECT_COOLDOWN_MS;
    this.ringFleetBudgetBytes = options.ringFleetBudgetBytes ?? 0;

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

    this.stream = new LocalDtachStream({
      attached: this.attached,
      ringStore: this.ringStore,
      manifestStore: this.manifestStore,
      dtachBinary: this.dtachBinary,
      writeTimeoutMs: this.writeTimeoutMs,
      reattachCounts: this.reattachCounts,
      isClosed: () => this.closed,
      emitError: (err) => this.emitError(err),
      observeWriteQueueDepth: () => this.observeWriteQueueDepth(),
      onRingStateChanged: () => this.enforceRingFleetBudget(),
      tryExpandRing: (sess) => this.tryExpandRing(sess),
    });
    this.recovery = new LocalDtachRecovery({
      attached: this.attached,
      manifestStore: this.manifestStore,
      ringStore: this.ringStore,
      reconnectInFlight: this.reconnectInFlight,
      reconnectHistory: this.reconnectHistory,
      recoveryInProgress: this.recoveryInProgress,
      closeWaiters: this.closeWaiters,
      reconnectCooldownMs: this.reconnectCooldownMs,
      instanceDir: this.instanceDir,
      instanceId: this.instanceId,
      dtachBinary: this.dtachBinary,
      isClosed: () => this.closed,
      emitError: (err) => this.emitError(err),
      raceWithClose: (operation) => this.raceWithClose(operation),
      // Dynamic property lookup so characterization tests can monkey-patch
      // these private methods on the façade instance.
      createAttachedState: (id, sock) => this.createAttachedState(id, sock),
      attachPtyInto: (sess, sock, initialSize, suppress, classify) =>
        this.attachPtyInto(sess, sock, initialSize, suppress, classify),
      disposeAttachChildOnly: (sess) => this.disposeAttachChildOnly(sess),
    });

    void this.recovery.recoverOnStartup();

    const flushInterval = options.ringFlushIntervalMs ?? DEFAULT_RING_FLUSH_INTERVAL_MS;
    this.flushTimer = setInterval(() => {
      this.stream.flushAllRings();
      // Re-check budget on the flush cadence so idle rings that aged out of
      // recent activity can be reclaimed even when no new sessions attach.
      this.enforceRingFleetBudget();
    }, flushInterval);
    // Don't keep the event loop alive just for the flush timer.
    this.flushTimer.unref?.();
  }

  /**
   * When fleet capacity exceeds {@link ringFleetBudgetBytes}, shrink
   * least-recently-active rings to {@link RING_IDLE_CAPACITY_BYTES}. Persists
   * each shrink candidate first so full scrollback remains on disk for restart.
   */
  private enforceRingFleetBudget(): void {
    if (!(this.ringFleetBudgetBytes > 0) || this.closed) {
      this.ringFleetOverBudgetBytes = 0;
      return;
    }
    const total = totalRingFleetBytes(this.attached.values());
    if (total <= this.ringFleetBudgetBytes) {
      this.ringFleetOverBudgetBytes = 0;
      return;
    }
    // Snapshot full content for shrink candidates before truncating memory.
    // Only rings still above the idle floor can shrink; flush dirty ones so
    // restart can restore the pre-shrink scrollback from disk.
    for (const sess of this.attached.values()) {
      if (
        sess.ringBuffer.length > RING_IDLE_CAPACITY_BYTES
        && sess.ringHead !== sess.lastFlushedHead
      ) {
        this.ringStore.persist(sess);
      }
    }
    const result = enforceRingFleetBudget(
      this.attached.values(),
      this.ringFleetBudgetBytes,
      RING_IDLE_CAPACITY_BYTES,
    );
    this.ringShrinkCount += result.shrunk;
    this.ringFleetOverBudgetBytes = result.overBudgetBytes;
  }

  /**
   * Expand a shrunken ring back to full capacity when the fleet has room
   * (active sessions regain full scrollback under budget).
   */
  private tryExpandRing(sess: AttachedSession): boolean {
    if (sess.ringBuffer.length >= RING_BUFFER_BYTES) return false;
    const budget = this.ringFleetBudgetBytes;
    if (budget > 0) {
      const total = totalRingFleetBytes(this.attached.values());
      const projected = total - sess.ringBuffer.length + RING_BUFFER_BYTES;
      if (projected > budget) return false;
    }
    return expandRing(sess, RING_BUFFER_BYTES);
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
    this.stream.flushAllRings();
    for (const resolve of this.closeWaiters) resolve();
    this.closeWaiters.clear();
    this.recoveryInProgress.clear();
    for (const id of [...this.attached.keys()]) {
      this.stream.disposeAttach(id);
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

    // Step 2: spawn the dtach master so it outlives this Kookr process.
    const dtachArgs = ['-n', sock, '-r', 'winch', '-E', spec.command, ...spec.args];
    const { command, args } = buildDtachSpawn(process.platform, this.dtachBinary, dtachArgs);
    // `envMode: 'replace'` gives the caller an exact allowlisted child env (the
    // Grok adapter uses it to keep server secrets out of the agent process);
    // the default 'inherit' preserves the historical `{...process.env, ...}`
    // merge for Claude Code / Codex CLI. dtach itself is exec'd with the same
    // env, so a 'replace' caller must include PATH so the multiplexer resolves.
    // Normalize after both env modes and caller overrides are applied. This is
    // the final spawn choke point, so an inherited or explicit TERM=dumb cannot
    // reach a PTY-backed Codex session.
    const env = ensureInteractiveTermEnv(
      spec.envMode === 'replace'
        ? { ...(spec.env ?? {}) }
        : { ...process.env, ...spec.env },
    );
    try {
      this.assertExecutableAvailable(spec.id, this.dtachBinary, env);
      if (command !== this.dtachBinary) this.assertExecutableAvailable(spec.id, command, env);
    } catch (err) {
      await this.removeManifestEntry(spec.id);
      throw err;
    }
    const child = spawnChild(command, args, {
      env,
      cwd: spec.cwd ?? process.cwd(),
      stdio: 'ignore',
      detached: true,
    });

    const spawnError = new Promise<never>((_, reject) => {
      child.once('error', (err: NodeJS.ErrnoException) => {
        reject(this.dtachUnavailableError(spec.id, command, err.code, err));
      });
    });
    child.unref();

    // Step 3: wait for socket.
    try {
      await Promise.race([this.waitForSocket(sock, spec.id), spawnError]);
    } catch (err) {
      await this.removeManifestEntry(spec.id);
      throw err;
    }

    // Step 4: resolve dtach master pid (best-effort; -1 ok).
    const masterPid = await findDtachMasterPid(sock, this.dtachBinary);

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
    this.stream.openAttach(spec.id, sock, spec.size);
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
    this.stream.disposeAttach(id);
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
    const sess = this.stream.ensureWritable(id);
    await this.stream.runUnderMutex(sess, () => this.stream.writeWithTimeout(sess, data));
  }

  async writeSequence(id: SessionId, payloads: Uint8Array[]): Promise<void> {
    if (payloads.length === 0) return;
    const sess = this.stream.ensureWritable(id);
    await this.stream.runUnderMutex(sess, async () => {
      for (const payload of payloads) {
        await this.stream.writeWithTimeout(sess, payload);
      }
    });
  }

  async captureBytes(id: SessionId, maxBytes: number = RING_BUFFER_BYTES): Promise<Uint8Array> {
    return this.stream.captureBytes(id, maxBytes);
  }

  async captureCurrentFrame(
    id: SessionId,
    options: CaptureCurrentFrameOptions = {},
  ): Promise<Uint8Array> {
    return this.stream.captureCurrentFrame(id, options);
  }

  onData(id: SessionId, cb: (data: Uint8Array, source?: TerminalSessionDataSource) => void): () => void {
    const sess = this.stream.ensureReadable(id);
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
    const sess = this.stream.ensureWritable(id);
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

  async reconnectTransport(
    id: SessionId,
    options: ReconnectTransportOptions = {},
  ): Promise<ReconnectTransportResult> {
    return this.recovery.reconnectTransport(id, options);
  }

  async verifyRecoveredSession(
    id: SessionId,
    options: VerifyRecoveredSessionOptions,
  ): Promise<VerifyRecoveredSessionResult> {
    return this.recovery.verifyRecoveredSession(id, options);
  }

  getStats(): BackendStats {
    let pending = 0;
    for (const s of this.attached.values()) pending += s.pendingWriters;
    const ringSnap = ringFleetBudgetSnapshot(this.attached.values(), this.ringFleetBudgetBytes);
    return {
      attachedSessions: this.attached.size,
      reattachCounts: { ...this.reattachCounts },
      pendingWriters: pending,
      maxPendingWriters: this.maxPendingWriters,
      writeTimeoutCount: this.writeTimeoutCount,
      lastError: this.lastError,
      errorCount: this.errorCount,
      ringFleetBytes: ringSnap.totalBytes,
      ringFleetBudgetBytes: ringSnap.budgetBytes,
      ringFleetOverBudgetBytes: this.ringFleetBudgetBytes > 0
        ? Math.max(ringSnap.overBudgetBytes, this.ringFleetOverBudgetBytes)
        : 0,
      ringShrunkenSessions: ringSnap.shrunkenSessions,
      ringShrinkCount: this.ringShrinkCount,
    };
  }

  /**
   * Wall-clock ms since epoch this session's manifest entry was created, or
   * `null` when there is no entry or `startedAt` fails to parse. Used by the
   * orphan/terminal-task session reaper (issue #1720) to age-gate reaping.
   */
  async getSessionStartedAt(id: SessionId): Promise<number | null> {
    const entry = await this.readEntry(id);
    if (!entry) return null;
    const parsed = Date.parse(entry.startedAt);
    return Number.isNaN(parsed) ? null : parsed;
  }

  /**
   * Absolute path to this backend's dtach socket/manifest directory
   * (`/tmp/kookr-dtach/<uid>/<instanceId>`). Used by the stale-attach-client
   * reaper (issue #1720) to scope its process-table scan to sessions THIS
   * instance owns — never another port's sessions or a user's own terminal.
   */
  getInstanceDir(): string {
    return this.instanceDir;
  }

  getSessionDiagnostics(id: SessionId): TerminalSessionDiagnostics | null {
    const entry = this.manifestStore.read().entries.find((candidate) => candidate.sessionId === id);
    const sess = this.attached.get(id);
    if (!entry && !sess) return null;

    const socketPresent = entry ? existsSync(entry.sock) : null;
    const resolvedMasterPid = entry
      ? entry.pid > 0 ? entry.pid : this.findDtachMasterPidSync(entry.sock)
      : -1;
    const masterPid = resolvedMasterPid > 0 ? resolvedMasterPid : null;
    // A recovered manifest can lack a PID when the platform has no /proc
    // process table (notably macOS). The owned socket is useful best-effort
    // identity evidence there; on Linux an unresolved PID remains unknown
    // rather than being turned into either a false live or false lost state.
    const identityVerified = entry === undefined
      ? null
      : masterPid !== null
        ? verifyMasterIdentity(masterPid, entry.sock, this.dtachBinary)
        : socketPresent === false ? false : null;
    return {
      sessionId: id,
      socketPresent,
      identityVerified,
      masterPid,
      // Agent PID lookup scans the full process table and is only needed for
      // explicit reconnect/recovery audit results, not health classification.
      agentPid: null,
      attachChildAlive: sess ? sess.pty !== null : null,
      recoveryInProgress: this.recoveryInProgress.has(id),
      attachGeneration: sess?.attachGeneration ?? 0,
      reattachCount: sess?.reattachCount ?? 0,
      ringHead: sess?.ringHead ?? 0,
      lastByteAt: sess?.lastByteAt ?? null,
      lastAttachAt: sess?.lastAttachAt ?? null,
    };
  }

  // ─── Internal hooks (characterization tests monkey-patch these) ─────────

  /** @internal Exposed via cast for tests; delegates to stream collaborator. */
  private createAttachedState(id: SessionId, sock: string): AttachedSession {
    return this.stream.createAttachedState(id, sock);
  }

  /** @internal Exposed via cast for tests; delegates to stream collaborator. */
  private attachPtyInto(
    sess: AttachedSession,
    sock: string,
    initialSize?: { cols: number; rows: number },
    suppressAttachReplay = false,
    classifyFirstChunkAsReplay = true,
  ): void {
    this.stream.attachPtyInto(sess, sock, initialSize, suppressAttachReplay, classifyFirstChunkAsReplay);
  }

  /** @internal Exposed via cast for tests; delegates to stream collaborator. */
  private disposeAttachChildOnly(sess: AttachedSession): void {
    this.stream.disposeAttachChildOnly(sess);
  }

  /** @internal Exposed via cast for tests; delegates to process-identity module. */
  private findDtachMasterPidSync(sock: string): number {
    return findDtachMasterPidSyncImpl(sock, this.dtachBinary);
  }

  /** @internal Exposed via cast for tests; delegates to process-identity module. */
  private findAgentPidSync(masterPid: number): number | null {
    return findAgentPidSyncImpl(masterPid);
  }

  // ─── Error emission ─────────────────────────────────────────────────────

  private emitError(err: BackendError): void {
    this.lastError = err;
    this.errorCount += 1;
    if (err.kind === 'write-timed-out') this.writeTimeoutCount += 1;
    for (const cb of this.errorSubscribers) {
      try {
        cb(err);
      } catch {
        // subscriber threw — keep serving others
      }
    }
  }

  /** Recompute aggregate writeMutex depth and bump the process high-water mark. */
  private observeWriteQueueDepth(): void {
    let pending = 0;
    for (const s of this.attached.values()) pending += s.pendingWriters;
    if (pending > this.maxPendingWriters) this.maxPendingWriters = pending;
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

  private async readEntry(id: SessionId): Promise<DtachManifestEntry | null> {
    return this.manifestStore.getEntry(id);
  }

  private dtachUnavailableError(
    id: SessionId,
    binary: string,
    detail?: string,
    cause?: Error,
  ): Error {
    const suffix = detail ? ` (${detail})` : '';
    this.emitError({ kind: 'dtach-unavailable', binary });
    const error = new Error(
      `dtach master spawn failed for session ${id}: ${binary} not found or not executable${suffix}`,
    );
    if (cause) error.cause = cause;
    return error;
  }

  private assertExecutableAvailable(id: SessionId, binary: string, env: NodeJS.ProcessEnv): void {
    if (binary.includes('/')) {
      this.assertExecutablePath(id, binary, binary);
      return;
    }

    const pathValue = env.PATH ?? '';
    for (const dir of pathValue.split(delimiter)) {
      const candidate = join(dir || '.', binary);
      try {
        accessSync(candidate, fsConstants.X_OK);
        return;
      } catch {
        // Keep searching PATH.
      }
    }
    throw this.dtachUnavailableError(id, binary, 'ENOENT');
  }

  private assertExecutablePath(id: SessionId, path: string, binary: string): void {
    try {
      accessSync(path, fsConstants.X_OK);
    } catch (err) {
      const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : undefined;
      throw this.dtachUnavailableError(id, binary, code, err instanceof Error ? err : undefined);
    }
  }

  private async raceWithClose<T>(operation: Promise<T>): Promise<T | 'backend-closed'> {
    if (this.closed) return 'backend-closed';
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const onClose = () => resolveClosed();
    this.closeWaiters.add(onClose);
    try {
      return await Promise.race([operation, closed.then(() => 'backend-closed' as const)]);
    } finally {
      this.closeWaiters.delete(onClose);
    }
  }

  private async removeManifestEntry(id: SessionId): Promise<void> {
    await this.manifestStore.update((manifest) => {
      manifest.entries = manifest.entries.filter((e) => e.sessionId !== id);
    });
  }

  private async waitForSocket(sock: string, id: SessionId): Promise<void> {
    const deadline = Date.now() + 3_000;
    while (!existsSync(sock) && Date.now() < deadline) {
      await sleep(25);
    }
    if (!existsSync(sock)) {
      throw new Error(`dtach socket did not appear for session ${id}`);
    }
  }
}
