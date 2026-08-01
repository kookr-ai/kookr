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
import type { AgentState } from '../core/monitor.js';
import type { ServerMessage, SnapshotMessage } from '../shared/contracts/messages.js';
import {
  normalizeSnapshotPayloadSizePolicy,
  shouldSendSerializedSnapshotFrame,
  snapshotScopeKey,
  type SnapshotPayloadSizePolicy,
} from './snapshot-payload-size-policy.js';

/**
 * Soft `ws.bufferedAmount` ceiling for dashboard fan-out (#1424).
 * Above this, skip the frame for that socket only — snapshots are full-state
 * and self-healing, so a dropped coalesced frame costs nothing once the next
 * lands. Aligned with session-bridge soft default; unvalidated for heap size.
 */
const DEFAULT_BACKPRESSURE_SOFT_BYTES = 1 * 1024 * 1024;

/**
 * Hard `ws.bufferedAmount` ceiling for dashboard fan-out (#1424).
 * Above this, unregister + close(1013) so a stalled OPEN socket cannot grow the
 * send queue without bound. Matches session-bridge viewer hard default.
 */
const DEFAULT_BACKPRESSURE_HARD_BYTES = 16 * 1024 * 1024;

/**
 * Default consecutive broadcasts a socket may sit above the soft threshold
 * before it is disconnected outright (#1725). A socket that is merely slow
 * drains and resumes within a broadcast or two — one that stays over soft on
 * every single tick is not draining at all, and would otherwise sit forever
 * silently missing every snapshot without ever tripping the hard cap.
 * Exported so `websocket-backpressure-config.ts`'s env reader shares this
 * exact default rather than redeclaring it.
 */
export const DEFAULT_BACKPRESSURE_DISCONNECT_AFTER_SKIPS = 5;

/** The slice of the registry the broadcaster depends on. */
export interface BroadcasterRegistry {
  snapshotDashboardConnections(): { ws: WebSocket; actor: Actor }[];
  unregister(ws: WebSocket): void;
}

/**
 * The narrow slice of {@link ../websocket-load-shed.WebSocketLoadShedGate} the
 * broadcaster depends on (#1725) — decoupled to an interface so this module
 * never imports the gate's env-parsing concerns, matching the
 * {@link BroadcasterRegistry} seam above.
 */
export interface LoadShedSignal {
  readonly isActive: boolean;
  /** Last sampled event-loop delay p95 (ms), surfaced on the degraded frame for observability. */
  readonly lastEventLoopDelayP95Ms: number | null;
  recordSkippedSnapshot(): void;
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
  buildScopedSnapshot: (scope: Scope, baseClientAgents?: AgentState[]) => SnapshotMessage;
  /**
   * Compute the full-fleet client-projected snapshot agents once per flush so
   * every distinct viewer scope reuses them instead of each re-running the fleet
   * projection (`Monitor.getSnapshot()` + `buildSnapshotProjection()`) (#1398). When wired,
   * `broadcast` computes this at most once per snapshot flush (only if a scoped
   * viewer is connected) and threads the result into `buildScopedSnapshot`. When
   * omitted, each scope rebuilds its own base — the pre-#1398 behavior.
   */
  computeSnapshotBaseAgents?: () => AgentState[];
  snapshotPayloadSizePolicy?: SnapshotPayloadSizePolicy;
  /**
   * Soft `ws.bufferedAmount` threshold (#1424). Frames are skipped (not
   * requeued) for that socket only. Defaults to 1 MiB; override in tests.
   */
  backpressureSoftBytes?: number;
  /**
   * Hard `ws.bufferedAmount` threshold (#1424). Socket is unregistered and
   * closed with 1013. Defaults to 16 MiB; override in tests.
   */
  backpressureHardBytes?: number;
  /**
   * Consecutive SNAPSHOT broadcasts a socket may sit above the soft
   * backpressure threshold before it is disconnected outright (#1725).
   * Defaults to 5. `0` disables this specific mechanism (soft-skip-only,
   * pre-#1725 semantics) — an operator's mid-incident kill switch, distinct
   * from the (unaffected) hard-cap disconnect above.
   */
  backpressureDisconnectAfterSkips?: number;
  /**
   * Event-loop-delay load-shed gate (#1725). When {@link LoadShedSignal.isActive}
   * is true, `broadcast` skips the expensive per-scope snapshot
   * serialize-and-fan-out entirely and sends a tiny `wsBackpressureNotice`
   * frame instead — the server's own saturation must degrade its most
   * expensive output rather than keep making itself worse. Omitted entirely
   * (the default) means load-shedding never engages, matching the pre-#1725
   * behavior.
   */
  loadShedGate?: LoadShedSignal;
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
  private readonly buildScopedSnapshot: (scope: Scope, baseClientAgents?: AgentState[]) => SnapshotMessage;
  private readonly computeSnapshotBaseAgents: (() => AgentState[]) | undefined;
  private readonly snapshotPayloadSizePolicy: SnapshotPayloadSizePolicy | undefined;
  private readonly backpressureSoftBytes: number;
  private readonly backpressureHardBytes: number;
  private readonly backpressureDisconnectAfterSkips: number;
  private readonly loadShedGate: LoadShedSignal | undefined;
  /**
   * Per-socket consecutive-soft-skip counter (#1725), keyed by the live
   * WebSocket instance. A WeakMap — never needs explicit pruning as sockets
   * churn, so this cannot itself become a retained-object leak.
   */
  private readonly staleClients = new WeakMap<WebSocket, { consecutiveSkips: number }>();
  /**
   * Per-socket delta-protocol resync latch (issue #1754, Stage 1). A socket is
   * added whenever a frame is soft-skipped for it (it may now trail the stream)
   * and removed once a full `snapshot` frame is successfully delivered (it is
   * re-based). {@link connectionNeedsSnapshot} exposes it so the future delta
   * emitter (Stage 2) can enforce the invariant *a backpressure-skipped client
   * must receive a fresh snapshot before any further delta* — sending a snapshot
   * instead of a delta while the latch is set. A WeakSet, so it needs no pruning
   * as sockets churn and can never itself become a retained-object leak.
   */
  private readonly needsSnapshotClients = new WeakSet<WebSocket>();
  /** Tracks whether the PREVIOUS broadcast was shed, so recovery can be announced exactly once. */
  private wasLoadShedActive = false;

  constructor(deps: ViewerAwareBroadcasterDeps) {
    this.registry = deps.registry;
    this.buildScopedSnapshot = deps.buildScopedSnapshot;
    this.computeSnapshotBaseAgents = deps.computeSnapshotBaseAgents;
    this.snapshotPayloadSizePolicy = normalizeSnapshotPayloadSizePolicy(deps.snapshotPayloadSizePolicy);
    const soft = Math.max(1, Math.floor(deps.backpressureSoftBytes ?? DEFAULT_BACKPRESSURE_SOFT_BYTES));
    const hard = Math.max(soft, Math.floor(deps.backpressureHardBytes ?? DEFAULT_BACKPRESSURE_HARD_BYTES));
    this.backpressureSoftBytes = soft;
    this.backpressureHardBytes = hard;
    // `0` disables the sustained-skip disconnect entirely (soft-skip-only,
    // pre-#1725 semantics) — an operator's mid-incident kill switch for this
    // specific mechanism, distinct from the hard-cap disconnect above, which
    // is unaffected. Any other non-negative value floors to at least 1.
    const rawDisconnectAfterSkips = Math.floor(
      deps.backpressureDisconnectAfterSkips ?? DEFAULT_BACKPRESSURE_DISCONNECT_AFTER_SKIPS,
    );
    this.backpressureDisconnectAfterSkips = rawDisconnectAfterSkips <= 0 ? 0 : Math.max(1, rawDisconnectAfterSkips);
    this.loadShedGate = deps.loadShedGate;
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
        this.send(ws, data, msg.type, 'all');
      }
      return;
    }

    // Load-shed (#1725): when the event-loop-delay gate has been engaged for
    // `sustainTicks` consecutive resource-status samples, the snapshot
    // serialize-and-fan-out below — the actual saturating work in the
    // 2026-07-31 incident (2.2 MB × 300+ sockets) — is skipped entirely in
    // favor of one tiny frame per connection. The server degrades its most
    // expensive output instead of compounding its own overload.
    if (this.loadShedGate?.isActive) {
      this.loadShedGate.recordSkippedSnapshot();
      this.broadcastBackpressureNotice(connections, 'loadShedActive');
      this.wasLoadShedActive = true;
      return;
    }
    if (this.wasLoadShedActive) {
      this.wasLoadShedActive = false;
      this.broadcastBackpressureNotice(connections, 'loadShedRecovered');
      // Fall through: this tick's full snapshot resumes normally below.
    }

    const allSnapshot = serializeSnapshot(msg, 'all', this.snapshotPayloadSizePolicy);
    const scopedCache = new Map<string, SerializedSnapshot>();
    // Full-fleet projection base, computed at most once per flush and only when a
    // scoped viewer is actually present, then reused across every distinct scope
    // (#1398). Lazy so an all-only fan-out never pays for it; memoized across the
    // (possibly throwing) per-connection builds below.
    let baseClientAgents: AgentState[] | undefined;
    let baseComputed = false;

    for (const { ws, actor } of connections) {
      // Each connection is isolated: a throwing `buildScopedSnapshot` (the
      // Phase-1 stub fails closed by throwing) must not blackhole the broadcast
      // to the remaining connections — mirrors the sweep's per-socket isolation.
      try {
        const scope = actorScope(actor);
        let serialized: SerializedSnapshot;
        let scopeKey: string;
        if (scope.kind === 'all') {
          serialized = allSnapshot;
          scopeKey = 'all';
        } else {
          scopeKey = snapshotScopeKey(scope);
          let cached = scopedCache.get(scopeKey);
          if (!cached) {
            if (!baseComputed) {
              // Compute the shared fleet base once, on first scoped viewer only.
              baseClientAgents = this.computeSnapshotBaseAgents?.();
              baseComputed = true;
            }
            // Omit the base arg entirely when none was computed so the factory's
            // call signature is unchanged for the pre-#1398 (unwired) path.
            let scopedMsg = baseClientAgents !== undefined
              ? this.buildScopedSnapshot(scope, baseClientAgents)
              : this.buildScopedSnapshot(scope);
            // #1754 Stage 1: propagate this flush's `(epoch, seq)` onto every
            // per-scope snapshot so scoped viewers re-base on the same stream
            // position as the `all` group. Only when the caller stamped the
            // incoming snapshot (production wires the sequencer; test wirings
            // that don't get byte-identical pre-#1754 scoped frames).
            if (msg.seq !== undefined) {
              scopedMsg = { ...scopedMsg, epoch: msg.epoch, seq: msg.seq };
            }
            cached = serializeSnapshot(scopedMsg, scopeKey, this.snapshotPayloadSizePolicy);
            scopedCache.set(scopeKey, cached);
          }
          serialized = cached;
        }
        if (!serialized.data) continue;
        const sentPrimary = this.send(ws, serialized.data, 'snapshot', scopeKey);
        if (sentPrimary && serialized.coordinatorData) {
          this.send(ws, serialized.coordinatorData, 'coordinator.snapshot', scopeKey);
        }
      } catch (err) {
        console.warn('[viewer-broadcaster] failed to build/send snapshot for one connection; continuing', err);
      }
    }
  }

  /**
   * Whether `ws` has been soft-skipped since it last received a full snapshot,
   * and so must be re-based with a snapshot before it may safely apply any
   * delta (issue #1754, Stage 1 resync escape hatch). Stage 2's delta emitter
   * consults this to serve a snapshot instead of a delta while the latch is set;
   * in Stage 1 the wire is snapshot-only, so the latch clears on the very next
   * flush and this predicate exists as tested forward-compatible plumbing.
   */
  connectionNeedsSnapshot(ws: WebSocket): boolean {
    return this.needsSnapshotClients.has(ws);
  }

  /**
   * Send a tiny `wsBackpressureNotice` frame to every open connection in place
   * of a full snapshot (#1725, load-shed mode). Serialized once — same
   * discipline as the real snapshot fan-out — and routed through {@link send}
   * so readyState/backpressure handling stays uniform, even though a frame
   * this small is very unlikely to itself trip backpressure.
   */
  private broadcastBackpressureNotice(
    connections: { ws: WebSocket; actor: Actor }[],
    kind: 'loadShedActive' | 'loadShedRecovered',
  ): void {
    const data = JSON.stringify({
      type: 'wsBackpressureNotice',
      kind,
      eventLoopDelayP95Ms: this.loadShedGate?.lastEventLoopDelayP95Ms ?? null,
    } satisfies ServerMessage);
    for (const { ws } of connections) {
      this.send(ws, data, 'wsBackpressureNotice', 'all');
    }
  }

  /**
   * Send one serialized frame to one socket. On failure the socket is dropped
   * from the registry and closed — matching the legacy `sendToClient` semantics
   * the broadcaster replaces. Returns whether the primary send succeeded.
   *
   * Backpressure (#1424, extended #1725): `bufferedAmount` above the soft
   * threshold skips this frame for that socket only (drop, never requeue —
   * snapshots are full-state). For `snapshot` frames specifically, a socket
   * that stays above soft for {@link backpressureDisconnectAfterSkips}
   * CONSECUTIVE snapshot broadcasts is disconnected outright — sustained
   * saturation, not a momentary stall, so waiting for the (much higher) hard
   * cap would let it silently miss every snapshot indefinitely. Scoped to
   * `snapshot` only (not the sibling `coordinator.snapshot` frame nor
   * ordinary deltas that also funnel through this method) so the counter
   * measures actual snapshot-flush cadence rather than double-counting a
   * primary+coordinator pair or tripping on unrelated delta traffic. Above
   * the hard threshold the socket is unregistered and closed with 1013
   * immediately, same as before. A stale socket that drains back under soft
   * gets a compact `wsBackpressureNotice(resyncNeeded)` frame instead of
   * silently resuming — it may have missed several coalesced snapshots while
   * skipped.
   */
  private send(
    ws: WebSocket,
    data: string,
    payloadType: ServerMessage['type'],
    scopeKey = 'all',
  ): boolean {
    if (ws.readyState !== WebSocket.OPEN) return false;

    const bufferedAmount = getBufferedAmount(ws);
    if (bufferedAmount > this.backpressureHardBytes) {
      this.observeBackpressureDrop(payloadType, scopeKey, bufferedAmount);
      this.staleClients.delete(ws);
      this.needsSnapshotClients.delete(ws);
      this.registry.unregister(ws);
      console.warn(
        `[websocket] dashboard client bufferedAmount exceeded hard backpressure; closing`,
        {
          payloadType,
          bufferedAmount,
          hardBytes: this.backpressureHardBytes,
          softBytes: this.backpressureSoftBytes,
        },
      );
      try {
        ws.close(1013, 'dashboard snapshot backpressure');
      } catch (closeErr) {
        console.warn('[websocket] Failed to close client after backpressure', closeErr);
      }
      return false;
    }
    if (bufferedAmount > this.backpressureSoftBytes) {
      // Soft: skip this frame only. Do not requeue — next coalesced snapshot heals.
      this.observeBackpressureDrop(payloadType, scopeKey, bufferedAmount);
      // #1754 Stage 1: this socket just missed a frame, so it may trail the
      // stream. Latch it as needing a snapshot re-base (for ANY payload type —
      // a soft-skipped delta in Stage 2 must also force a snapshot). The latch
      // clears only when a full snapshot is next delivered below.
      this.needsSnapshotClients.add(ws);
      // The consecutive-skip counter is deliberately scoped to `snapshot`
      // frames ONLY (#1725 review finding: counting every frame type — the
      // sibling `coordinator.snapshot` frame, plus ordinary `update`/`alert`/
      // `projectSummaries` deltas that also funnel through this same `send` —
      // meant a client could hit `backpressureDisconnectAfterSkips` within
      // milliseconds of unrelated delta traffic, or be double-counted once
      // per broadcast via the primary+coordinator pair. "N CONSECUTIVE
      // broadcasts" (the documented contract) means N snapshot flushes, the
      // actual periodic/coalesced cadence disconnect-after-N is meant to
      // measure — not N arbitrary sends.
      if (payloadType === 'snapshot' && this.backpressureDisconnectAfterSkips > 0) {
        const state = this.staleClients.get(ws) ?? { consecutiveSkips: 0 };
        state.consecutiveSkips += 1;
        this.staleClients.set(ws, state);
        if (state.consecutiveSkips >= this.backpressureDisconnectAfterSkips) {
          console.warn(
            '[websocket] dashboard client sustained soft backpressure across consecutive snapshot broadcasts; disconnecting',
            {
              payloadType,
              bufferedAmount,
              consecutiveSkips: state.consecutiveSkips,
              disconnectAfterSkips: this.backpressureDisconnectAfterSkips,
              softBytes: this.backpressureSoftBytes,
            },
          );
          this.staleClients.delete(ws);
          this.registry.unregister(ws);
          try {
            ws.close(1013, 'sustained dashboard snapshot backpressure');
          } catch (closeErr) {
            console.warn('[websocket] Failed to close client after sustained backpressure', closeErr);
          }
        }
      }
      return false;
    }

    // Healthy (at or below soft). A socket that had skipped at least once
    // gets a resync nudge before resuming normal cadence — it may have missed
    // coalesced snapshots while it was stale.
    if (this.staleClients.get(ws)) {
      this.staleClients.delete(ws);
      this.sendResyncNotice(ws, scopeKey);
    }

    try {
      ws.send(data);
      // #1754 Stage 1: a full snapshot re-bases the client to the current
      // stream position, so it supersedes every frame the socket may have
      // skipped — clear the resync latch. Non-snapshot frames do not re-base,
      // so they leave the latch untouched.
      if (payloadType === 'snapshot') this.needsSnapshotClients.delete(ws);
      return true;
    } catch (err) {
      this.staleClients.delete(ws);
      this.needsSnapshotClients.delete(ws);
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

  /** Best-effort compact notice that a just-drained socket may have missed frames while stale (#1725). */
  private sendResyncNotice(ws: WebSocket, scopeKey: string): void {
    try {
      ws.send(JSON.stringify({
        type: 'wsBackpressureNotice',
        kind: 'resyncNeeded',
        scopeKey,
      } satisfies ServerMessage));
    } catch (err) {
      console.warn('[websocket] failed to send resync-needed notice after backpressure drain', err);
    }
  }

  /**
   * Report a backpressure drop through the same observation shape as the
   * payload-size policy so existing observers see both cap and queue drops.
   * Non-snapshot payload types have no observation contract — log-only.
   */
  private observeBackpressureDrop(
    payloadType: ServerMessage['type'],
    scopeKey: string,
    bufferedAmount: number,
  ): void {
    if (payloadType !== 'snapshot' && payloadType !== 'coordinator.snapshot') return;
    this.snapshotPayloadSizePolicy?.observe?.({
      payloadType,
      scopeKey,
      bytes: bufferedAmount,
      warnBytes: this.backpressureSoftBytes,
      maxBytes: this.backpressureHardBytes,
      action: 'dropped',
    });
  }
}

function getBufferedAmount(ws: WebSocket): number {
  const bufferedAmount = (ws as WebSocket & { bufferedAmount?: number }).bufferedAmount;
  return typeof bufferedAmount === 'number' && Number.isFinite(bufferedAmount)
    ? Math.max(0, bufferedAmount)
    : 0;
}
