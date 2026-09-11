// --- Viewer connection registry (RFC: rfc-shared-view-readonly.md) ---
//
// The **sole owner** of the authoritative `Map<WebSocket, Actor>` for BOTH the
// dashboard pool (`/ws`) and the terminal pool (`/ws/terminal/:sessionName`).
// Before this module the dashboard `clients` set was mutated by three parties
// (the connection handler, the broadcaster, and the shutdown path); routing all
// lifecycle through one owner removes that shared-mutable-ownership smell
// (round-3 boundary fix). Connection handlers receive the narrow
// {@link SocketRegistrar} interface — they `register`/`unregister`, never touch
// the underlying map.
//
// The registry also runs the **revocation sweep**: a periodic, error-isolated
// tick that drops any dashboard OR terminal socket whose viewer grant is no
// longer live (revoked / expired / deleted). Owner sockets are never swept.

import { WebSocket } from 'ws';

import type { Actor } from './auth.js';
import type { Scope } from './viewer-data-policy.js';
import type { IsActorAllowedTerminalSession } from './terminal-scope.js';

/** Which connection pool a socket belongs to. */
export type SocketKind = 'dashboard' | 'terminal';

/** Extra registration metadata. Terminal sockets carry their session name. */
export interface SocketMeta {
  /** The attached terminal session (terminal sockets only). */
  sessionName?: string;
  /** Remote address of the upgrade, surfaced (owner-only) in the viewer roster (#808). */
  remoteAddr?: string;
}

/** An entry in the registry. */
export interface RegisteredSocket {
  ws: WebSocket;
  actor: Actor;
  kind: SocketKind;
  /** Present for terminal sockets so the sweep can re-check session scope (#810). */
  sessionName?: string;
  /** Remote address captured at registration, for the owner roster (#808). */
  remoteAddr?: string;
  /** Wall-clock ms when this socket registered, for the owner roster (#808). */
  connectedAtMs: number;
}

/**
 * One live viewer connection as surfaced to the owner's Share UI by
 * `GET /api/share/viewers` (#808). Carries no token — only the grant id, when
 * it connected, where from, and the scope it is effectively being served.
 */
export interface ViewerConnectionInfo {
  grantId: string;
  kind: SocketKind;
  sessionName?: string;
  /** ISO-8601 connection timestamp. */
  connectedAt: string;
  remoteAddr?: string;
  /** The scope the grant is being served at (canonical). */
  scopeEffective: Scope;
}

/**
 * Observability snapshot for the `/api/health` `viewerBroadcaster` block (#808 /
 * R10): the sweep cadence + liveness and how many distinct viewers are
 * connected, so a dead sweep or a stuck viewer set is visible to the operator.
 */
export interface ViewerBroadcasterHealth {
  /** Remote-owned connections whose requested closure is not yet acknowledged. */
  enforcementPending?: number;
  sweepIntervalMs: number;
  /** ISO-8601 of the last completed sweep tick, or null if none ran yet. */
  lastSweepAt: string | null;
  sweepTickCount: number;
  /** Distinct viewer grants with at least one open socket. */
  connectedViewerCount: number;
}

/**
 * A point-in-time copy of one open dashboard connection, handed to the
 * broadcaster. Carries the `actor` so the broadcaster can pick the right
 * (scoped) snapshot per connection without reaching back into the live map.
 */
export interface DashboardConnection {
  ws: WebSocket;
  actor: Actor;
}

/**
 * The narrow surface a connection handler needs: it registers its socket on
 * open and unregisters on close instead of mutating a shared `Set<WebSocket>`.
 * `handleWsConnection` is passed this, not the raw map — so the connection set
 * no longer escapes (round-3 boundary Issue 2).
 */
export interface SocketRegistrar {
  register(ws: WebSocket, actor: Actor, kind: SocketKind, meta?: SocketMeta): void;
  unregister(ws: WebSocket): void;
}

/**
 * Liveness of a viewer grant, resolved against the grant store (#803). The
 * sweep drops any socket whose grant is not `active`.
 */
export type GrantLiveness = 'active' | 'revoked' | 'expired' | 'not-found';

/**
 * Why the sweep evicted a socket. Surfaced to the audit hook (#808 / R10).
 * `out-of-scope` (#810) is terminal-only: a still-live grant whose attached task
 * was reassigned out of the grant's project scope (reassignment TOCTOU, RFC F8).
 * `liveness-timeout` (#1725) is the dead-socket ping/pong reap: the socket was
 * already non-OPEN or failed to answer a ping within one sweep tick.
 */
export type EvictionReason = Exclude<GrantLiveness, 'active'> | 'out-of-scope' | 'liveness-timeout';

/** Payload handed to {@link ViewerConnectionRegistryOptions.onEvict}. */
export interface SweepEviction {
  grantId: string;
  kind: SocketKind;
  sessionName?: string;
  reason: EvictionReason;
}

export interface ViewerConnectionRegistryOptions {
  /** null means no grant expiry; undefined means the grant cannot be resolved. */
  resolveGrantExpiryMs?: (grantId: string) => number | null | undefined;
  /**
   * Resolve a viewer grant's current liveness. Injected from the grant store
   * (#803) when viewers are wired (#806/#808). Phase 1 has no viewers — viewer
   * cookies are not yet admitted onto `/ws` — so the default treats every grant
   * as active and the sweep evicts nothing.
   */
  resolveGrantLiveness?: (grantId: string) => GrantLiveness;
  /**
   * Terminal scope predicate (#810). On each sweep tick, every still-live
   * terminal viewer socket is re-checked: if its attached session is no longer
   * in the grant's scope (the task was reassigned out of scope — reassignment
   * TOCTOU, RFC F8), the socket is evicted with reason `out-of-scope`. Owners
   * and dashboard sockets are never scope-checked. Omitted when no terminal
   * scope filtering is wired (Phase 1 / lightweight tests).
   */
  isActorAllowedTerminalSession?: IsActorAllowedTerminalSession;
  /** Revocation-sweep interval in milliseconds. Default 10 000. */
  sweepIntervalMs?: number;
  /** Audit hook fired once per evicted socket (#808 / R10). Never throws into the sweep. */
  onEvict?: (eviction: SweepEviction) => void;
  /** Injected clock for `lastSweepAt` (testability). Defaults to `Date.now`. */
  now?: () => number;
  /** Start the sweep timer on construction. Default true; tests pass false and call {@link sweep} directly. */
  autoStartSweep?: boolean;
  /**
   * Dead-socket ping/pong liveness reaping (#1725). The 2026-07-31 incident
   * left 227+ sockets in CLOSE-WAIT because the saturated event loop never
   * got around to processing the FIN the OS already delivered — `ws.close()`
   * relies on that same queued processing, so a socket stuck mid-close stays
   * registered (and keeps being handed to the broadcaster) indefinitely.
   * `ws.terminate()` destroys the underlying TCP socket synchronously, so
   * running this check on the existing sweep tick (already independent of
   * broadcast cadence) reaps it regardless of event-loop backlog. Default
   * true; set false to opt out (rollback knob).
   */
  livenessSweepEnabled?: boolean;
}

const DEFAULT_SWEEP_INTERVAL_MS = 10_000;

export interface RemoteTerminalRegistration {
  generation: string;
  id: string;
  actor: Actor;
  sessionName: string;
  remoteAddr?: string;
  renew(leaseUntilMs: number): void;
  /** Resolves true only after the child has destroyed the exact connection. */
  close(reason: EvictionReason): Promise<boolean>;
}
interface RemoteTerminalEntry extends RemoteTerminalRegistration {
  connectedAtMs: number;
  closing: boolean;
  pendingReason?: EvictionReason;
}
/** Close code for a socket dropped on a policy violation (revoked/expired/out-of-scope). */
const REVOKED_CLOSE_CODE = 1008;
const REVOKED_CLOSE_REASON = 'Access revoked';
/** Close reason for a terminal socket dropped because its task left the grant's scope (#810). */
const OUT_OF_SCOPE_CLOSE_REASON = 'Out of scope';
/** Close code for a socket dropped during server shutdown (going away). */
const SHUTDOWN_CLOSE_CODE = 1001;
const SHUTDOWN_CLOSE_REASON = 'Server shutting down';

/** Observability snapshot for the dead-socket liveness sweep (#1725). */
export interface LivenessSweepHealth {
  enabled: boolean;
  /** Total sockets terminated for failing a ping/pong round or sitting non-OPEN. */
  reapCount: number;
  /** ISO-8601 of the last liveness reap, or null if none happened yet. */
  lastReapAt: string | null;
}

export class ViewerConnectionRegistry implements SocketRegistrar {
  private readonly sockets = new Map<WebSocket, RegisteredSocket>();
  private readonly remoteTerminals = new Map<string, RemoteTerminalEntry>();
  private remoteLeaseTimer: ReturnType<typeof setInterval> | undefined;
  private readonly resolveGrantExpiryMs?: ViewerConnectionRegistryOptions['resolveGrantExpiryMs'];
  private readonly automaticSweep: boolean;
  private readonly resolveGrantLiveness: (grantId: string) => GrantLiveness;
  private readonly isActorAllowedTerminalSession?: IsActorAllowedTerminalSession;
  private readonly onEvict?: (eviction: SweepEviction) => void;
  private readonly now: () => number;
  private readonly sweepIntervalMs: number;
  private readonly livenessSweepEnabled: boolean;
  /** Per-socket ping-round-trip flag: true unless a ping went unanswered for one whole sweep tick. */
  private readonly livenessAlive = new WeakMap<WebSocket, boolean>();
  private sweepTimer: ReturnType<typeof setInterval> | undefined;
  private tickCount = 0;
  private lastSweepAtMs: number | null = null;
  private livenessReapCount = 0;
  private lastLivenessReapAtMs: number | null = null;

  constructor(options: ViewerConnectionRegistryOptions = {}) {
    this.resolveGrantExpiryMs = options.resolveGrantExpiryMs;
    this.automaticSweep = options.autoStartSweep !== false;
    this.resolveGrantLiveness = options.resolveGrantLiveness ?? (() => 'active');
    this.isActorAllowedTerminalSession = options.isActorAllowedTerminalSession;
    this.onEvict = options.onEvict;
    this.now = options.now ?? (() => Date.now());
    this.sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.livenessSweepEnabled = options.livenessSweepEnabled ?? true;
    if (options.autoStartSweep !== false) this.startSweep();
  }

  register(ws: WebSocket, actor: Actor, kind: SocketKind, meta?: SocketMeta): void {
    this.sockets.set(ws, {
      ws,
      actor,
      kind,
      sessionName: meta?.sessionName,
      remoteAddr: meta?.remoteAddr,
      connectedAtMs: this.now(),
    });
    // Duck-typed: real `ws.WebSocket` instances always implement `on`; a
    // lightweight test double that only stubs `send`/`close`/`readyState`
    // simply opts out of ping/pong liveness (readyState-based reaping below
    // still applies to it).
    if (this.livenessSweepEnabled && typeof ws.on === 'function') {
      this.livenessAlive.set(ws, true);
      // Attached once at registration (mirrors the standard `ws` heartbeat
      // recipe). Left attached for the socket's lifetime — a no-op closure
      // over an unregistered `ws` costs nothing and self-cleans via the
      // WeakMap once the socket is garbage collected.
      ws.on('pong', () => {
        this.livenessAlive.set(ws, true);
      });
    }
  }

  unregister(ws: WebSocket): void {
    this.sockets.delete(ws);
  }

  terminalGrantExpiry(actor: Actor): number | null | undefined {
    return actor.kind === 'owner' ? null : this.resolveGrantExpiryMs?.(actor.grantId);
  }

  /** Policy decisions stay in main; the child receives at most a ten-second lease. */
  terminalLeaseUntil(actor: Actor, sessionName: string): number | null {
    try {
      const now = this.now();
      if (actor.kind === 'owner') return now + 10_000;
      if (this.resolveGrantLiveness(actor.grantId) !== 'active'
        || (this.isActorAllowedTerminalSession && !this.isActorAllowedTerminalSession(actor, sessionName))) return null;
      const expiry = this.terminalGrantExpiry(actor);
      if (expiry === undefined || (expiry !== null && (!Number.isFinite(expiry) || expiry <= now))) return null;
      return Math.min(now + 10_000, expiry ?? Infinity);
    } catch { return null; }
  }

  registerRemote(registration: RemoteTerminalRegistration): void {
    if (this.remoteTerminals.size >= 256) throw new Error('Remote terminal connection capacity exceeded');
    const key = JSON.stringify([registration.generation, registration.id]);
    if (this.remoteTerminals.has(key)) throw new Error('Duplicate remote terminal connection');
    this.remoteTerminals.set(key, { ...registration, connectedAtMs: this.now(), closing: false });
    if (this.automaticSweep && !this.remoteLeaseTimer) {
      this.remoteLeaseTimer = setInterval(() => this.renewRemoteTerminals(), 2000);
      this.remoteLeaseTimer.unref?.();
    }
  }

  unregisterRemote(generation: string, id: string): void {
    this.remoteTerminals.delete(JSON.stringify([generation, id]));
    if (this.remoteTerminals.size === 0 && this.remoteLeaseTimer) {
      clearInterval(this.remoteLeaseTimer); this.remoteLeaseTimer = undefined;
    }
  }

  /** A child socket-close notification also settles a pending revocation audit. */
  confirmRemoteClosed(generation: string, id: string): void {
    const entry = this.remoteTerminals.get(JSON.stringify([generation, id]));
    if (entry) this.finishRemoteClose(entry);
  }

  /** Actual child exit confirms closure even when its last acknowledgement was lost. */
  unregisterRemoteGeneration(generation: string): void {
    for (const entry of this.remoteTerminals.values()) {
      if (entry.generation === generation) this.finishRemoteClose(entry);
    }
  }

  renewRemoteTerminals(): void {
    for (const entry of this.remoteTerminals.values()) {
      if (entry.actor.kind !== 'viewer' || entry.closing) continue;
      const lease = this.terminalLeaseUntil(entry.actor, entry.sessionName);
      if (lease !== null && !entry.pendingReason) {
        try { entry.renew(lease); } catch { this.requestRemoteClose(entry, 'liveness-timeout'); }
      } else {
        let reason: EvictionReason = entry.pendingReason ?? 'out-of-scope';
        try {
          const live = this.resolveGrantLiveness(entry.actor.grantId);
          if (live !== 'active') reason = live;
        } catch { /* unresolved policy closes fail-closed */ }
        this.requestRemoteClose(entry, reason);
      }
    }
  }

  private requestRemoteClose(entry: RemoteTerminalEntry, reason: EvictionReason) {
    if (entry.closing) return;
    entry.pendingReason = reason;
    entry.closing = true;
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 2000); timer.unref?.(); });
    let acknowledgement: Promise<boolean>;
    try { acknowledgement = entry.close(reason); }
    catch { acknowledgement = Promise.resolve(false); }
    Promise.race([acknowledgement, deadline]).then((confirmed) => {
      if (confirmed) this.finishRemoteClose(entry);
    }).catch(() => {}).finally(() => { clearTimeout(timer); entry.closing = false; });
  }

  private finishRemoteClose(entry: RemoteTerminalEntry) {
    const key = JSON.stringify([entry.generation, entry.id]);
    if (this.remoteTerminals.get(key) !== entry) return;
    this.unregisterRemote(entry.generation, entry.id);
    if (entry.actor.kind === 'viewer' && entry.pendingReason) {
      try { this.onEvict?.({ grantId: entry.actor.grantId, kind: 'terminal', sessionName: entry.sessionName, reason: entry.pendingReason }); }
      catch { /* audit failure does not reopen the socket */ }
    }
  }

  /**
   * Local sockets (either pool) held by a given grant. Remote-owned terminal
   * sockets are represented by registrations, not WebSocket objects; revocation
   * reaches both through the policy sweep and the child authorization lease.
   */
  findByGrant(grantId: string): RegisteredSocket[] {
    const out: RegisteredSocket[] = [];
    for (const entry of this.sockets.values()) {
      if (entry.actor.kind === 'viewer' && entry.actor.grantId === grantId) out.push(entry);
    }
    return out;
  }

  /**
   * A **snapshot copy** of the currently-open dashboard sockets. The copy is the
   * point of this method: the broadcaster iterates the returned array while the
   * sweep may concurrently `unregister`/close sockets, and a copy means the
   * fan-out can never observe a half-mutated live collection (round-3 coupling).
   */
  getOpenDashboardSockets(): WebSocket[] {
    return this.snapshotDashboardConnections().map((c) => c.ws);
  }

  /**
   * Like {@link getOpenDashboardSockets} but pairs each open dashboard socket
   * with its `actor`, so the broadcaster can select a scoped snapshot per
   * connection. Also a snapshot copy.
   */
  snapshotDashboardConnections(): DashboardConnection[] {
    const out: DashboardConnection[] = [];
    for (const entry of this.sockets.values()) {
      if (entry.kind === 'dashboard' && entry.ws.readyState === WebSocket.OPEN) {
        out.push({ ws: entry.ws, actor: entry.actor });
      }
    }
    return out;
  }

  /** Number of registered dashboard sockets (the legacy `clients.size`). */
  dashboardCount(): number {
    let count = 0;
    for (const entry of this.sockets.values()) {
      if (entry.kind === 'dashboard') count++;
    }
    return count;
  }

  /** Total registered sockets across both pools. */
  size(): number {
    return this.sockets.size + this.remoteTerminals.size;
  }

  /**
   * Per-connection roster of every currently-open **viewer** socket, for the
   * owner's `GET /api/share/viewers` (#808). Owner sockets are omitted (the
   * roster is about who is *viewing*). Only open sockets are reported, so a
   * just-closed-but-not-yet-unregistered socket does not appear as live.
   */
  viewerRoster(): ViewerConnectionInfo[] {
    const out: ViewerConnectionInfo[] = [];
    for (const entry of this.sockets.values()) {
      if (entry.actor.kind !== 'viewer') continue;
      if (entry.ws.readyState !== WebSocket.OPEN) continue;
      out.push({
        grantId: entry.actor.grantId,
        kind: entry.kind,
        ...(entry.sessionName ? { sessionName: entry.sessionName } : {}),
        connectedAt: new Date(entry.connectedAtMs).toISOString(),
        ...(entry.remoteAddr ? { remoteAddr: entry.remoteAddr } : {}),
        scopeEffective: entry.actor.scope,
      });
    }
    for (const entry of this.remoteTerminals.values()) {
      if (entry.actor.kind !== 'viewer') continue;
      out.push({ grantId: entry.actor.grantId, kind: 'terminal', sessionName: entry.sessionName,
        connectedAt: new Date(entry.connectedAtMs).toISOString(), remoteAddr: entry.remoteAddr, scopeEffective: entry.actor.scope });
    }
    return out;
  }

  /** Number of distinct viewer grants with at least one open socket (R10). */
  connectedViewerCount(): number {
    const grants = new Set<string>();
    for (const entry of this.sockets.values()) {
      if (entry.actor.kind === 'viewer' && entry.ws.readyState === WebSocket.OPEN) {
        grants.add(entry.actor.grantId);
      }
    }
    for (const entry of this.remoteTerminals.values()) if (entry.actor.kind === 'viewer') grants.add(entry.actor.grantId);
    return grants.size;
  }

  /** Observability snapshot for the `/api/health` `viewerBroadcaster` block (R10). */
  broadcasterHealth(): ViewerBroadcasterHealth {
    const pending = [...this.remoteTerminals.values()].filter((entry) => entry.pendingReason).length;
    return {
      ...(pending ? { enforcementPending: pending } : {}),
      sweepIntervalMs: this.sweepIntervalMs,
      lastSweepAt: this.lastSweepAtMs === null ? null : new Date(this.lastSweepAtMs).toISOString(),
      sweepTickCount: this.tickCount,
      connectedViewerCount: this.connectedViewerCount(),
    };
  }

  /** Number of sweep ticks completed (observability, R10). */
  get sweepTickCount(): number {
    return this.tickCount;
  }

  /** Wall-clock ms of the last completed sweep tick, or null if none ran yet (R10). */
  get lastSweepAt(): number | null {
    return this.lastSweepAtMs;
  }

  startSweep(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweep(), this.sweepIntervalMs);
    // Do not keep the event loop alive solely for the sweep (matches the other
    // server background timers).
    this.sweepTimer.unref?.();
  }

  stopSweep(): void {
    if (this.remoteLeaseTimer) { clearInterval(this.remoteLeaseTimer); this.remoteLeaseTimer = undefined; }
    if (!this.sweepTimer) return;
    clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
  }

  /**
   * One revocation-sweep tick. Drops any dashboard OR terminal socket whose
   * viewer grant is no longer live; owner sockets are never touched. Each socket
   * (and the liveness lookup) is evaluated under its own try/catch, so one
   * throwing socket or a faulty resolver cannot abort the rest of this tick —
   * and, because the interval callback never sees the throw, it cannot kill
   * future ticks either (acceptance: "sweep tick throwing doesn't kill future
   * sweeps"). Iterates a copy so eviction-time `delete` can't disturb iteration.
   */
  sweep(): void {
    this.tickCount++;
    this.lastSweepAtMs = this.now();
    this.renewRemoteTerminals();
    for (const entry of [...this.sockets.values()]) {
      try {
        if (this.livenessSweepEnabled && this.checkLivenessAndMaybeReap(entry)) continue;
        if (entry.actor.kind !== 'viewer') continue;
        const liveness = this.resolveGrantLiveness(entry.actor.grantId);
        if (liveness !== 'active') {
          this.evict(entry, liveness);
          continue;
        }
        // #810 reassignment TOCTOU (RFC F8): a still-live grant may hold a
        // terminal socket whose task was reassigned out of scope since it
        // opened. Re-check terminal viewer sockets each tick and drop any that
        // are no longer in scope. Dashboard sockets re-derive their scope on the
        // next snapshot, so only terminal sockets need this gate.
        if (entry.kind === 'terminal' && this.isActorAllowedTerminalSession) {
          let inScope: boolean;
          try {
            inScope = this.isActorAllowedTerminalSession(entry.actor, entry.sessionName ?? '');
          } catch (err) {
            // Fail closed: a scope re-check that throws must not leave a possibly
            // out-of-scope terminal open. Distinct from the liveness path above,
            // whose throw is isolated-and-retained (transient liveness blips
            // should not tear down a still-valid socket).
            console.warn('[viewer-registry] terminal scope re-check threw; evicting fail-closed', err);
            inScope = false;
          }
          if (!inScope) this.evict(entry, 'out-of-scope');
        }
      } catch (err) {
        console.warn('[viewer-registry] sweep failed for one socket; continuing', err);
      }
    }
  }

  /**
   * Liveness half of the sweep tick (#1725), run for EVERY registered socket
   * (owner and viewer, dashboard and terminal) — unlike the revocation checks
   * below, which apply to viewers only. Two independent failure modes are
   * reaped:
   *
   * 1. Already non-OPEN (CLOSING/CLOSED) but still registered — the socket's
   *    own `close` handler (which would normally call `unregister`) is queued
   *    behind whatever is saturating the loop. Reaped immediately rather than
   *    waiting for that handler to eventually run.
   * 2. OPEN, has NO pending send backlog, but failed to `pong` a previous
   *    `ping` within one whole sweep tick — the standard `ws` "detect and
   *    close broken connections" idiom. `ws.terminate()` destroys the TCP
   *    socket synchronously (unlike `close()`, which negotiates a close
   *    handshake the peer may never complete), which is what actually clears
   *    a CLOSE-WAIT socket when the remote end already went away.
   *
   * A socket with a nonzero `bufferedAmount` is deliberately exempted from
   * (2): `ws.ping()` is just another write, so it queues BEHIND whatever
   * backlog the socket already has and cannot possibly return before that
   * backlog drains. A slow-but-alive client under exactly the load this fix
   * targets (e.g. mid-drain on a large snapshot) would otherwise be reaped
   * for being slow, not for being dead — the opposite of the intent. A
   * backlogged-and-actually-stuck socket is still bounded by the broadcaster's
   * own `bufferedAmount` hard cap (`viewer-broadcaster.ts`), so this reap does
   * not need to duplicate that path.
   *
   * Returns true if the socket was reaped (caller should `continue`, skipping
   * the now-stale revocation checks for the same entry).
   */
  private checkLivenessAndMaybeReap(entry: RegisteredSocket): boolean {
    const ws = entry.ws;
    if (ws.readyState !== WebSocket.OPEN) {
      this.reapDeadSocket(entry);
      return true;
    }
    // Sockets that don't implement BOTH ping and the pong listener (lightweight
    // test doubles, or a hypothetical future adapter) only get the readyState
    // check above — gating on both together (rather than each independently)
    // avoids a socket that has one but not the other being pinged toward a
    // `livenessAlive === false` state that nothing can ever clear back to true.
    if (typeof ws.ping !== 'function' || typeof ws.on !== 'function') return false;
    if (getBufferedAmount(ws) > 0) {
      // Backlogged: reset rather than penalize — see the bufferedAmount note
      // above. Skips this tick's ping too (no point pinging behind a backlog).
      this.livenessAlive.set(ws, true);
      return false;
    }
    if (this.livenessAlive.get(ws) === false) {
      this.reapDeadSocket(entry);
      return true;
    }
    this.livenessAlive.set(ws, false);
    try {
      ws.ping();
    } catch (err) {
      // A throwing ping means the socket is already unusable — reap now
      // rather than waiting for next tick's readyState/pong check to notice.
      console.warn('[viewer-registry] ping failed; reaping socket', err);
      this.reapDeadSocket(entry);
      return true;
    }
    return false;
  }

  private reapDeadSocket(entry: RegisteredSocket): void {
    this.sockets.delete(entry.ws);
    this.livenessReapCount++;
    this.lastLivenessReapAtMs = this.now();
    // Mirror `evict`'s audit hook (#1725 review finding): a viewer socket
    // silently disappearing from the registry with no trace made a mass reap
    // operationally invisible. `onEvict`'s contract has no `liveness-timeout`
    // grantId-vs-ownership assumption issue here — same call shape as `evict`.
    if (entry.actor.kind === 'viewer' && this.onEvict) {
      try {
        this.onEvict({
          grantId: entry.actor.grantId,
          kind: entry.kind,
          sessionName: entry.sessionName,
          reason: 'liveness-timeout',
        });
      } catch (err) {
        console.warn('[viewer-registry] eviction audit hook threw; continuing', err);
      }
    }
    try {
      entry.ws.terminate();
    } catch (err) {
      console.warn('[viewer-registry] failed to terminate dead socket', err);
    }
  }

  /** Observability snapshot for the dead-socket liveness sweep (#1725). */
  livenessHealth(): LivenessSweepHealth {
    return {
      enabled: this.livenessSweepEnabled,
      reapCount: this.livenessReapCount,
      lastReapAt: this.lastLivenessReapAtMs === null ? null : new Date(this.lastLivenessReapAtMs).toISOString(),
    };
  }

  private evict(entry: RegisteredSocket, reason: EvictionReason): void {
    this.sockets.delete(entry.ws);
    if (entry.actor.kind === 'viewer' && this.onEvict) {
      try {
        this.onEvict({
          grantId: entry.actor.grantId,
          kind: entry.kind,
          sessionName: entry.sessionName,
          reason,
        });
      } catch (err) {
        console.warn('[viewer-registry] eviction audit hook threw; continuing', err);
      }
    }
    try {
      const closeReason = reason === 'out-of-scope' ? OUT_OF_SCOPE_CLOSE_REASON : REVOKED_CLOSE_REASON;
      entry.ws.close(REVOKED_CLOSE_CODE, closeReason);
    } catch (err) {
      console.warn('[viewer-registry] failed to close evicted socket', err);
    }
  }

  /**
   * Close every socket in both pools and clear the map. Shutdown calls
   * `stopSweep()` first so a tick can't race the close (order: stopSweep →
   * closeAll → httpServer.close).
   */
  closeAll(): void {
    for (const entry of [...this.sockets.values()]) {
      try {
        entry.ws.close(SHUTDOWN_CLOSE_CODE, SHUTDOWN_CLOSE_REASON);
      } catch (err) {
        console.warn('[viewer-registry] failed to close socket during shutdown', err);
      }
    }
    this.sockets.clear();
  }
}

/**
 * Read `bufferedAmount` defensively (same pattern as `viewer-broadcaster.ts`,
 * intentionally duplicated rather than imported — this registry module has no
 * other dependency on the broadcaster's backpressure concern, and the two
 * belong to different layers).
 */
function getBufferedAmount(ws: WebSocket): number {
  const bufferedAmount = (ws as WebSocket & { bufferedAmount?: number }).bufferedAmount;
  return typeof bufferedAmount === 'number' && Number.isFinite(bufferedAmount)
    ? Math.max(0, bufferedAmount)
    : 0;
}
