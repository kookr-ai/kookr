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
});
