import { describe, expect, test, vi } from 'vitest';
import { WebSocket } from 'ws';

import type { Actor } from './auth.js';
import type { DeltaMessage, ServerMessage, SnapshotMessage } from '../shared/contracts/messages.js';
import type { AgentState } from '../shared/contracts/agent-state.js';
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

function stubRegistry(connections: { ws: WebSocket; actor: Actor }[]): BroadcasterRegistry {
  return {
    snapshotDashboardConnections: () => [...connections],
    unregister: () => {},
  };
}

const OWNER: Actor = { kind: 'owner' };
function projectsViewer(projectIds: string[]): Actor {
  return { kind: 'viewer', grantId: 'g', scope: { kind: 'projects', projectIds } };
}

function snapshot(overrides: Partial<SnapshotMessage> = {}): SnapshotMessage {
  return { type: 'snapshot', agents: [], serverCwd: '/repo', epoch: 'E1', seq: 2, ...overrides };
}

function delta(overrides: Partial<DeltaMessage> = {}): DeltaMessage {
  return { type: 'delta', epoch: 'E1', seq: 2, ...overrides };
}

function agent(partial: Partial<AgentState> & { agentId: string }): AgentState {
  return { events: [], anomaly: null, ...partial } as AgentState;
}

describe('ViewerAwareBroadcaster.broadcastDelta (#1754 Stage 2)', () => {
  test('healthy owner sockets receive the delta frame', () => {
    const seen: string[] = [];
    const ws = fakeSocket((d) => seen.push(d));
    const broadcaster = new ViewerAwareBroadcaster({
      registry: stubRegistry([{ ws, actor: OWNER }]),
      buildScopedSnapshot: () => snapshot(),
    });

    broadcaster.broadcastDelta(
      delta({ agents: { upserts: [agent({ agentId: 's1', taskId: 't1' })], removed: [] } }),
      snapshot(),
    );

    expect(seen).toHaveLength(1);
    const msg = JSON.parse(seen[0]) as ServerMessage;
    expect(msg.type).toBe('delta');
    if (msg.type === 'delta') {
      expect(msg.agents?.upserts).toHaveLength(1);
      expect(msg.seq).toBe(2);
    }
  });

  test('a needsSnapshot socket receives a full snapshot re-base instead of a delta', () => {
    const seen: string[] = [];
    const ws = fakeSocket((d) => seen.push(d), 500); // soft-skip first
    const broadcaster = new ViewerAwareBroadcaster({
      registry: stubRegistry([{ ws, actor: OWNER }]),
      buildScopedSnapshot: () => snapshot(),
      backpressureSoftBytes: 100,
      backpressureHardBytes: 10_000,
    });

    // Latch needsSnapshot via a soft-skipped snapshot.
    broadcaster.broadcast(snapshot({ seq: 1 }));
    expect(broadcaster.connectionNeedsSnapshot(ws)).toBe(true);

    seen.length = 0;
    ws.bufferedAmount = 0;
    broadcaster.broadcastDelta(delta({ seq: 2 }), snapshot({ seq: 2 }));

    expect(broadcaster.connectionNeedsSnapshot(ws)).toBe(false);
    const types = seen.map((d) => (JSON.parse(d) as ServerMessage).type);
    expect(types).toContain('snapshot');
    expect(types).not.toContain('delta');
  });

  test('projects viewers receive scope-filtered deltas (no whole-world aggregates)', () => {
    const seen: string[] = [];
    const ws = fakeSocket((d) => seen.push(d));
    const previous = [
      agent({ agentId: 's1', taskId: 't1', projectId: 'p1' }),
      agent({ agentId: 's2', taskId: 't2', projectId: 'p2' }),
    ];
    const broadcaster = new ViewerAwareBroadcaster({
      registry: stubRegistry([{ ws, actor: projectsViewer(['p1']) }]),
      buildScopedSnapshot: () => snapshot(),
    });

    broadcaster.broadcastDelta(
      delta({
        agents: {
          upserts: [
            agent({ agentId: 's1', taskId: 't1', projectId: 'p1', taskName: 'in' }),
            agent({ agentId: 's2', taskId: 't2', projectId: 'p2', taskName: 'out' }),
          ],
          removed: [],
        },
        aggregates: { totalSpendUsd: 42 },
      }),
      snapshot(),
      previous,
    );

    expect(seen).toHaveLength(1);
    const msg = JSON.parse(seen[0]) as DeltaMessage;
    expect(msg.type).toBe('delta');
    expect(msg.agents?.upserts.map((a) => a.agentId)).toEqual(['s1']);
    expect(msg.aggregates).toBeUndefined();
  });
});
