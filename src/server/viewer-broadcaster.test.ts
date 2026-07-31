import { afterEach, describe, expect, test, vi } from 'vitest';
import { WebSocket } from 'ws';

import type { Actor } from './auth.js';
import type { AgentState } from '../core/monitor.js';
import type { Scope } from './viewer-data-policy.js';
import type { ServerMessage, SnapshotMessage } from '../shared/contracts/messages.js';
import { ViewerAwareBroadcaster, type BroadcasterRegistry } from './viewer-broadcaster.js';
import type { SnapshotPayloadSizeObservation } from './snapshot-payload-size-policy.js';

function fakeSocket(
  send: (data: string) => void,
  bufferedAmount = 0,
): WebSocket & { close: ReturnType<typeof vi.fn>; bufferedAmount: number } {
  return {
    readyState: WebSocket.OPEN,
    send,
    close: vi.fn(),
    bufferedAmount,
  } as unknown as WebSocket & { close: ReturnType<typeof vi.fn>; bufferedAmount: number };
}

/** A registry stub that hands out a fixed connection list and records unregisters. */
function stubRegistry(connections: { ws: WebSocket; actor: Actor }[]): BroadcasterRegistry & {
  unregistered: WebSocket[];
} {
  const unregistered: WebSocket[] = [];
  return {
    unregistered,
    snapshotDashboardConnections: () => [...connections],
    unregister: (ws) => {
      unregistered.push(ws);
    },
  };
}

const OWNER: Actor = { kind: 'owner' };
function projectsViewer(grantId: string, projectIds: string[]): Actor {
  return { kind: 'viewer', grantId, scope: { kind: 'projects', projectIds } };
}
function allViewer(grantId: string): Actor {
  return { kind: 'viewer', grantId, scope: { kind: 'all' } };
}

function snapshot(overrides: Partial<SnapshotMessage> = {}): SnapshotMessage {
  return { type: 'snapshot', agents: [], serverCwd: '/repo', ...overrides };
}

describe('ViewerAwareBroadcaster', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('non-snapshot messages serialize once and fan out to every dashboard socket', () => {
    const a: string[] = [];
    const b: string[] = [];
    const registry = stubRegistry([
      { ws: fakeSocket((d) => a.push(d)), actor: OWNER },
      { ws: fakeSocket((d) => b.push(d)), actor: OWNER },
    ]);
    const broadcaster = new ViewerAwareBroadcaster({
      registry,
      buildScopedSnapshot: () => snapshot(),
    });

    broadcaster.broadcast({ type: 'projectSummaries', projects: [] });

    expect(a.map((d) => (JSON.parse(d) as ServerMessage).type)).toEqual(['projectSummaries']);
    expect(b.map((d) => (JSON.parse(d) as ServerMessage).type)).toEqual(['projectSummaries']);
  });

  test('non-snapshot delta frames are default-denied to a projects viewer but reach owners and all-viewers', () => {
    const owner: string[] = [];
    const all: string[] = [];
    const scoped: string[] = [];
    const registry = stubRegistry([
      { ws: fakeSocket((d) => owner.push(d)), actor: OWNER },
      { ws: fakeSocket((d) => all.push(d)), actor: allViewer('gAll') },
      { ws: fakeSocket((d) => scoped.push(d)), actor: projectsViewer('gP', ['p1']) },
    ]);
    const broadcaster = new ViewerAwareBroadcaster({ registry, buildScopedSnapshot: () => snapshot() });

    // An unscoped whole-world delta (the full project list) must not reach a
    // `projects` viewer — its live mirror is carried by scoped snapshots only.
    broadcaster.broadcast({ type: 'projectSummaries', projects: [] });

    expect(owner.map((d) => (JSON.parse(d) as ServerMessage).type)).toEqual(['projectSummaries']);
    expect(all.map((d) => (JSON.parse(d) as ServerMessage).type)).toEqual(['projectSummaries']);
    expect(scoped).toEqual([]);
  });

  test('snapshot to an owner sends the enriched message plus a coordinator frame', () => {
    const sent: string[] = [];
    const registry = stubRegistry([{ ws: fakeSocket((d) => sent.push(d)), actor: OWNER }]);
    const buildScopedSnapshot = vi.fn<(scope: Scope) => SnapshotMessage>(() => snapshot());
    const broadcaster = new ViewerAwareBroadcaster({ registry, buildScopedSnapshot });

    broadcaster.broadcast(snapshot({ coordinator: { outputs: [] } as never }));

    expect(sent.map((d) => (JSON.parse(d) as ServerMessage).type)).toEqual([
      'snapshot',
      'coordinator.snapshot',
    ]);
    // Owners use the caller-provided `all` snapshot — the scoped factory is never touched.
    expect(buildScopedSnapshot).not.toHaveBeenCalled();
  });

  test('snapshot without a coordinator sends only the primary frame', () => {
    const sent: string[] = [];
    const registry = stubRegistry([{ ws: fakeSocket((d) => sent.push(d)), actor: OWNER }]);
    const broadcaster = new ViewerAwareBroadcaster({
      registry,
      buildScopedSnapshot: () => snapshot(),
    });

    broadcaster.broadcast(snapshot());

    expect(sent.map((d) => (JSON.parse(d) as ServerMessage).type)).toEqual(['snapshot']);
  });

  test('a viewer scope is built via the injected factory and memoized per canonical scope key', () => {
    const v1: string[] = [];
    const v2: string[] = [];
    // Two viewers with the same scope expressed in different orders — canonical
    // key collapses them, so the factory runs once.
    const registry = stubRegistry([
      { ws: fakeSocket((d) => v1.push(d)), actor: projectsViewer('g1', ['b', 'a']) },
      { ws: fakeSocket((d) => v2.push(d)), actor: projectsViewer('g2', ['a', 'b']) },
    ]);
    const buildScopedSnapshot = vi.fn<(scope: Scope) => SnapshotMessage>(
      () => snapshot({ serverCwd: '/scoped', achievements: { oversized: 'x'.repeat(200) } }),
    );
    const broadcaster = new ViewerAwareBroadcaster({ registry, buildScopedSnapshot });

    broadcaster.broadcast(snapshot());

    expect(buildScopedSnapshot).toHaveBeenCalledTimes(1);
    expect(buildScopedSnapshot).toHaveBeenCalledWith({ kind: 'projects', projectIds: ['a', 'b'] });
    expect((JSON.parse(v1[0]) as SnapshotMessage).serverCwd).toBe('/scoped');
    expect((JSON.parse(v2[0]) as SnapshotMessage).serverCwd).toBe('/scoped');
  });

  test('the shared fleet base is computed once per flush and threaded into every distinct scope build (#1398)', () => {
    // Three viewers holding three DISTINCT scopes. Pre-#1398 each scope re-ran
    // the fleet projection; now the base is computed once and reused.
    const registry = stubRegistry([
      { ws: fakeSocket(() => undefined), actor: projectsViewer('g1', ['a']) },
      { ws: fakeSocket(() => undefined), actor: projectsViewer('g2', ['b']) },
      { ws: fakeSocket(() => undefined), actor: projectsViewer('g3', ['c']) },
    ]);
    const base = [{ id: 'fleet-base' }] as unknown as AgentState[];
    const computeSnapshotBaseAgents = vi.fn<() => AgentState[]>(() => base);
    const seenBases: (AgentState[] | undefined)[] = [];
    const buildScopedSnapshot = vi.fn<(scope: Scope, baseClientAgents?: AgentState[]) => SnapshotMessage>(
      (_scope, baseClientAgents) => {
        seenBases.push(baseClientAgents);
        return snapshot({ serverCwd: '/scoped' });
      },
    );
    const broadcaster = new ViewerAwareBroadcaster({ registry, buildScopedSnapshot, computeSnapshotBaseAgents });

    broadcaster.broadcast(snapshot());

    // Fleet projection paid once regardless of the three distinct scopes.
    expect(computeSnapshotBaseAgents).toHaveBeenCalledTimes(1);
    expect(buildScopedSnapshot).toHaveBeenCalledTimes(3);
    // Every scope build received the very same base instance.
    expect(seenBases).toHaveLength(3);
    for (const seen of seenBases) expect(seen).toBe(base);
  });

  test('mixed owner + scoped fan-out computes the base once and leaves the owner all-snapshot untouched (#1398)', () => {
    const ownerSent: string[] = [];
    const scopedSent: string[] = [];
    // Owner iterated BEFORE the first scoped viewer: the base must still be
    // computed exactly once, only when the scoped connection is reached.
    const registry = stubRegistry([
      { ws: fakeSocket((d) => ownerSent.push(d)), actor: OWNER },
      { ws: fakeSocket((d) => scopedSent.push(d)), actor: projectsViewer('g1', ['a']) },
    ]);
    const base = [{ id: 'fleet-base' }] as unknown as AgentState[];
    const computeSnapshotBaseAgents = vi.fn<() => AgentState[]>(() => base);
    const buildScopedSnapshot = vi.fn<(scope: Scope, baseClientAgents?: AgentState[]) => SnapshotMessage>(
      () => snapshot({ serverCwd: '/scoped' }),
    );
    const broadcaster = new ViewerAwareBroadcaster({ registry, buildScopedSnapshot, computeSnapshotBaseAgents });

    broadcaster.broadcast(snapshot({ serverCwd: '/owner-all' }));

    expect(computeSnapshotBaseAgents).toHaveBeenCalledTimes(1);
    expect(buildScopedSnapshot).toHaveBeenCalledWith({ kind: 'projects', projectIds: ['a'] }, base);
    // The owner keeps the caller-provided `all` snapshot; the scoped viewer gets the factory's.
    expect((JSON.parse(ownerSent[0]) as SnapshotMessage).serverCwd).toBe('/owner-all');
    expect((JSON.parse(scopedSent[0]) as SnapshotMessage).serverCwd).toBe('/scoped');
  });

  test('the shared fleet base is not computed for an all-only fan-out (#1398)', () => {
    const registry = stubRegistry([
      { ws: fakeSocket(() => undefined), actor: OWNER },
      { ws: fakeSocket(() => undefined), actor: allViewer('gAll') },
    ]);
    const computeSnapshotBaseAgents = vi.fn<() => AgentState[]>(() => [] as unknown as AgentState[]);
    const broadcaster = new ViewerAwareBroadcaster({
      registry,
      buildScopedSnapshot: () => snapshot(),
      computeSnapshotBaseAgents,
    });

    broadcaster.broadcast(snapshot());

    expect(computeSnapshotBaseAgents).not.toHaveBeenCalled();
  });

  test('scoped viewer snapshots are observed and dropped above the payload cap without affecting owners', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const owner: string[] = [];
    const scoped: string[] = [];
    const observations: SnapshotPayloadSizeObservation[] = [];
    const registry = stubRegistry([
      { ws: fakeSocket((d) => owner.push(d)), actor: OWNER },
      { ws: fakeSocket((d) => scoped.push(d)), actor: projectsViewer('g1', ['b', 'a']) },
    ]);
    const buildScopedSnapshot = vi.fn<(scope: Scope) => SnapshotMessage>(
      () => snapshot({ serverCwd: '/scoped', achievements: { oversized: 'x'.repeat(200) } }),
    );
    const broadcaster = new ViewerAwareBroadcaster({
      registry,
      buildScopedSnapshot,
      snapshotPayloadSizePolicy: {
        warnBytes: 1,
        maxBytes: JSON.stringify(snapshot()).length + 50,
        observe: (observation) => observations.push(observation),
      },
    });

    broadcaster.broadcast(snapshot());

    expect(owner.map((d) => (JSON.parse(d) as ServerMessage).type)).toEqual(['snapshot']);
    expect(scoped).toEqual([]);
    expect(buildScopedSnapshot).toHaveBeenCalledWith({ kind: 'projects', projectIds: ['a', 'b'] });
    expect(observations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        payloadType: 'snapshot',
        scopeKey: 'projects:a,b',
        action: 'dropped',
      }),
    ]));
  });

  test('a throwing buildScopedSnapshot is isolated to that connection — owners after it still receive their snapshot', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ownerSent: string[] = [];
    // Viewer comes first; its scoped build throws (the Phase-1 fail-closed stub).
    const registry = stubRegistry([
      { ws: fakeSocket(() => undefined), actor: projectsViewer('g1', ['a']) },
      { ws: fakeSocket((d) => ownerSent.push(d)), actor: OWNER },
    ]);
    const broadcaster = new ViewerAwareBroadcaster({
      registry,
      buildScopedSnapshot: () => {
        throw new Error('scoped builder not wired (Phase 1)');
      },
    });

    expect(() => broadcaster.broadcast(snapshot())).not.toThrow();
    // The owner iterated after the throwing viewer still got the all snapshot.
    expect(ownerSent.map((d) => (JSON.parse(d) as ServerMessage).type)).toEqual(['snapshot']);
  });

  test('on a snapshot-with-coordinator send failure, the coordinator frame is skipped and later sockets get both frames', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const after: string[] = [];
    const failing = fakeSocket(() => {
      throw new Error('send failed');
    });
    const ok = fakeSocket((d) => after.push(d));
    const registry = stubRegistry([
      { ws: failing, actor: OWNER },
      { ws: ok, actor: OWNER },
    ]);
    const broadcaster = new ViewerAwareBroadcaster({
      registry,
      buildScopedSnapshot: () => snapshot(),
    });

    broadcaster.broadcast(snapshot({ coordinator: { outputs: [] } as never }));

    // Failing socket: primary throws, coordinator frame never attempted (1 close, dropped).
    expect(registry.unregistered).toEqual([failing]);
    expect(failing.close).toHaveBeenCalledOnce();
    // Healthy socket still receives both frames.
    expect(after.map((d) => (JSON.parse(d) as ServerMessage).type)).toEqual([
      'snapshot',
      'coordinator.snapshot',
    ]);
  });

  test('a send failure drops the socket from the registry and closes it without aborting others', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const after: string[] = [];
    const failing = fakeSocket(() => {
      throw new Error('send failed');
    });
    const ok = fakeSocket((d) => after.push(d));
    const registry = stubRegistry([
      { ws: failing, actor: OWNER },
      { ws: ok, actor: OWNER },
    ]);
    const broadcaster = new ViewerAwareBroadcaster({
      registry,
      buildScopedSnapshot: () => snapshot(),
    });

    broadcaster.broadcast(snapshot());

    expect(registry.unregistered).toEqual([failing]);
    expect(failing.close).toHaveBeenCalledOnce();
    expect(after.map((d) => (JSON.parse(d) as ServerMessage).type)).toEqual(['snapshot']);
  });

  test('bufferedAmount above soft threshold skips send for that socket only; healthy sockets still receive', () => {
    const stalled: string[] = [];
    const healthy: string[] = [];
    const observations: SnapshotPayloadSizeObservation[] = [];
    const stalledWs = fakeSocket((d) => stalled.push(d), 11);
    const healthyWs = fakeSocket((d) => healthy.push(d), 0);
    const registry = stubRegistry([
      { ws: stalledWs, actor: OWNER },
      { ws: healthyWs, actor: OWNER },
    ]);
    const broadcaster = new ViewerAwareBroadcaster({
      registry,
      buildScopedSnapshot: () => snapshot(),
      backpressureSoftBytes: 10,
      backpressureHardBytes: 1000,
      snapshotPayloadSizePolicy: {
        warnBytes: 1_000_000,
        maxBytes: 8_000_000,
        observe: (observation) => observations.push(observation),
      },
    });

    broadcaster.broadcast(snapshot());

    expect(stalled).toEqual([]);
    expect(registry.unregistered).toEqual([]);
    expect(stalledWs.close).not.toHaveBeenCalled();
    expect(healthy.map((d) => (JSON.parse(d) as ServerMessage).type)).toEqual(['snapshot']);
    expect(observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          payloadType: 'snapshot',
          scopeKey: 'all',
          bytes: 11,
          warnBytes: 10,
          maxBytes: 1000,
          action: 'dropped',
        }),
      ]),
    );
  });

  test('bufferedAmount above hard threshold unregisters and closes with 1013 without aborting others', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const healthy: string[] = [];
    const observations: SnapshotPayloadSizeObservation[] = [];
    const stalledWs = fakeSocket(() => undefined, 1001);
    const healthyWs = fakeSocket((d) => healthy.push(d), 0);
    const registry = stubRegistry([
      { ws: stalledWs, actor: OWNER },
      { ws: healthyWs, actor: OWNER },
    ]);
    const broadcaster = new ViewerAwareBroadcaster({
      registry,
      buildScopedSnapshot: () => snapshot(),
      backpressureSoftBytes: 10,
      backpressureHardBytes: 1000,
      snapshotPayloadSizePolicy: {
        warnBytes: 1_000_000,
        maxBytes: 8_000_000,
        observe: (observation) => observations.push(observation),
      },
    });

    broadcaster.broadcast(snapshot());

    expect(registry.unregistered).toEqual([stalledWs]);
    expect(stalledWs.close).toHaveBeenCalledWith(1013, 'dashboard snapshot backpressure');
    expect(healthy.map((d) => (JSON.parse(d) as ServerMessage).type)).toEqual(['snapshot']);
    expect(observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          payloadType: 'snapshot',
          action: 'dropped',
          bytes: 1001,
          maxBytes: 1000,
        }),
      ]),
    );
  });

  test('normal-draining sockets at or below soft threshold are unaffected', () => {
    const sent: string[] = [];
    // bufferedAmount equal to soft is allowed (strictly greater than soft skips).
    const ws = fakeSocket((d) => sent.push(d), 10);
    const registry = stubRegistry([{ ws, actor: OWNER }]);
    const broadcaster = new ViewerAwareBroadcaster({
      registry,
      buildScopedSnapshot: () => snapshot(),
      backpressureSoftBytes: 10,
      backpressureHardBytes: 1000,
    });

    broadcaster.broadcast(snapshot());

    expect(sent.map((d) => (JSON.parse(d) as ServerMessage).type)).toEqual(['snapshot']);
    expect(registry.unregistered).toEqual([]);
    expect(ws.close).not.toHaveBeenCalled();
  });

  describe('serialize-once (#1725 proof)', () => {
    test('a snapshot flush serializes the `all` payload exactly once regardless of connection count', () => {
      const stringifySpy = vi.spyOn(JSON, 'stringify');
      const sent: string[][] = [[], [], []];
      const registry = stubRegistry([
        { ws: fakeSocket((d) => sent[0].push(d)), actor: OWNER },
        { ws: fakeSocket((d) => sent[1].push(d)), actor: OWNER },
        { ws: fakeSocket((d) => sent[2].push(d)), actor: allViewer('gAll') },
      ]);
      const broadcaster = new ViewerAwareBroadcaster({ registry, buildScopedSnapshot: () => snapshot() });

      const before = stringifySpy.mock.calls.length;
      broadcaster.broadcast(snapshot({ serverCwd: '/repo-once' }));
      const callsForThisBroadcast = stringifySpy.mock.calls.length - before;

      // Exactly one JSON.stringify call for the snapshot payload itself,
      // reused verbatim for every connection in the `all` group — proof that
      // the fan-out is serialize-once, not serialize-per-client (viewer-
      // broadcaster.ts: `serializeSnapshot` called once in `broadcast`, its
      // `data` string handed to `send` for every connection, viewer-
      // broadcaster.ts ~line 171/224).
      expect(callsForThisBroadcast).toBe(1);
      for (const bucket of sent) {
        expect(bucket).toHaveLength(1);
        expect((JSON.parse(bucket[0]) as SnapshotMessage).serverCwd).toBe('/repo-once');
      }
      // All three sockets literally received the same string instance.
      expect(sent[0][0]).toBe(sent[1][0]);
      expect(sent[0][0]).toBe(sent[2][0]);
    });
  });

  describe('sustained soft-backpressure disconnect + resync notice (#1725)', () => {
    test('a socket held above soft threshold for N consecutive broadcasts is disconnected', () => {
      const ws = fakeSocket(() => undefined, 11);
      const registry = stubRegistry([{ ws, actor: OWNER }]);
      const broadcaster = new ViewerAwareBroadcaster({
        registry,
        buildScopedSnapshot: () => snapshot(),
        backpressureSoftBytes: 10,
        backpressureHardBytes: 1000,
        backpressureDisconnectAfterSkips: 3,
      });

      broadcaster.broadcast(snapshot());
      expect(registry.unregistered).toEqual([]);
      broadcaster.broadcast(snapshot());
      expect(registry.unregistered).toEqual([]);
      broadcaster.broadcast(snapshot()); // 3rd consecutive skip -> disconnect

      expect(registry.unregistered).toEqual([ws]);
      expect(ws.close).toHaveBeenCalledWith(1013, 'sustained dashboard snapshot backpressure');
    });

    test('a socket that heals before reaching N skips is not disconnected, and gets a resync notice on drain', () => {
      const sent: string[] = [];
      const ws = fakeSocket((d) => sent.push(d), 11);
      const registry = stubRegistry([{ ws, actor: OWNER }]);
      const broadcaster = new ViewerAwareBroadcaster({
        registry,
        buildScopedSnapshot: () => snapshot(),
        backpressureSoftBytes: 10,
        backpressureHardBytes: 1000,
        backpressureDisconnectAfterSkips: 3,
      });

      broadcaster.broadcast(snapshot()); // skip 1
      broadcaster.broadcast(snapshot()); // skip 2 (below the N=3 threshold)
      ws.bufferedAmount = 0; // drains
      broadcaster.broadcast(snapshot());

      expect(registry.unregistered).toEqual([]);
      expect(ws.close).not.toHaveBeenCalled();
      // The drain tick sends the compact resync notice FIRST, immediately
      // followed by that same tick's real snapshot — the client is warned it
      // may have missed frames, then resumes normal cadence in the same beat.
      expect(sent).toHaveLength(2);
      expect(JSON.parse(sent[0])).toEqual({ type: 'wsBackpressureNotice', kind: 'resyncNeeded', scopeKey: 'all' });
      expect((JSON.parse(sent[1]) as ServerMessage).type).toBe('snapshot');

      sent.length = 0;
      broadcaster.broadcast(snapshot());
      expect(sent.map((d) => (JSON.parse(d) as ServerMessage).type)).toEqual(['snapshot']);
    });

    test('the consecutive-skip counter resets on drain — a later saturation streak starts fresh', () => {
      const ws = fakeSocket(() => undefined, 11);
      const registry = stubRegistry([{ ws, actor: OWNER }]);
      const broadcaster = new ViewerAwareBroadcaster({
        registry,
        buildScopedSnapshot: () => snapshot(),
        backpressureSoftBytes: 10,
        backpressureHardBytes: 1000,
        backpressureDisconnectAfterSkips: 2,
      });

      broadcaster.broadcast(snapshot()); // skip 1
      ws.bufferedAmount = 0;
      broadcaster.broadcast(snapshot()); // heals, resets counter
      ws.bufferedAmount = 11;
      broadcaster.broadcast(snapshot()); // skip 1 (fresh streak)
      expect(registry.unregistered).toEqual([]);
      broadcaster.broadcast(snapshot()); // skip 2 -> disconnect
      expect(registry.unregistered).toEqual([ws]);
    });

    test('R3: the counter is scoped to snapshot frames only — non-snapshot deltas over soft never count toward disconnect', () => {
      const ws = fakeSocket(() => undefined, 11);
      const registry = stubRegistry([{ ws, actor: OWNER }]);
      const broadcaster = new ViewerAwareBroadcaster({
        registry,
        buildScopedSnapshot: () => snapshot(),
        backpressureSoftBytes: 10,
        backpressureHardBytes: 1000,
        backpressureDisconnectAfterSkips: 2,
      });

      // A burst of ordinary (non-snapshot) delta traffic over soft threshold —
      // must never accumulate toward the snapshot-scoped disconnect counter,
      // however many times it happens.
      for (let i = 0; i < 10; i++) {
        broadcaster.broadcast({ type: 'projectSummaries', projects: [] });
      }
      expect(registry.unregistered).toEqual([]);

      // Now two consecutive SNAPSHOT skips reach the N=2 threshold and disconnect.
      broadcaster.broadcast(snapshot());
      expect(registry.unregistered).toEqual([]);
      broadcaster.broadcast(snapshot());
      expect(registry.unregistered).toEqual([ws]);
    });

    test('R3: a coordinator.snapshot frame does not double-count against the same broadcast\'s snapshot skip', () => {
      const ws = fakeSocket(() => undefined, 11);
      const registry = stubRegistry([{ ws, actor: OWNER }]);
      const broadcaster = new ViewerAwareBroadcaster({
        registry,
        buildScopedSnapshot: () => snapshot(),
        backpressureSoftBytes: 10,
        backpressureHardBytes: 1000,
        backpressureDisconnectAfterSkips: 2,
      });

      // Each broadcast sends BOTH a primary snapshot frame and a coordinator
      // frame (since coordinator is set) — if coordinator counted too, one
      // broadcast would already reach N=2 and disconnect. It must take two
      // full broadcasts (two snapshot-scoped skips), not one.
      broadcaster.broadcast(snapshot({ coordinator: { outputs: [] } as never }));
      expect(registry.unregistered).toEqual([]);
      broadcaster.broadcast(snapshot({ coordinator: { outputs: [] } as never }));
      expect(registry.unregistered).toEqual([ws]);
    });

    test('R9: backpressureDisconnectAfterSkips: 0 disables the sustained-skip disconnect entirely — soft-skip persists forever without disconnecting', () => {
      const ws = fakeSocket(() => undefined, 11);
      const registry = stubRegistry([{ ws, actor: OWNER }]);
      const broadcaster = new ViewerAwareBroadcaster({
        registry,
        buildScopedSnapshot: () => snapshot(),
        backpressureSoftBytes: 10,
        backpressureHardBytes: 1000,
        backpressureDisconnectAfterSkips: 0,
      });

      for (let i = 0; i < 20; i++) broadcaster.broadcast(snapshot());

      expect(registry.unregistered).toEqual([]);
      expect(ws.close).not.toHaveBeenCalled();
    });
  });

  describe('load-shed mode (#1725)', () => {
    function fakeLoadShedGate(initialActive: boolean): {
      isActive: boolean;
      lastEventLoopDelayP95Ms: number | null;
      recordSkippedSnapshot: ReturnType<typeof vi.fn>;
    } {
      return {
        isActive: initialActive,
        lastEventLoopDelayP95Ms: 1800,
        recordSkippedSnapshot: vi.fn(),
      };
    }

    test('while active, full snapshot fan-out is replaced by one tiny notice per connection and the gate is told', () => {
      const sentA: string[] = [];
      const sentB: string[] = [];
      const registry = stubRegistry([
        { ws: fakeSocket((d) => sentA.push(d)), actor: OWNER },
        { ws: fakeSocket((d) => sentB.push(d)), actor: allViewer('gAll') },
      ]);
      const loadShedGate = fakeLoadShedGate(true);
      const broadcaster = new ViewerAwareBroadcaster({ registry, buildScopedSnapshot: () => snapshot(), loadShedGate });

      broadcaster.broadcast(snapshot({ serverCwd: '/should-not-be-sent' }));

      expect(loadShedGate.recordSkippedSnapshot).toHaveBeenCalledTimes(1);
      for (const bucket of [sentA, sentB]) {
        expect(bucket).toHaveLength(1);
        expect(JSON.parse(bucket[0])).toEqual({
          type: 'wsBackpressureNotice',
          kind: 'loadShedActive',
          eventLoopDelayP95Ms: 1800,
        });
      }
    });

    test('non-snapshot messages still flow normally while shed mode is active', () => {
      const sent: string[] = [];
      const registry = stubRegistry([{ ws: fakeSocket((d) => sent.push(d)), actor: OWNER }]);
      const loadShedGate = fakeLoadShedGate(true);
      const broadcaster = new ViewerAwareBroadcaster({ registry, buildScopedSnapshot: () => snapshot(), loadShedGate });

      broadcaster.broadcast({ type: 'projectSummaries', projects: [] });

      expect(sent.map((d) => (JSON.parse(d) as ServerMessage).type)).toEqual(['projectSummaries']);
      expect(loadShedGate.recordSkippedSnapshot).not.toHaveBeenCalled();
    });

    test('when the gate is inactive, snapshots flow exactly as before shed mode was ever engaged', () => {
      const sent: string[] = [];
      const registry = stubRegistry([{ ws: fakeSocket((d) => sent.push(d)), actor: OWNER }]);
      const loadShedGate = fakeLoadShedGate(false);
      const broadcaster = new ViewerAwareBroadcaster({ registry, buildScopedSnapshot: () => snapshot(), loadShedGate });

      broadcaster.broadcast(snapshot());

      expect(sent.map((d) => (JSON.parse(d) as ServerMessage).type)).toEqual(['snapshot']);
    });

    test('on recovery, a loadShedRecovered notice is sent and the SAME broadcast resumes the full snapshot', () => {
      const sent: string[] = [];
      const registry = stubRegistry([{ ws: fakeSocket((d) => sent.push(d)), actor: OWNER }]);
      const loadShedGate = fakeLoadShedGate(true);
      const broadcaster = new ViewerAwareBroadcaster({ registry, buildScopedSnapshot: () => snapshot(), loadShedGate });

      broadcaster.broadcast(snapshot()); // shed: notice only
      expect(sent).toHaveLength(1);
      expect((JSON.parse(sent[0]) as { kind: string }).kind).toBe('loadShedActive');

      loadShedGate.isActive = false; // gate recovers between ticks
      sent.length = 0;
      broadcaster.broadcast(snapshot());

      expect(sent.map((d) => (JSON.parse(d) as { type: string; kind?: string }))).toEqual([
        { type: 'wsBackpressureNotice', kind: 'loadShedRecovered', scopeKey: undefined, eventLoopDelayP95Ms: 1800 },
        { type: 'snapshot', agents: [], serverCwd: '/repo' },
      ]);
    });

    test('without a loadShedGate wired, behavior is unchanged from pre-#1725 (opt-in, no regression)', () => {
      const sent: string[] = [];
      const registry = stubRegistry([{ ws: fakeSocket((d) => sent.push(d)), actor: OWNER }]);
      const broadcaster = new ViewerAwareBroadcaster({ registry, buildScopedSnapshot: () => snapshot() });

      broadcaster.broadcast(snapshot());

      expect(sent.map((d) => (JSON.parse(d) as ServerMessage).type)).toEqual(['snapshot']);
    });
  });
});
