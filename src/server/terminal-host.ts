import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { join } from 'node:path';
import type { LocalDtachBackendOptions } from '../adapters/local-dtach-shared.js';
import type { TerminalBackend, BackendStats, BackendError } from '../adapters/terminal-backend.js';
import type { TerminalSessionDiagnostics } from '../adapters/terminal-session-diagnostics.js';
import type { TerminalInputCoordinatorPort } from './terminal-input-coordinator.js';
import type { Actor } from './auth.js';
import type { ViewerConnectionRegistry } from './viewer-connection-registry.js';
import { TerminalHostChannel } from './terminal-host-channel.js';
import { TerminalHostRpcClient } from './terminal-host-rpc.js';
import { waitForTerminalAttachExit } from './terminal-host-owner.js';
import { EMPTY_TERMINAL_INPUT_RTT_SNAPSHOT } from './terminal-input-rtt-metrics.js';
import { TerminalInputSnapshotCache } from './terminal-input-snapshot-cache.js';
import { TerminalHostUnavailableError, terminalHostPayloadSize,
  type TerminalHostChildMessage, type TerminalHostMethod, type TerminalHostOperations,
  type TerminalHostResponse, type TerminalHostUpgrade } from './terminal-host-contract.js';

type StatsMessage = Extract<TerminalHostChildMessage, { kind: 'stats' }>;
type InputSnapshot = NonNullable<ReturnType<TerminalInputCoordinatorPort['getSnapshot']>>;
interface Subscription { id: string; sessionId: string; callback: Parameters<TerminalBackend['onData']>[1]; position: number }
export interface TerminalHostHealth {
  status: 'ready' | 'starting' | 'unavailable' | 'closed'; generation: string;
  pid: number | null; snapshotAgeMs: number | null; restarts: number;
  connections: number; legacyConnections: number; channelBytes: number; streamBytes: number; reconstructionBytes: number;
  outputBytes: number; persistenceBytes: number; rssBytes: number;
}

/**
 * Supervisor-side terminal facade. Reads used by dashboard health are cached;
 * writes, lifecycle decisions and empty-Enter authority execute in the child.
 * No operation is replayed across a process generation.
 */
export class TerminalHostBackend implements TerminalBackend {
  private child: ChildProcess | null = null;
  private channel: TerminalHostChannel | null = null;
  private rpc: TerminalHostRpcClient | null = null;
  private generation = '';
  private status: TerminalHostHealth['status'] = 'starting';
  private instanceDir = '';
  private snapshotAt = 0;
  private stats: BackendStats = { attachedSessions: 0, reattachCounts: {}, pendingWriters: 0,
    maxPendingWriters: 0, writeTimeoutCount: 0, attachFailedCount: 0, lastError: null, errorCount: 0 };
  private latest: StatsMessage | null = null;
  private readonly inputSnapshots = new TerminalInputSnapshotCache<InputSnapshot>();
  private readonly inputMutations = new Map<string, number>();
  private nextInputMutation = 0;
  // Per-session serialization for fire-and-forget readiness control RPCs (see
  // serializeInputControl): keeps a hook-replay burst from firing hundreds of
  // concurrent RPCs that overflow the client's in-flight cap and drop a transition.
  private readonly inputControlChains = new Map<string, Promise<unknown>>();
  // Global cap on concurrent readiness-control RPCs, kept well below the RPC
  // client's 128 in-flight limit so a cross-session mark burst queues here
  // rather than overflowing that limit and dropping a transition.
  private readonly maxReadinessInFlight = 64;
  private readinessSlots = this.maxReadinessInFlight;
  private readonly readinessWaiters: Array<() => void> = [];
  private readonly diagnostics = new Map<string, { at: number; value: TerminalSessionDiagnostics | null }>();
  private readonly diagnosticPending = new Set<string>();
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly gapListeners = new Set<(sessionId: string) => void>();
  private readonly errorListeners = new Set<(error: BackendError) => void>();
  private readonly eventListeners = new Set<(event: Extract<TerminalHostChildMessage, { kind: 'activity' }>) => void>();
  private readonly registries = new Set<ViewerConnectionRegistry>();
  private restartTimes: number[] = [];
  private restarts = 0;
  private closed = false;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private readyTimer: ReturnType<typeof setTimeout> | undefined;
  private killTimer: ReturnType<typeof setTimeout> | undefined;
  private exited: Promise<void> = Promise.resolve();
  readonly inputCoordinator: TerminalInputCoordinatorPort;

  private constructor(private readonly options: LocalDtachBackendOptions) {
    this.inputCoordinator = {
      registerSession: (id) => { this.mutateInputSession('input.registerSession', id); },
      cleanupSession: (id) => { this.mutateInputSession('input.cleanupSession', id); },
      dispose: () => { this.inputSnapshots.clear(); this.inputControlChains.clear(); void this.request('input.dispose', []).catch(() => {}); },
      getSnapshot: (id) => this.getHostHealth().status === 'ready' && !this.inputMutations.has(id)
        ? structuredClone(this.inputSnapshots.get(id)) : null,
      getWriteMetrics: () => this.latest?.inputMetrics ?? { pendingWrites: 0, maxPendingWrites: 0 },
      writeInput: (...args) => this.request('input.writeInput', args),
      writeInputSequence: (...args) => this.request('input.writeInputSequence', args),
      markUserPromptSubmitted: (...args) => this.serializeInputControl(args[0], () => this.request('input.markUserPromptSubmitted', args)),
      markToolStarted: (...args) => this.serializeInputControl(args[0], () => this.request('input.markToolStarted', args)),
      markPermissionBlocked: (...args) => this.serializeInputControl(args[0], () => this.request('input.markPermissionBlocked', args)),
      markStopFailure: (...args) => this.serializeInputControl(args[0], () => this.request('input.markStopFailure', args)),
      markTurnStopped: (...args) => this.serializeInputControl(args[0], () => this.request('input.markTurnStopped', args)),
      markSessionEnded: (...args) => this.serializeInputControl(args[0], () => this.request('input.markSessionEnded', args)),
      markPromptReady: (...args) => this.serializeInputControl(args[0], () => this.request('input.markPromptReady', args)),
      handleEmptyEnterIntent: (...args) => this.serializeInputControl(args[0].sessionId, () => this.request('input.handleEmptyEnterIntent', args)),
    };
  }

  /**
   * Order and rate-limit a session's readiness control RPCs (the fire-and-forget
   * lifecycle marks plus markPromptReady/handleEmptyEnterIntent, which must
   * observe them in order). Hook replay dispatches marks synchronously without
   * awaiting, so firing each as an immediate RPC lets a burst overflow the
   * client's 128 in-flight cap and silently drop a transition (e.g. a `stop`),
   * leaving the prompt stuck. Two bounds prevent that:
   *  - per-session chaining preserves order and bounds one session to one
   *    in-flight RPC (a single session's replayed marks);
   *  - a global semaphore caps concurrent readiness RPCs across ALL sessions
   *    well below the RPC in-flight cap, so a cross-session burst (one mark for
   *    each of many sessions) queues here instead of overflowing that cap.
   * Callers are unaffected: the marks are already fire-and-forget and the awaited
   * calls (markPromptReady/handleEmptyEnterIntent) still resolve with their
   * result, just after any queue wait.
   */
  private serializeInputControl<T>(sessionId: string, op: () => Promise<T>): Promise<T> {
    const prior = this.inputControlChains.get(sessionId) ?? Promise.resolve();
    const gated = async (): Promise<T> => {
      await this.acquireReadinessSlot();
      try { return await op(); } finally { this.releaseReadinessSlot(); }
    };
    const run = prior.then(gated, gated);
    const tail = run.then(() => {}, () => {});
    this.inputControlChains.set(sessionId, tail);
    void tail.then(() => { if (this.inputControlChains.get(sessionId) === tail) this.inputControlChains.delete(sessionId); });
    return run;
  }
  private acquireReadinessSlot(): Promise<void> {
    if (this.readinessSlots > 0) { this.readinessSlots--; return Promise.resolve(); }
    return new Promise<void>((resolve) => { this.readinessWaiters.push(resolve); });
  }
  private releaseReadinessSlot(): void {
    const waiter = this.readinessWaiters.shift();
    if (waiter) waiter(); // hand the freed slot directly to the next waiter
    else this.readinessSlots++;
  }

  private mutateInputSession(method: 'input.registerSession' | 'input.cleanupSession', id: string) {
    if (this.inputMutations.size >= 512 && !this.inputMutations.has(id)) return;
    const mutation = ++this.nextInputMutation; const generation = this.generation;
    this.inputMutations.set(id, mutation); this.inputSnapshots.delete(id);
    // Clear our marker once the mutation settles — on success AND on failure. A
    // failed request (e.g. rejected at the RPC's in-flight cap during a burst
    // registration) must not strand the marker: getSnapshot masks the session
    // while a marker is present, so a retained marker permanently hides
    // readiness even after a later child snapshot arrives. Clearing is not
    // optimistic — getSnapshot then reflects the cache (still null after the
    // delete above until a real snapshot lands) and can recover on retry. The
    // mutation-id guard keeps a superseding register/cleanup's marker intact.
    const settle = () => {
      if (this.generation === generation && this.inputMutations.get(id) === mutation) this.inputMutations.delete(id);
    };
    void this.request(method, [id]).then(settle, settle);
  }

  static async create(options: LocalDtachBackendOptions): Promise<TerminalHostBackend> {
    const host = new TerminalHostBackend(options);
    try { await host.startGeneration(); return host; }
    catch (error) { await host.closeAndDrain(); throw error; }
  }

  getInstanceDir() { return this.instanceDir; }
  getInputRttSnapshot() { return this.latest?.inputRtt ?? EMPTY_TERMINAL_INPUT_RTT_SNAPSHOT; }
  getHostHealth(): TerminalHostHealth {
    const age = this.snapshotAt ? Math.max(0, Date.now() - this.snapshotAt) : null;
    return { status: this.status === 'ready' && (age === null || age > 3000) ? 'unavailable' : this.status,
      generation: this.generation, pid: this.child?.pid ?? null, snapshotAgeMs: age, restarts: this.restarts,
      connections: this.latest?.connections ?? 0, legacyConnections: this.latest?.legacyConnections ?? 0,
      channelBytes: (this.channel?.pendingBytes ?? 0) + (this.latest?.channelBytes ?? 0),
      streamBytes: this.latest?.streamBytes ?? 0, reconstructionBytes: this.latest?.reconstructionBytes ?? 0,
      outputBytes: this.latest?.outputBytes ?? 0, persistenceBytes: this.latest?.persistence.pendingBytes ?? 0,
      rssBytes: this.latest?.rssBytes ?? 0 };
  }
  getStats(): BackendStats {
    const health = this.getHostHealth();
    return { ...this.stats, terminalHost: { status: health.status, generation: this.generation,
      snapshotAgeMs: health.snapshotAgeMs, pendingRequests: this.rpc?.pendingCount ?? 0,
      pendingBytes: (this.rpc?.pendingBytes ?? 0) + health.channelBytes,
      connections: health.connections, legacyConnections: health.legacyConnections, restarts: health.restarts,
      channelBytes: health.channelBytes, streamBytes: health.streamBytes,
      reconstructionBytes: health.reconstructionBytes, outputBytes: health.outputBytes,
      persistenceBytes: health.persistenceBytes, rssBytes: health.rssBytes } };
  }

  private startGeneration(): Promise<void> {
    if (this.closed || this.child) return Promise.reject(new TerminalHostUnavailableError());
    this.status = 'starting'; this.generation = randomUUID(); this.latest = null; this.snapshotAt = 0;
    // A new child restarts its monotonic version counter at 0, so the previous
    // generation's reclaim floor must not fence out the fresh generation.
    this.inputSnapshots.resetGeneration();
    const generation = this.generation;
    const source = __filename.endsWith('.ts');
    const child = fork(join(__dirname, `terminal-host-entry.${source ? 'ts' : 'js'}`), [], {
      execArgv: source ? ['--import', 'tsx'] : [], serialization: 'advanced',
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    this.child = child;
    const channel = new TerminalHostChannel((value, handle, done) => {
      if (!child.connected) { done(new Error('Terminal host disconnected')); return; }
      if (handle) child.send(value as TerminalHostUpgrade, handle, { keepOpen: false }, done);
      else child.send(value as TerminalHostResponse, done);
    });
    this.channel = channel;
    this.rpc = new TerminalHostRpcClient(generation,
      (packet, done) => { channel.send(packet, { done }); },
      (response) => this.cacheResponse(response));
    let resolveExit!: () => void;
    this.exited = new Promise((resolve) => { resolveExit = resolve; });
    const ready = new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = () => { if (!settled) { settled = true; reject(new TerminalHostUnavailableError('Terminal host failed before readiness')); } };
      this.readyTimer = setTimeout(() => { fail(); this.retire(child); }, 10_000);
      child.on('message', (message: TerminalHostChildMessage) => {
        if (this.child !== child || !message || typeof message !== 'object' || message.generation !== generation
          || terminalHostPayloadSize(message) > 8 * 1024 * 1024) return;
        if (message.kind === 'ready') {
          if (settled || this.closed) return;
          settled = true; clearTimeout(this.readyTimer); this.readyTimer = undefined;
          this.instanceDir = message.instanceDir; this.stats = message.stats;
          this.snapshotAt = Date.now(); this.status = 'ready'; resolve();
        } else this.receive(message);
      });
      child.on('error', () => { fail(); this.retire(child); });
      child.on('disconnect', () => { fail(); this.retire(child); });
      child.on('exit', () => {
        fail();
        if (this.child !== child) { resolveExit(); return; }
        clearTimeout(this.readyTimer); clearTimeout(this.killTimer); clearInterval(this.heartbeat);
        this.readyTimer = undefined; this.killTimer = undefined; this.heartbeat = undefined;
        this.rpc?.close(); channel.close(); this.rpc = null; this.channel = null; this.child = null;
        this.status = this.closed ? 'closed' : 'unavailable';
        this.inputSnapshots.clear(); this.inputControlChains.clear(); this.inputMutations.clear(); this.diagnostics.clear(); this.diagnosticPending.clear();
        for (const registry of this.registries) registry.unregisterRemoteGeneration(generation);
        this.registries.clear();
        this.invalidateStreams();
        resolveExit();
        if (!this.closed) void waitForTerminalAttachExit(this.instanceDir).then((retired) => {
          if (this.closed || this.generation !== generation) return;
          if (retired) this.scheduleRestart();
          else console.warn('[terminal-host] Restart blocked: previous attach ownership is unverified');
        }).catch(() => { /* Unverifiable ownership stays unavailable. */ });
      });
    });
    this.heartbeat = setInterval(() => {
      if (this.status === 'ready' && Date.now() - this.snapshotAt > 8000) this.retire(child);
    }, 1000);
    this.heartbeat.unref?.();
    channel.send({ kind: 'init', generation, options: this.options });
    return ready;
  }

  private retire(child: ChildProcess) {
    if (this.child !== child || this.killTimer) return;
    this.status = this.closed ? 'closed' : 'unavailable';
    this.rpc?.close();
    this.inputSnapshots.clear(); this.inputControlChains.clear(); this.invalidateStreams();
    if (child.connected) this.channel?.send({ kind: 'shutdown', generation: this.generation });
    child.kill('SIGTERM');
    // Only positive exit unlocks replacement. No second owner is started on a
    // timeout alone, even if a platform fails to deliver the forced signal.
    this.killTimer = setTimeout(() => { if (this.child === child) child.kill('SIGKILL'); }, 3500);
  }
  private scheduleRestart() {
    const now = Date.now();
    this.restartTimes = this.restartTimes.filter((at) => now - at < 60_000);
    if (this.restartTimes.length >= 3) return;
    const delay = [500, 1500, 4000][this.restartTimes.length]!;
    this.restartTimes.push(now);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      if (this.closed || this.child) return;
      this.restarts++;
      void this.startGeneration().catch(() => {});
    }, delay);
    this.restartTimer.unref?.();
  }

  private receive(message: Exclude<TerminalHostChildMessage, { kind: 'ready' }>) {
    switch (message.kind) {
      case 'response': this.rpc?.receive(message); return;
      case 'stats':
        this.latest = message; this.stats = message.stats; this.snapshotAt = message.at;
        for (const snapshot of message.inputSnapshots) this.cacheInput(snapshot, message.inputSnapshotVersion);
        return;
      case 'backend-error':
        for (const listener of this.errorListeners) { try { listener(message.error); } catch {} }
        return;
      case 'connection-closed':
        for (const registry of this.registries) registry.confirmRemoteClosed(message.generation, message.id);
        return;
      case 'activity':
        for (const listener of this.eventListeners) { try { listener(message); } catch {} }
        return;
      case 'stream-gap': this.invalidateStream(message.id); return;
      case 'stream-data': {
        const subscription = this.subscriptions.get(message.id);
        if (!subscription) return;
        if (message.position !== subscription.position + message.bytes.length) { this.invalidateStream(message.id); return; }
        subscription.position = message.position;
        try { subscription.callback(message.bytes, message.source, message.range); }
        catch { this.invalidateStream(message.id); return; }
        // Credit returns only after the relay consumer has processed the bytes.
        void this.request('stream.ack', [message.id, message.position]).catch(() => this.invalidateStream(message.id));
        return;
      }
    }
  }
  private cacheInput(snapshot: InputSnapshot, version: number) {
    this.inputSnapshots.admitLive(snapshot.sessionId, snapshot, version);
  }
  private cacheResponse(response: TerminalHostResponse) {
    if (response.inputSnapshot && response.inputSnapshotVersion !== undefined)
      this.inputSnapshots.admitLive(response.inputSnapshot.sessionId, response.inputSnapshot, response.inputSnapshotVersion);
    else if (response.inputSessionId && response.inputSnapshot === null && response.inputSnapshotVersion !== undefined)
      this.inputSnapshots.admitTombstone(response.inputSessionId, response.inputSnapshotVersion);
  }

  private request<K extends TerminalHostMethod>(method: K, args: Parameters<TerminalHostOperations[K]>,
    timeoutMs?: number): Promise<Awaited<ReturnType<TerminalHostOperations[K]>>> {
    if (!this.rpc || this.status !== 'ready' || this.closed) return Promise.reject(new TerminalHostUnavailableError());
    return this.rpc.request(method, args, timeoutMs);
  }

  createSession = (...args: Parameters<TerminalHostOperations['createSession']>) => this.request('createSession', args, 30_000);
  killSession = (...args: Parameters<TerminalHostOperations['killSession']>) => this.request('killSession', args, 30_000);
  listSessions = (...args: Parameters<TerminalHostOperations['listSessions']>) => this.request('listSessions', args);
  isAlive = (...args: Parameters<TerminalHostOperations['isAlive']>) => this.request('isAlive', args);
  write = (...args: Parameters<TerminalHostOperations['write']>) => this.request('write', args);
  writeSequence = (...args: Parameters<TerminalHostOperations['writeSequence']>) => this.request('writeSequence', args);
  captureBytes = (...args: Parameters<TerminalHostOperations['captureBytes']>) => this.request('captureBytes', args);
  captureStreamSnapshot = (...args: Parameters<TerminalHostOperations['captureStreamSnapshot']>) => this.request('captureStreamSnapshot', args);
  captureCurrentFrame = (...args: Parameters<TerminalHostOperations['captureCurrentFrame']>) => this.request('captureCurrentFrame', args);
  resize = (...args: Parameters<TerminalHostOperations['resize']>) => this.request('resize', args);
  getSessionStartedAt = (...args: Parameters<TerminalHostOperations['getSessionStartedAt']>) => this.request('getSessionStartedAt', args);
  reconnectTransport = (...args: Parameters<TerminalHostOperations['reconnectTransport']>) => this.request('reconnectTransport', args);
  verifyRecoveredSession = (...args: Parameters<TerminalHostOperations['verifyRecoveredSession']>) => this.request('verifyRecoveredSession', args, 30_000);
  recoverLaunchAbandonedSessions = (...args: Parameters<TerminalHostOperations['recoverLaunchAbandonedSessions']>) => this.request('recoverLaunchAbandonedSessions', args, 30_000);

  getSessionDiagnostics(id: string): TerminalSessionDiagnostics | null {
    if (this.getHostHealth().status !== 'ready') return null;
    const cached = this.diagnostics.get(id);
    if ((!cached || Date.now() - cached.at > 2000) && !this.diagnosticPending.has(id) && this.diagnosticPending.size < 20) {
      const generation = this.generation;
      this.diagnosticPending.add(id);
      void this.request('getSessionDiagnostics', [id]).then((value) => {
        if (this.generation !== generation) return;
        if (this.diagnostics.size >= 512) this.diagnostics.delete(this.diagnostics.keys().next().value!);
        this.diagnostics.set(id, { at: Date.now(), value });
      }).catch(() => {}).finally(() => { if (this.generation === generation) this.diagnosticPending.delete(id); });
    }
    return cached && Date.now() - cached.at <= 5000 ? cached.value : null;
  }

  onData(sessionId: string, callback: Parameters<TerminalBackend['onData']>[1]): () => void {
    if (this.subscriptions.size >= 256) throw new TerminalHostUnavailableError('Stream subscription capacity');
    const id = randomUUID();
    this.subscriptions.set(id, { id, sessionId, callback, position: 0 });
    void this.request('stream.subscribe', [id, sessionId]).catch(() => this.invalidateStream(id));
    return () => {
      if (!this.subscriptions.delete(id)) return;
      void this.request('stream.unsubscribe', [id]).catch(() => {});
    };
  }
  private invalidateStream(id: string) {
    const subscription = this.subscriptions.get(id); if (!subscription) return;
    this.subscriptions.delete(id);
    void this.request('stream.unsubscribe', [id]).catch(() => {});
    for (const listener of this.gapListeners) { try { listener(subscription.sessionId); } catch {} }
  }
  private invalidateStreams() { for (const id of this.subscriptions.keys()) this.invalidateStream(id); }
  onStreamGap(callback: (sessionId: string) => void) { this.gapListeners.add(callback); return () => { this.gapListeners.delete(callback); }; }
  onBackendError(callback: (error: BackendError) => void) { this.errorListeners.add(callback); return () => { this.errorListeners.delete(callback); }; }
  onActivity(callback: (event: Extract<TerminalHostChildMessage, { kind: 'activity' }>) => void) {
    this.eventListeners.add(callback); return () => { this.eventListeners.delete(callback); };
  }

  handoff(request: IncomingMessage, socket: Socket, head: Buffer, sessionId: string, actor: Actor,
    registry: ViewerConnectionRegistry): void {
    const lease = registry.terminalLeaseUntil(actor, sessionId);
    let expiry: number | null | undefined;
    try { expiry = registry.terminalGrantExpiry(actor); } catch { expiry = undefined; }
    if (this.getHostHealth().status !== 'ready' || !this.channel || lease === null || expiry === undefined
      || head.length > 64 * 1024 || terminalHostPayloadSize(request.headers) > 32 * 1024) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); return;
    }
    const generation = this.generation; const id = randomUUID();
    socket.pause(); socket.on('error', () => {});
    try {
      registry.registerRemote({ generation, id, actor, sessionName: sessionId, remoteAddr: socket.remoteAddress,
        renew: (leaseUntilMs) => {
          if (this.generation !== generation) return;
          void this.request('connection.renew', [id, leaseUntilMs], 1500).catch(() => {});
        },
        close: async () => this.generation === generation
          ? this.request('connection.close', [id], 1500).catch(() => false) : false,
      });
    } catch { socket.destroy(); return; }
    this.registries.add(registry);
    const packet: TerminalHostUpgrade = { kind: 'upgrade', generation, id, sessionId, role: actor.kind,
      ...(actor.kind === 'viewer' ? { grantId: actor.grantId } : {}),
      grantExpiresAtMs: expiry, leaseUntilMs: lease, method: request.method ?? 'GET',
      url: request.url ?? '/', headers: request.headers, head: Uint8Array.from(head) };
    this.channel.send(packet, { handle: socket, done: (error) => {
      if (!error) return;
      socket.destroy();
      // Transfer failure may be ambiguous. Positive child exit is the fallback
      // confirmation for any registration whose socket ownership is uncertain.
      if (this.child && this.generation === generation) this.retire(this.child);
    } });
  }

  close(): void { void this.closeAndDrain(); }
  async closeAndDrain(): Promise<void> {
    if (!this.closed) {
      this.closed = true; clearTimeout(this.restartTimer); this.restartTimer = undefined;
      if (this.child) this.retire(this.child); else this.status = 'closed';
    }
    await this.exited;
  }
}
