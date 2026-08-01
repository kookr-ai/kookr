import { describe, expect, test, vi } from 'vitest';
import { WebSocket } from 'ws';

import type { Actor } from './auth.js';
import type { ServerMessage, SnapshotMessage } from '../shared/contracts/messages.js';
import { ViewerAwareBroadcaster, type BroadcasterRegistry } from './viewer-broadcaster.js';

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

function snapshot(overrides: Partial<SnapshotMessage> = {}): SnapshotMessage {
  return { type: 'snapshot', agents: [], serverCwd: '/repo', ...overrides };
}

describe('ViewerAwareBroadcaster — delta resync escape hatch (#1754 Stage 1)', () => {
  test('a soft-skipped socket latches needsSnapshot until a full snapshot is delivered', () => {
    const seen: string[] = [];
    const ws = fakeSocket((d) => seen.push(d), 500); // over soft
    const registry = stubRegistry([{ ws, actor: OWNER }]);
    const broadcaster = new ViewerAwareBroadcaster({
      registry,
      buildScopedSnapshot: () => snapshot(),
      backpressureSoftBytes: 100,
      backpressureHardBytes: 10_000,
    });

    expect(broadcaster.connectionNeedsSnapshot(ws)).toBe(false);

    // Snapshot is soft-skipped for this socket → it may now trail the stream.
    broadcaster.broadcast(snapshot({ epoch: 'E1', seq: 1 }));
    expect(broadcaster.connectionNeedsSnapshot(ws)).toBe(true);
    // The invariant: while the latch is set, the socket has NOT received a
    // re-base frame — it must get a snapshot before any further delta.

    // Socket drains; the next snapshot is delivered and re-bases it.
    ws.bufferedAmount = 0;
    broadcaster.broadcast(snapshot({ epoch: 'E1', seq: 2 }));
    expect(broadcaster.connectionNeedsSnapshot(ws)).toBe(false);
    // The delivered frame is a snapshot (re-base), not a silent resume.
    const delivered = seen.map((d) => JSON.parse(d) as ServerMessage);
    expect(delivered.some((m) => m.type === 'snapshot')).toBe(true);
  });

  test('a non-snapshot frame does NOT clear the needsSnapshot latch (only a snapshot re-bases)', () => {
    const ws = fakeSocket(() => {}, 500);
    const registry = stubRegistry([{ ws, actor: OWNER }]);
    const broadcaster = new ViewerAwareBroadcaster({
      registry,
      buildScopedSnapshot: () => snapshot(),
      backpressureSoftBytes: 100,
      backpressureHardBytes: 10_000,
    });

    broadcaster.broadcast(snapshot({ epoch: 'E1', seq: 1 })); // skipped → latched
    expect(broadcaster.connectionNeedsSnapshot(ws)).toBe(true);

    // Drain, then send a non-snapshot frame. It is delivered but must NOT clear
    // the latch — the client still needs a full snapshot to re-base.
    ws.bufferedAmount = 0;
    broadcaster.broadcast({ type: 'projectSummaries', projects: [] });
    expect(broadcaster.connectionNeedsSnapshot(ws)).toBe(true);
  });

  test('propagates the flush (epoch, seq) onto every per-scope snapshot frame', () => {
    const ownerSeen: string[] = [];
    const scopedSeen: string[] = [];
    const registry = stubRegistry([
      { ws: fakeSocket((d) => ownerSeen.push(d)), actor: OWNER },
      { ws: fakeSocket((d) => scopedSeen.push(d)), actor: projectsViewer('g', ['p1']) },
    ]);
    const broadcaster = new ViewerAwareBroadcaster({
      registry,
      // The scoped factory builds its OWN snapshot with no (epoch, seq) — the
      // broadcaster must stamp the flush position onto it.
      buildScopedSnapshot: () => snapshot({ agents: [] }),
    });

    broadcaster.broadcast(snapshot({ epoch: 'E7', seq: 42 }));

    const ownerMsg = JSON.parse(ownerSeen[0]) as SnapshotMessage;
    const scopedMsg = JSON.parse(scopedSeen[0]) as SnapshotMessage;
    expect(ownerMsg.epoch).toBe('E7');
    expect(ownerMsg.seq).toBe(42);
    expect(scopedMsg.epoch).toBe('E7');
    expect(scopedMsg.seq).toBe(42);
  });

  test('regression: an unstamped snapshot yields frames byte-identical to pre-#1754 (no epoch/seq)', () => {
    const ownerSeen: string[] = [];
    const scopedSeen: string[] = [];
    const registry = stubRegistry([
      { ws: fakeSocket((d) => ownerSeen.push(d)), actor: OWNER },
      { ws: fakeSocket((d) => scopedSeen.push(d)), actor: projectsViewer('g', ['p1']) },
    ]);
    const broadcaster = new ViewerAwareBroadcaster({
      registry,
      buildScopedSnapshot: () => snapshot({ agents: [] }),
    });

    // No sequencer wired upstream → the incoming snapshot carries no (epoch, seq).
    broadcaster.broadcast(snapshot());

    const ownerMsg = JSON.parse(ownerSeen[0]) as SnapshotMessage;
    const scopedMsg = JSON.parse(scopedSeen[0]) as SnapshotMessage;
    expect(ownerMsg).not.toHaveProperty('epoch');
    expect(ownerMsg).not.toHaveProperty('seq');
    expect(scopedMsg).not.toHaveProperty('epoch');
    expect(scopedMsg).not.toHaveProperty('seq');
  });
});
