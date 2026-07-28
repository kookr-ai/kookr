/**
 * Recovery / reconnect path for LocalDtachBackend.
 *
 * Covers startup manifest recovery, reconnectTransport, and
 * verifyRecoveredSession. Split from local-dtach-backend.ts (kookr-ai/kookr#1465).
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { TerminalSessionDataSource } from '../core/ports/terminal-session-stream-port.js';
import {
  type BackendError,
  type ReconnectTransportOptions,
  type ReconnectTransportReason,
  type ReconnectTransportResult,
  type RecoveredSessionClassification,
  type RecoveredSessionFailureReason,
  type SessionId,
  type VerifyRecoveredSessionOptions,
  type VerifyRecoveredSessionResult,
} from './terminal-backend.js';
import {
  type DtachManifestEntry,
  type DtachManifestFile,
  type DtachManifestStore,
} from './dtach-manifest-store.js';
import type { DtachRingStore } from './dtach-ring-store.js';
import {
  findAgentPidSync,
  findDtachMasterPidSync,
  verifyEntryOwnership,
  verifyMasterIdentity,
} from './local-dtach-process-identity.js';
import {
  type AttachedSession,
  type ReconnectBase,
  DEFAULT_RECONNECT_LIVENESS_TIMEOUT_MS,
  DEFAULT_RECOVERY_GRACE_WINDOW_MS,
  DEFAULT_RECOVERY_MAX_REPAIRS,
  DEFAULT_RECOVERY_SETTLE_MS,
  PENDING_TTL_MS,
  RECONNECT_CAP,
  RECONNECT_WINDOW_MS,
  sleep,
} from './local-dtach-shared.js';
/** Host state the recovery collaborator reads/mutates. */
export interface LocalDtachRecoveryHost {
  readonly attached: Map<SessionId, AttachedSession>;
  readonly manifestStore: DtachManifestStore;
  readonly ringStore: DtachRingStore;
  readonly reconnectInFlight: Map<SessionId, Promise<ReconnectTransportResult>>;
  readonly reconnectHistory: Map<SessionId, number[]>;
  readonly recoveryInProgress: Set<SessionId>;
  readonly closeWaiters: Set<() => void>;
  readonly reconnectCooldownMs: number;
  readonly instanceDir: string;
  readonly instanceId: string;
  readonly dtachBinary: string;
  isClosed(): boolean;
  emitError(err: BackendError): void;
  raceWithClose<T>(operation: Promise<T>): Promise<T | 'backend-closed'>;
  /**
   * Stream ops go through the host so characterization tests can monkey-patch
   * the façade private methods (`attachPtyInto`, `disposeAttachChildOnly`, …).
   */
  createAttachedState(id: SessionId, sock: string): AttachedSession;
  attachPtyInto(
    sess: AttachedSession,
    sock: string,
    initialSize?: { cols: number; rows: number },
    suppressAttachReplay?: boolean,
    classifyFirstChunkAsReplay?: boolean,
  ): void;
  disposeAttachChildOnly(sess: AttachedSession): void;
}

export class LocalDtachRecovery {
  constructor(private readonly host: LocalDtachRecoveryHost) {}

  async reconnectTransport(
    id: SessionId,
    options: ReconnectTransportOptions = {},
  ): Promise<ReconnectTransportResult> {
    // Serialize per session AND collapse duplicates onto the in-flight attempt
    // (idempotency under duplicate clicks/requests, kookr-ai/kookr#1347).
    const inFlight = this.host.reconnectInFlight.get(id);
    if (inFlight) return inFlight;
    this.host.recoveryInProgress.add(id);
    const run = this.performReconnect(id, options);
    this.host.reconnectInFlight.set(id, run);
    try {
      return await run;
    } finally {
      this.host.reconnectInFlight.delete(id);
      this.host.recoveryInProgress.delete(id);
    }
  }

  async performReconnect(
    id: SessionId,
    options: ReconnectTransportOptions,
  ): Promise<ReconnectTransportResult> {
    const now = Date.now();
    const currentGeneration = this.host.attached.get(id)?.attachGeneration ?? 0;
    const base: ReconnectBase = {
      identityVerified: false,
      masterPid: -1,
      agentPid: null,
      previousGeneration: currentGeneration,
      newGeneration: currentGeneration,
      livenessWaitedMs: 0,
    };

    // 1. Session must be known and its socket present.
    const entry = await this.host.manifestStore.getEntry(id);
    if (this.host.isClosed()) return this.reconnectFailure(id, 'backend-closed', base, options);
    if (!entry) return this.reconnectFailure(id, 'session-unknown', base, options);
    if (!existsSync(entry.sock)) return this.reconnectFailure(id, 'socket-missing', base, options);

    // 2. Verify the dtach master pid + socket still belong to this session.
    let masterPid = entry.pid;
    if (masterPid <= 0) masterPid = findDtachMasterPidSync(entry.sock, this.host.dtachBinary);
    base.masterPid = masterPid;
    if (!verifyMasterIdentity(masterPid, entry.sock, this.host.dtachBinary)) {
      return this.reconnectFailure(id, 'identity-unverified', base, options);
    }
    base.identityVerified = true;
    base.agentPid = findAgentPidSync(masterPid);

    // 3. Cooldown + rolling retry cap (per session).
    const history = (this.host.reconnectHistory.get(id) ?? []).filter((t) => now - t < RECONNECT_WINDOW_MS);
    const lastAttempt = history.length > 0 ? history[history.length - 1] : Number.NEGATIVE_INFINITY;
    if (now - lastAttempt < this.host.reconnectCooldownMs) {
      this.host.reconnectHistory.set(id, history);
      return this.reconnectFailure(id, 'cooldown', base, options);
    }
    if (history.length >= RECONNECT_CAP) {
      this.host.reconnectHistory.set(id, history);
      return this.reconnectFailure(id, 'retry-cap', base, options);
    }

    // 4. Get/create the session state WITHOUT touching the ring or subscribers,
    //    then dispose ONLY the internal attach child.
    const sess = this.host.createAttachedState(id, entry.sock);
    base.previousGeneration = sess.attachGeneration;
    this.host.disposeAttachChildOnly(sess);
    if (this.host.isClosed()) return this.reconnectFailure(id, 'backend-closed', base, options);

    // 5. Install the fresh-liveness probe BEFORE spawning so the first byte the
    //    new attach emits (the dtach redraw) is observed. The probe only reads;
    //    it NEVER writes input.
    let resolveLive: (() => void) | null = null;
    const liveSignal = new Promise<void>((resolve) => {
      resolveLive = resolve;
    });
    const probe = (bytes: Uint8Array, source?: TerminalSessionDataSource): void => {
      if (bytes.length > 0 && source !== 'attach-replay') resolveLive?.();
    };
    sess.dataSubscribers.add(probe);

    // 6. Open a fresh attach generation (reapplies sess.currentSize, keeps the
    //    same dataSubscribers + ring). No agent relaunch, no input written.
    try {
      this.host.attachPtyInto(sess, entry.sock, undefined, true);
    } catch (err) {
      sess.dataSubscribers.delete(probe);
      base.newGeneration = sess.attachGeneration;
      return this.reconnectFailure(id, 'attach-spawn-failed', base, options, err);
    }
    base.newGeneration = sess.attachGeneration;

    // 7. Bounded wait for the fresh-liveness signal. Guard against a 0/negative
    //    window from a direct programmatic caller (the HTTP route already
    //    rejects those) so `livenessTimeoutMs: 0` falls back to the default
    //    instead of returning `inconclusive` after `sleep(0)`.
    const timeoutMs =
      options.livenessTimeoutMs && options.livenessTimeoutMs > 0
        ? options.livenessTimeoutMs
        : DEFAULT_RECONNECT_LIVENESS_TIMEOUT_MS;
    const start = Date.now();
    const liveResult = await this.host.raceWithClose(Promise.race([
      liveSignal.then(() => true),
      sleep(timeoutMs).then(() => false),
    ]));
    sess.dataSubscribers.delete(probe);
    base.livenessWaitedMs = Date.now() - start;

    if (liveResult === 'backend-closed') {
      return this.reconnectFailure(id, 'backend-closed', base, options);
    }
    const live = liveResult;

    // Re-resolve the agent pid post-attach so the audit proves it is unchanged.
    base.agentPid = findAgentPidSync(masterPid);

    if (!sess.pty) {
      // The fresh attach came up but exited immediately — treat as a spawn
      // failure. Like a hard spawn throw (the `catch` above), this does NOT
      // count toward the cooldown/cap: a transport that never stayed up should
      // not rate-limit the operator's next genuine attempt.
      return this.reconnectFailure(id, 'attach-spawn-failed', base, options);
    }

    // Record the attempt for the cooldown/cap ONLY now that a working transport
    // is confirmed up — so neither `attach-spawn-failed` path rate-limits the
    // next click, keeping the two spawn-failure paths consistent.
    history.push(Date.now());
    this.host.reconnectHistory.set(id, history);

    const result: ReconnectTransportResult = {
      outcome: live ? 'success' : 'inconclusive',
      reason: live ? 'reconnected' : 'liveness-timeout',
      identityVerified: true,
      masterPid,
      agentPid: base.agentPid,
      previousGeneration: base.previousGeneration,
      newGeneration: sess.attachGeneration,
      livenessWaitedMs: base.livenessWaitedMs,
    };
    this.auditReconnect(id, result, options);
    return result;
  }

  reconnectFailure(
    id: SessionId,
    reason: ReconnectTransportReason,
    base: ReconnectBase,
    options: ReconnectTransportOptions,
    cause?: unknown,
  ): ReconnectTransportResult {
    const result: ReconnectTransportResult = {
      outcome: 'failure',
      reason,
      identityVerified: base.identityVerified,
      masterPid: base.masterPid,
      agentPid: base.agentPid,
      previousGeneration: base.previousGeneration,
      newGeneration: base.newGeneration,
      livenessWaitedMs: base.livenessWaitedMs,
    };
    this.auditReconnect(id, result, options, cause);
    return result;
  }

  auditReconnect(
    id: SessionId,
    result: ReconnectTransportResult,
    options: ReconnectTransportOptions,
    cause?: unknown,
  ): void {
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        msg: 'terminal_transport_reconnect',
        sessionId: id,
        outcome: result.outcome,
        reason: result.reason,
        actor: options.actor ?? 'owner',
        operatorReason: options.reason,
        identityVerified: result.identityVerified,
        masterPid: result.masterPid,
        agentPid: result.agentPid,
        previousGeneration: result.previousGeneration,
        newGeneration: result.newGeneration,
        livenessWaitedMs: result.livenessWaitedMs,
        ...(cause ? { error: cause instanceof Error ? cause.message : String(cause) } : {}),
      }),
    );
  }

  async verifyRecoveredSession(
    id: SessionId,
    options: VerifyRecoveredSessionOptions,
  ): Promise<VerifyRecoveredSessionResult> {
    this.host.recoveryInProgress.add(id);
    try {
      return await this.verifyRecoveredSessionImpl(id, options);
    } finally {
      // A thrown read/probe error must not leave health stuck at
      // `recovery-in-progress` forever.
      this.host.recoveryInProgress.delete(id);
    }
  }

  async verifyRecoveredSessionImpl(
    id: SessionId,
    options: VerifyRecoveredSessionOptions,
  ): Promise<VerifyRecoveredSessionResult> {
    const restartEpoch = options.restartEpoch ?? Date.now();
    const grace =
      options.graceWindowMs && options.graceWindowMs > 0
        ? options.graceWindowMs
        : DEFAULT_RECOVERY_GRACE_WINDOW_MS;
    const settle =
      options.settleWindowMs != null && options.settleWindowMs >= 0
        ? options.settleWindowMs
        : DEFAULT_RECOVERY_SETTLE_MS;
    // A negative cap is coerced to the default; 0 is honored (classify-only).
    const cap =
      options.maxRepairAttempts != null && options.maxRepairAttempts >= 0
        ? options.maxRepairAttempts
        : DEFAULT_RECOVERY_MAX_REPAIRS;
    const start = Date.now();
    const acc = {
      identityVerified: false,
      masterPid: -1,
      agentPid: null as number | null,
      spawnError: undefined as string | undefined,
    };
    const finish = (
      classification: RecoveredSessionClassification,
      repairAttempts: number,
      livenessObserved: boolean,
      failureReason?: RecoveredSessionFailureReason,
    ): VerifyRecoveredSessionResult => {
      this.host.recoveryInProgress.delete(id);
      const result: VerifyRecoveredSessionResult = {
        sessionId: id,
        classification,
        restartEpoch,
        repairAttempts,
        identityVerified: acc.identityVerified,
        masterPid: acc.masterPid,
        agentPid: acc.agentPid,
        livenessObserved,
        elapsedMs: Date.now() - start,
        ...(failureReason ? { failureReason } : {}),
      };
      this.auditRecovery(result, options.expectWorking, acc.spawnError);
      if (classification === 'recovered-unverified' && failureReason !== 'backend-closed') {
        this.host.emitError({
          kind: 'session-recovery-unverified',
          id,
          attempts: repairAttempts,
          failureReason: failureReason ?? 'no-liveness-after-repair',
        });
      } else if (classification === 'recovered-live' && repairAttempts > 0) {
        // Only announce a repair when a recycle actually happened — a
        // first-probe-live session is silent success, matching the RFC's
        // "silent recovery except for a log line" posture for the happy path.
        this.host.emitError({ kind: 'session-recovery-repaired', id, attempts: repairAttempts });
      }
      return result;
    };

    // 1. Session must be known and its socket present.
    const entry = await this.host.manifestStore.getEntry(id);
    if (this.host.isClosed()) return finish('recovered-unverified', 0, false, 'backend-closed');
    if (!entry) return finish('recovered-unverified', 0, false, 'session-unknown');
    if (!existsSync(entry.sock)) return finish('recovered-unverified', 0, false, 'socket-missing');

    // 2. Verify the dtach master pid + socket still belong to this session.
    let masterPid = entry.pid;
    if (masterPid <= 0) masterPid = findDtachMasterPidSync(entry.sock, this.host.dtachBinary);
    acc.masterPid = masterPid;
    if (!verifyMasterIdentity(masterPid, entry.sock, this.host.dtachBinary)) {
      return finish('recovered-unverified', 0, false, 'identity-unverified');
    }
    acc.identityVerified = true;
    acc.agentPid = findAgentPidSync(masterPid);

    // 3. Ensure the persistent attach is open (opening the initial attach is NOT
    //    a repair) and observe it for ONGOING agent output (ring-head progress,
    //    with the on-attach redraw discounted via the settle window).
    const sess = this.host.createAttachedState(id, entry.sock);
    let probe = await this.observeRecoveryProgress(sess, entry.sock, settle, grace);
    if (this.host.isClosed()) return finish('recovered-unverified', 0, false, 'backend-closed');
    if (probe.spawnError) acc.spawnError = probe.spawnError;
    if (probe.live) return finish('recovered-live', 0, true);

    // 4. Silent. Known-idle sessions expect silence — never repair them.
    if (!options.expectWorking) return finish('recovered-idle', 0, false);

    // 5. Expected to be working but silent → recycle ONLY the internal attach
    //    child, bounded by the cap. The dtach master + agent are untouched.
    let attempts = 0;
    let failureReason: RecoveredSessionFailureReason = 'no-liveness-after-repair';
    while (attempts < cap) {
      attempts += 1;
      this.host.disposeAttachChildOnly(sess);
      probe = await this.observeRecoveryProgress(sess, entry.sock, settle, grace);
      if (this.host.isClosed()) return finish('recovered-unverified', attempts, false, 'backend-closed');
      if (probe.spawnError) acc.spawnError = probe.spawnError;
      if (probe.live) {
        // Re-resolve the agent pid so the audit proves it is unchanged post-repair.
        acc.agentPid = findAgentPidSync(masterPid);
        return finish('recovered-live', attempts, true);
      }
      // A fresh attach that never came up (spawn threw / immediately exited) is a
      // distinct, terminal failure — stop retrying and surface it.
      if (!sess.pty) {
        failureReason = 'attach-spawn-failed';
        break;
      }
    }

    acc.agentPid = findAgentPidSync(masterPid);
    return finish('recovered-unverified', attempts, false, failureReason);
  }

  /**
   * Ensure an attach child is live (opening one if none exists), let the dtach
   * on-attach redraw/replay flush during the settle window, then measure whether
   * *new* bytes keep arriving over the grace window — genuine agent progress, not
   * the one-shot redraw. Progress is detected two ways so nothing is missed: a
   * passive byte probe (resolves early on the next byte) and a `ringHead` delta
   * (catches bytes that landed between the baseline snapshot and probe install).
   * The probe ONLY reads — it never writes input. Returns `spawnError` when a
   * fresh attach could not be opened so the caller can record the OS cause.
   */
  async observeRecoveryProgress(
    sess: AttachedSession,
    sock: string,
    settleMs: number,
    windowMs: number,
  ): Promise<{ live: boolean; spawnError?: string }> {
    if (this.host.isClosed()) return { live: false, spawnError: 'backend-closed' };
    if (!sess.pty) {
      try {
        this.host.attachPtyInto(sess, sock, undefined, true);
      } catch (err) {
        return { live: false, spawnError: err instanceof Error ? err.message : String(err) };
      }
    }
    if (!sess.pty) return { live: false };

    // Let the on-attach redraw/replay flush so it is not mistaken for progress.
    if (settleMs > 0) {
      const settled = await this.host.raceWithClose(sleep(settleMs));
      if (settled === 'backend-closed') return { live: false, spawnError: 'backend-closed' };
    }

    // Baseline AFTER settle: bytes up to here (redraw + any pre-settle output)
    // are discounted. We only count what arrives during the window.
    const baseline = sess.ringHead;
    let resolveProgress: (() => void) | null = null;
    const progressSignal = new Promise<void>((resolve) => {
      resolveProgress = resolve;
    });
    const probe = (bytes: Uint8Array, source?: TerminalSessionDataSource): void => {
      if (bytes.length > 0 && source !== 'attach-replay') resolveProgress?.();
    };
    sess.dataSubscribers.add(probe);
    try {
      const progressedResult = await this.host.raceWithClose(Promise.race([
        progressSignal.then(() => true),
        sleep(windowMs).then(() => false),
      ]));
      if (progressedResult === 'backend-closed') {
        return { live: false, spawnError: 'backend-closed' };
      }
      // Fall back to the ring-head delta for a byte that raced probe install.
      return { live: progressedResult || sess.ringHead > baseline };
    } finally {
      sess.dataSubscribers.delete(probe);
    }
  }

  auditRecovery(
    result: VerifyRecoveredSessionResult,
    expectWorking: boolean,
    spawnError?: string,
  ): void {
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        msg: 'terminal_session_recovery',
        sessionId: result.sessionId,
        classification: result.classification,
        expectWorking,
        restartEpoch: result.restartEpoch,
        repairAttempts: result.repairAttempts,
        identityVerified: result.identityVerified,
        masterPid: result.masterPid,
        agentPid: result.agentPid,
        livenessObserved: result.livenessObserved,
        elapsedMs: result.elapsedMs,
        ...(result.failureReason ? { failureReason: result.failureReason } : {}),
        ...(spawnError ? { spawnError } : {}),
      }),
    );
  }

  /**
   * Startup recovery. Handles two cases:
   *   1. Manifest parses: clean expired `pending` entries. Validate each
   *      `active` entry's pid via `/proc/<pid>/exe` + cmdline; entries that
   *      fail validation flip to `recovered` state.
   *   2. Manifest fails to parse: rename to `.corrupt-<ts>`, rebuild from
   *      socket dir scan, emit `manifest-corrupt`.
   */
  async recoverOnStartup(): Promise<void> {
    await this.host.manifestStore.withLock(() => {
      const recovery = this.host.manifestStore.readForRecovery();
      if (recovery.kind === 'missing') return;

      let manifest: DtachManifestFile;
      if (recovery.kind === 'invalid') {
        this.host.manifestStore.renameCorrupt();
        manifest = this.rebuildManifestFromSocketDir();
        this.host.manifestStore.writeAtomic(manifest);
        this.host.emitError({ kind: 'manifest-corrupt', recoveredCount: manifest.entries.length });
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
          this.host.ringStore.remove(e.sessionId);
          return [];
        }
        // Active or recovered: verify pid ownership. Unverifiable entries
        // go to 'recovered' (visible but flagged) rather than silent deletion.
        const ok = verifyEntryOwnership(e, this.host.dtachBinary);
        if (ok) return [{ ...e, status: 'active' as const }];
        if (!existsSync(e.sock)) {
          // Manifest entry whose dtach master and socket are both gone — the
          // session is dead. Clean up its ring snapshot for the same reason
          // as the pending-aged-out branch above.
          this.host.ringStore.remove(e.sessionId);
          return [];
        }
        return [{ ...e, status: 'recovered' as const }];
      });

      if (manifest.entries.length !== before) {
        this.host.manifestStore.writeAtomic(manifest);
      }
    });
  }

  /**
   * Reconstruct manifest entries by scanning the instance's socket directory.
   * Each `.sock` file becomes a `recovered` entry (pid resolved if possible).
   * Used when the manifest fails to parse.
   */
  rebuildManifestFromSocketDir(): DtachManifestFile {
    const entries: DtachManifestEntry[] = [];
    let socks: string[] = [];
    try {
      socks = readdirSync(this.host.instanceDir).filter((n) => n.endsWith('.sock'));
    } catch {
      socks = [];
    }
    for (const sockName of socks) {
      const sessionId = sockName.replace(/\.sock$/, '');
      const sock = join(this.host.instanceDir, sockName);
      let pid = -1;
      try {
        pid = findDtachMasterPidSync(sock, this.host.dtachBinary);
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
    return { version: 1, instanceId: this.host.instanceId, entries };
  }
}
