// --- Viewer-aware broadcaster (RFC: rfc-shared-view-readonly.md) ---
//
// Pure transport over the connection registry's dashboard-socket snapshot. It
// does NOT import snapshot dependencies; it is constructed with an injected
// `buildScopedSnapshot(scope) => SnapshotMessage` factory, preserving the
// dependency direction (transport → injected domain fn, not transport → every
// store). This keeps `buildScopedSnapshot` the single owner of WS scope
// filtering across the tick path and the initial burst (round-3 wiring note).
//
// The already-enriched `all` snapshot the caller built is serialized once and
// fanned out to owners and any `all`-scoped viewer — no behavior change for the
// ~15-20 existing `broadcastToAll` call sites. Each distinct `projects` scope
// among connected viewers gets `buildScopedSnapshot(scope)` (now wired by #809),
// memoized per canonical scope key. Live viewer admission still depends on the
// `resolveViewer` seam, deferred until the #810 terminal scope check lands.

import { WebSocket } from 'ws';

import type { Actor } from './auth.js';
import { canonicalizeScope, type Scope } from './viewer-data-policy.js';
import type { ServerMessage, SnapshotMessage } from '../shared/contracts/messages.js';

/** The slice of the registry the broadcaster depends on. */
export interface BroadcasterRegistry {
  snapshotDashboardConnections(): { ws: WebSocket; actor: Actor }[];
  unregister(ws: WebSocket): void;
}

export interface ViewerAwareBroadcasterDeps {
  registry: BroadcasterRegistry;
  /**
   * Build the snapshot a viewer holding `scope` should receive. Wired at
   * bootstrap (#809). Only ever invoked for a non-`all` scope — the `all` group
   * reuses the caller's already-enriched snapshot — so this is the single owner
   * of `projects`-scope filtering. An unwired stub fails closed (a viewer gets an
   * error, never the unfiltered `all` snapshot).
   */
  buildScopedSnapshot: (scope: Scope) => SnapshotMessage;
}

/** The scope a connection's actor sees: owners see `all`; viewers see their grant scope. */
function actorScope(actor: Actor): Scope {
  return actor.kind === 'owner' ? { kind: 'all' } : canonicalizeScope(actor.scope);
}

/** Stable key for memoizing one serialized snapshot per distinct canonical scope. */
function scopeKey(scope: Scope): string {
  return scope.kind === 'all' ? 'all' : `projects:${scope.projectIds.join(',')}`;
}

/** A snapshot serialized for one scope, plus its optional secondary coordinator frame. */
interface SerializedSnapshot {
  data: string;
  coordinatorData: string | null;
}

function serializeSnapshot(msg: SnapshotMessage): SerializedSnapshot {
  return {
    data: JSON.stringify(msg),
    coordinatorData: msg.coordinator
      ? JSON.stringify({ type: 'coordinator.snapshot', coordinator: msg.coordinator } satisfies ServerMessage)
      : null,
  };
}

export class ViewerAwareBroadcaster {
  private readonly registry: BroadcasterRegistry;
  private readonly buildScopedSnapshot: (scope: Scope) => SnapshotMessage;

  constructor(deps: ViewerAwareBroadcasterDeps) {
    this.registry = deps.registry;
    this.buildScopedSnapshot = deps.buildScopedSnapshot;
  }

  /**
   * Fan a server message out to every open dashboard connection. The caller has
   * already applied any enrichment (achievements, coordinator, agent types) — we
   * are pure transport.
   *
   * - Non-snapshot messages are not scope-filtered in Phase 1; they serialize
   *   once and go to every dashboard socket. (#809 may scope `projectSummaries`
   *   and friends later.)
   * - Snapshot messages: the `all` group (owners + any future `all`-viewers)
   *   receives the caller's enriched message serialized once; each distinct
   *   viewer project-scope receives a snapshot from the injected factory,
   *   memoized per canonical scope key.
   */
  broadcast(msg: ServerMessage): void {
    const connections = this.registry.snapshotDashboardConnections();

    if (msg.type !== 'snapshot') {
      const data = JSON.stringify(msg);
      for (const { ws } of connections) {
        this.send(ws, data, msg.type);
      }
      return;
    }

    const allSnapshot = serializeSnapshot(msg);
    const scopedCache = new Map<string, SerializedSnapshot>();

    for (const { ws, actor } of connections) {
      // Each connection is isolated: a throwing `buildScopedSnapshot` (the
      // Phase-1 stub fails closed by throwing) must not blackhole the broadcast
      // to the remaining connections — mirrors the sweep's per-socket isolation.
      try {
        const scope = actorScope(actor);
        let serialized: SerializedSnapshot;
        if (scope.kind === 'all') {
          serialized = allSnapshot;
        } else {
          const key = scopeKey(scope);
          let cached = scopedCache.get(key);
          if (!cached) {
            cached = serializeSnapshot(this.buildScopedSnapshot(scope));
            scopedCache.set(key, cached);
          }
          serialized = cached;
        }
        const sentPrimary = this.send(ws, serialized.data, 'snapshot');
        if (sentPrimary && serialized.coordinatorData) {
          this.send(ws, serialized.coordinatorData, 'coordinator.snapshot');
        }
      } catch (err) {
        console.warn('[viewer-broadcaster] failed to build/send snapshot for one connection; continuing', err);
      }
    }
  }

  /**
   * Send one serialized frame to one socket. On failure the socket is dropped
   * from the registry and closed — matching the legacy `sendToClient` semantics
   * the broadcaster replaces. Returns whether the primary send succeeded.
   */
  private send(ws: WebSocket, data: string, payloadType: ServerMessage['type']): boolean {
    if (ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(data);
      return true;
    } catch (err) {
      this.registry.unregister(ws);
      console.warn(`[websocket] Failed to broadcast ${payloadType}; dropping client`, err);
      try {
        ws.close();
      } catch (closeErr) {
        console.warn('[websocket] Failed to close client after broadcast failure', closeErr);
      }
      return false;
    }
  }
}
