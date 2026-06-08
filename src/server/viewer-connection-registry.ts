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

/** Which connection pool a socket belongs to. */
export type SocketKind = 'dashboard' | 'terminal';

/** Extra registration metadata. Terminal sockets carry their session name. */
export interface SocketMeta {
  /** The attached terminal session (terminal sockets only). */
  sessionName?: string;
}

/** An entry in the registry. */
export interface RegisteredSocket {
  ws: WebSocket;
  actor: Actor;
  kind: SocketKind;
  /** Present for terminal sockets so the sweep can re-check session scope (#810). */
  sessionName?: string;
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

/** Why the sweep evicted a socket. Surfaced to the audit hook (#808 / R10). */
export type EvictionReason = Exclude<GrantLiveness, 'active'>;

/** Payload handed to {@link ViewerConnectionRegistryOptions.onEvict}. */
export interface SweepEviction {
  grantId: string;
  kind: SocketKind;
  sessionName?: string;
  reason: EvictionReason;
}

export interface ViewerConnectionRegistryOptions {
  /**
   * Resolve a viewer grant's current liveness. Injected from the grant store
   * (#803) when viewers are wired (#806/#808). Phase 1 has no viewers — viewer
   * cookies are not yet admitted onto `/ws` — so the default treats every grant
   * as active and the sweep evicts nothing.
   */
  resolveGrantLiveness?: (grantId: string) => GrantLiveness;
  /** Revocation-sweep interval in milliseconds. Default 10 000. */
  sweepIntervalMs?: number;
  /** Audit hook fired once per evicted socket (#808 / R10). Never throws into the sweep. */
  onEvict?: (eviction: SweepEviction) => void;
  /** Injected clock for `lastSweepAt` (testability). Defaults to `Date.now`. */
  now?: () => number;
  /** Start the sweep timer on construction. Default true; tests pass false and call {@link sweep} directly. */
  autoStartSweep?: boolean;
}

const DEFAULT_SWEEP_INTERVAL_MS = 10_000;
/** Close code for a socket dropped because its grant was revoked/expired (policy violation). */
const REVOKED_CLOSE_CODE = 1008;
const REVOKED_CLOSE_REASON = 'Access revoked';
/** Close code for a socket dropped during server shutdown (going away). */
const SHUTDOWN_CLOSE_CODE = 1001;
const SHUTDOWN_CLOSE_REASON = 'Server shutting down';

export class ViewerConnectionRegistry implements SocketRegistrar {
  private readonly sockets = new Map<WebSocket, RegisteredSocket>();
  private readonly resolveGrantLiveness: (grantId: string) => GrantLiveness;
  private readonly onEvict?: (eviction: SweepEviction) => void;
  private readonly now: () => number;
  private readonly sweepIntervalMs: number;
  private sweepTimer: ReturnType<typeof setInterval> | undefined;
  private tickCount = 0;
  private lastSweepAtMs: number | null = null;

  constructor(options: ViewerConnectionRegistryOptions = {}) {
    this.resolveGrantLiveness = options.resolveGrantLiveness ?? (() => 'active');
    this.onEvict = options.onEvict;
    this.now = options.now ?? (() => Date.now());
    this.sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    if (options.autoStartSweep !== false) this.startSweep();
  }

  register(ws: WebSocket, actor: Actor, kind: SocketKind, meta?: SocketMeta): void {
    this.sockets.set(ws, { ws, actor, kind, sessionName: meta?.sessionName });
  }

  unregister(ws: WebSocket): void {
    this.sockets.delete(ws);
  }

  /**
   * All sockets (either pool) held by a given grant. The owner revoke route
   * (#808) uses this to drop a viewer's connections immediately, without
   * waiting for the next sweep tick.
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
    return this.sockets.size;
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
    for (const entry of [...this.sockets.values()]) {
      try {
        if (entry.actor.kind !== 'viewer') continue;
        const liveness = this.resolveGrantLiveness(entry.actor.grantId);
        if (liveness === 'active') continue;
        this.evict(entry, liveness);
      } catch (err) {
        console.warn('[viewer-registry] sweep failed for one socket; continuing', err);
      }
    }
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
      entry.ws.close(REVOKED_CLOSE_CODE, REVOKED_CLOSE_REASON);
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
