// @vitest-environment jsdom

import React, { useEffect } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  dispatchAlertMessageForClient,
  dispatchCoordinatorSnapshotMessageForClient,
  dispatchSnapshotMessageForClient,
  parseServerMessageForClient,
  recordAndParseServerMessageForClient,
  recordClientMessageForSend,
  useWebSocket,
  workspaceRefreshMessageAfterSweep,
} from './useWebSocket.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import { getBugReportWireObservations, resetBugReportRecorderForTests } from '../bug-report-recorder.js';
import type { ServerMessage } from '../../shared/protocol.js';

class RuntimeWebSocket {
  static OPEN = 1;
  static instances: RuntimeWebSocket[] = [];

  readyState = RuntimeWebSocket.OPEN;
  sent: string[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public readonly url: string) {
    RuntimeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }
}

function WebSocketProbe({ onReady }: { onReady: (send: ReturnType<typeof useWebSocket>['send']) => void }) {
  const { send } = useWebSocket();
  useEffect(() => {
    onReady(send);
  }, [onReady, send]);
  return null;
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetBugReportRecorderForTests();
  RuntimeWebSocket.instances = [];
});

describe('parseServerMessageForClient snapshot tolerance', () => {
  it('records inbound and outbound observations through the mounted hook runtime path', async () => {
    resetBugReportRecorderForTests();
    RuntimeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', RuntimeWebSocket);
    const container = document.createElement('div');
    const root: Root = createRoot(container);
    let send: ReturnType<typeof useWebSocket>['send'] | null = null;

    await act(async () => {
      root.render(React.createElement(WebSocketProbe, { onReady: (nextSend) => { send = nextSend; } }));
    });

    const socket = RuntimeWebSocket.instances[0];
    expect(socket).toBeDefined();
    act(() => {
      socket.onmessage?.({ data: '{not-json' });
    });
    expect(send?.({ type: 'respond', agentId: 'agent-1', input: 'private customer prompt' })).toBe(true);

    const serialized = JSON.stringify(getBugReportWireObservations());
    expect(serialized).toContain('"direction":"inbound"');
    expect(serialized).toContain('"validationError":"json_parse_failed"');
    expect(serialized).toContain('"direction":"outbound"');
    expect(serialized).toContain('"type":"respond"');
    expect(serialized).not.toContain('private customer prompt');

    await act(async () => {
      root.unmount();
    });
  });

  it('updates bypass permission state through the mounted snapshot runtime path', async () => {
    RuntimeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', RuntimeWebSocket);
    const container = document.createElement('div');
    const root: Root = createRoot(container);
    useKookrStore.setState({ bypassAllPermissions: false });

    await act(async () => {
      root.render(React.createElement(WebSocketProbe, { onReady: () => {} }));
    });

    const socket = RuntimeWebSocket.instances[0];
    expect(socket).toBeDefined();
    act(() => {
      socket.onmessage?.({
        data: JSON.stringify({
          type: 'snapshot',
          agents: [],
          serverCwd: '/repo',
          bypassAllPermissions: true,
        }),
      });
    });

    expect(useKookrStore.getState().bypassAllPermissions).toBe(true);

    await act(async () => {
      root.unmount();
    });
  });

  it('updates drain status through the mounted snapshot runtime path', async () => {
    RuntimeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', RuntimeWebSocket);
    const container = document.createElement('div');
    const root: Root = createRoot(container);
    useKookrStore.setState({ drainStatus: { accepting: true, draining: false } });

    await act(async () => {
      root.render(React.createElement(WebSocketProbe, { onReady: () => {} }));
    });

    const socket = RuntimeWebSocket.instances[0];
    expect(socket).toBeDefined();
    act(() => {
      socket.onmessage?.({
        data: JSON.stringify({
          type: 'snapshot',
          agents: [],
          serverCwd: '/repo',
          drainStatus: { accepting: false, draining: true, since: '2026-05-29T12:00:00.000Z' },
        }),
      });
    });

    expect(useKookrStore.getState().drainStatus).toEqual({
      accepting: false,
      draining: true,
      since: '2026-05-29T12:00:00.000Z',
    });

    await act(async () => {
      root.unmount();
    });
  });

  it('records malformed inbound messages before returning null', () => {
    resetBugReportRecorderForTests();

    expect(recordAndParseServerMessageForClient('{not-json')).toBeNull();

    expect(getBugReportWireObservations()[0]).toMatchObject({
      direction: 'inbound',
      parseOk: false,
      validationError: 'json_parse_failed',
    });
  });

  it('records outbound send metadata without retaining prompt values', () => {
    resetBugReportRecorderForTests();

    recordClientMessageForSend({ type: 'respond', agentId: 'agent-1', input: 'private customer prompt' });

    const serialized = JSON.stringify(getBugReportWireObservations());
    expect(serialized).toContain('"type":"respond"');
    expect(serialized).toContain('"input"');
    expect(serialized).not.toContain('private customer prompt');
  });

  it('refreshes only the currently displayed workspace after a matching sweep project completes', () => {
    const msg: Extract<ServerMessage, { type: 'workspaceSweepComplete' }> = {
      type: 'workspaceSweepComplete',
      runId: 'run-1',
      startedAt: '2026-06-21T05:00:00.000Z',
      finishedAt: '2026-06-21T05:00:01.000Z',
      projects: [
        { kind: 'ok', projectId: 'github.com/acme/a', summaries: [], elapsedMs: 5 },
        { kind: 'ok', projectId: 'github.com/acme/b', summaries: [], elapsedMs: 7 },
      ],
    };

    expect(workspaceRefreshMessageAfterSweep(msg, 'github.com/acme/a')).toEqual({
      type: 'workspace:getView',
      projectId: 'github.com/acme/a',
    });
    expect(workspaceRefreshMessageAfterSweep(msg, 'github.com/acme/c')).toBeNull();
    expect(workspaceRefreshMessageAfterSweep(msg, null)).toBeNull();
  });


  it('preserves unknown snapshot fields for additive server-message compatibility', () => {
    const parsed = parseServerMessageForClient(JSON.stringify({
      type: 'snapshot',
      agents: [],
      serverCwd: '/repo',
      futureField: { ok: true },
    }));

    expect(parsed).toMatchObject({
      type: 'snapshot',
      agents: [],
      serverCwd: '/repo',
      futureField: { ok: true },
    });
  });

  it('returns null for malformed JSON', () => {
    expect(parseServerMessageForClient('{not-json')).toBeNull();
  });

  it('dispatches Phase 6 speech capabilities through the snapshot runtime path', () => {
    const calls: unknown[][] = [];
    dispatchSnapshotMessageForClient({
      type: 'snapshot',
      agents: [],
      serverCwd: '/repo',
      maxActiveTasks: 7,
      coordinator: { outputs: [{ detectorId: 'stale', taskId: 'task-1', evidence: {} }], chips: [], findings: [], chains: {} },
      speechCapabilities: {
        capabilitiesByDevice: {
          'local-node': [],
        },
      },
      bypassAllPermissions: true,
      drainStatus: { accepting: false, draining: true },
    }, (...args) => {
      calls.push(args);
    });

    expect(calls).toHaveLength(1);
    expect(calls[0][12]).toBe(7);
    expect(calls[0][13]).toEqual({ capabilitiesByDevice: { 'local-node': [] } });
    expect(calls[0][14]).toEqual({ outputs: [{ detectorId: 'stale', taskId: 'task-1', evidence: {} }], chips: [], findings: [], chains: {} });
    expect(calls[0][16]).toBe(true);
    expect(calls[0][17]).toEqual({ accepting: false, draining: true });
  });

  it('dispatches standalone coordinator snapshots through the coordinator runtime path', () => {
    const coordinator = {
      outputs: [{ detectorId: 'stale', taskId: 'task-1', evidence: {} }],
      chips: [],
      findings: [],
      chains: {},
    };

    useKookrStore.setState({ coordinator: null });
    dispatchCoordinatorSnapshotMessageForClient({
      type: 'coordinator.snapshot',
      coordinator,
    });

    expect(useKookrStore.getState().coordinator).toEqual(coordinator);
  });

  it('dispatches alert details through the WebSocket alert runtime path', () => {
    const store = createKookrStore();

    dispatchAlertMessageForClient({
      type: 'alert',
      agentId: '',
      summary: 'Error starting "demo": spawn failed',
      details: 'Run `pnpm run doctor` from the Kookr checkout.',
      severity: 'critical',
    }, store.getState().handleAlert);

    expect(store.getState().alerts[0]).toMatchObject({
      summary: 'Error starting "demo": spawn failed',
      details: 'Run `pnpm run doctor` from the Kookr checkout.',
      severity: 'error',
    });
  });
});
