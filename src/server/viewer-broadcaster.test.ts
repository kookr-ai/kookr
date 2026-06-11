import { afterEach, describe, expect, test, vi } from 'vitest';
import { WebSocket } from 'ws';

import type { Actor } from './auth.js';
import type { Scope } from './viewer-data-policy.js';
import type { ServerMessage, SnapshotMessage } from '../shared/contracts/messages.js';
import { ViewerAwareBroadcaster, type BroadcasterRegistry } from './viewer-broadcaster.js';
import type { SnapshotPayloadSizeObservation } from './snapshot-payload-size-policy.js';

function fakeSocket(send: (data: string) => void): WebSocket & { close: ReturnType<typeof vi.fn> } {
  return {
    readyState: WebSocket.OPEN,
    send,
    close: vi.fn(),
  } as unknown as WebSocket & { close: ReturnType<typeof vi.fn> };
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
});
