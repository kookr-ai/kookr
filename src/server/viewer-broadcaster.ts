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
import {
  normalizeSnapshotPayloadSizePolicy,
  shouldSendSerializedSnapshotFrame,
  snapshotScopeKey,
  type SnapshotPayloadSizePolicy,
} from './snapshot-payload-size-policy.js';

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
  snapshotPayloadSizePolicy?: SnapshotPayloadSizePolicy;
}

/** The scope a connection's actor sees: owners see `all`; viewers see their grant scope. */
function actorScope(actor: Actor): Scope {
  return actor.kind === 'owner' ? { kind: 'all' } : canonicalizeScope(actor.scope);
}

/**
 * A snapshot serialized for one scope, plus its optional secondary coordinator
 * frame. `data` is null only when the primary snapshot exceeded the payload cap.
 */
interface SerializedSnapshot {
  data: string | null;
  coordinatorData: string | null;
}

function serializeSnapshot(
  msg: SnapshotMessage,
  scopeKey: string,
  policy: SnapshotPayloadSizePolicy | undefined,
): SerializedSnapshot {
  const data = JSON.stringify(msg);
  const coordinatorData = msg.coordinator
    ? JSON.stringify({ type: 'coordinator.snapshot', coordinator: msg.coordinator } satisfies ServerMessage)
    : null;
  const sendData = shouldSendSerializedSnapshotFrame(data, 'snapshot', scopeKey, policy);
  return {
    data: sendData ? data : null,
    coordinatorData: sendData && coordinatorData && shouldSendSerializedSnapshotFrame(
      coordinatorData,
      'coordinator.snapshot',
      scopeKey,
      policy,
    )
      ? coordinatorData
      : null,
  };
}

export class ViewerAwareBroadcaster {
  private readonly registry: BroadcasterRegistry;
  private readonly buildScopedSnapshot: (scope: Scope) => SnapshotMessage;
  private readonly snapshotPayloadSizePolicy: SnapshotPayloadSizePolicy | undefined;

  constructor(deps: ViewerAwareBroadcasterDeps) {
    this.registry = deps.registry;
    this.buildScopedSnapshot = deps.buildScopedSnapshot;
    this.snapshotPayloadSizePolicy = normalizeSnapshotPayloadSizePolicy(deps.snapshotPayloadSizePolicy);
  }

  /**
   * Fan a server message out to every open dashboard connection. The caller has
   * already applied any enrichment (achievements, coordinator, agent types) — we
   * are pure transport.
   *
   * - Non-snapshot messages (`update`, `projectSummaries`, `githubUpdate`,
   *   `quotaStatus`, alerts, …) are whole-world per-delta frames with no scope
   *   filtering, so they are sent to **owners and `all`-scoped viewers only** and
   *   **default-denied to `projects` viewers** (#809). The RFC has no per-project
   *   deltas: a `projects` viewer's live mirror is carried entirely by the
   *   scope-filtered snapshot frames below, so withholding the raw deltas is
   *   correct rather than lossy. (A future scoped delta channel can opt specific
   *   types back in for `projects` viewers when the live-viewer UX lands.)
   * - Snapshot messages: the `all` group (owners + any `all`-viewers) receives
   *   the caller's enriched message serialized once; each distinct viewer
   *   project-scope receives a snapshot from the injected factory, memoized per
   *   canonical scope key.
   */
  broadcast(msg: ServerMessage): void {
    const connections = this.registry.snapshotDashboardConnections();

    if (msg.type !== 'snapshot') {
      const data = JSON.stringify(msg);
      for (const { ws, actor } of connections) {
        // Default-deny: a `projects` viewer never receives an unscoped delta
        // frame. Owners and `all`-scoped viewers see the world, so they pass.
        if (actor.kind === 'viewer' && actorScope(actor).kind !== 'all') continue;
        this.send(ws, data, msg.type);
      }
      return;
    }

    const allSnapshot = serializeSnapshot(msg, 'all', this.snapshotPayloadSizePolicy);
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
          const key = snapshotScopeKey(scope);
          let cached = scopedCache.get(key);
          if (!cached) {
            cached = serializeSnapshot(this.buildScopedSnapshot(scope), key, this.snapshotPayloadSizePolicy);
            scopedCache.set(key, cached);
          }
          serialized = cached;
        }
        if (!serialized.data) continue;
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
