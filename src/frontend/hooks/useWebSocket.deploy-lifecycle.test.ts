// @vitest-environment jsdom

import React, { useEffect } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  dispatchDeployLifecycleMessageForClient,
  useWebSocket,
} from './useWebSocket.js';
import { useKookrStore } from '../store/useStore.js';
import { saveDeployIntent } from '../store/deploy-intent-storage.js';

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
  RuntimeWebSocket.instances = [];
  saveDeployIntent(false);
  useKookrStore.setState({ deploying: false });
});

describe('deployLifecycle client handling (issue #1980)', () => {
  it('sets the session deploy flag when phase is starting (helper)', () => {
    const setDeploying = vi.fn();
    dispatchDeployLifecycleMessageForClient({ type: 'deployLifecycle', phase: 'starting' }, setDeploying);
    expect(setDeploying).toHaveBeenCalledOnce();
    expect(setDeploying).toHaveBeenCalledWith(true);
  });

  it('ignores unknown phases without mutating state (helper)', () => {
    const setDeploying = vi.fn();
    dispatchDeployLifecycleMessageForClient({ type: 'deployLifecycle', phase: 'finished' }, setDeploying);
    expect(setDeploying).not.toHaveBeenCalled();
  });

  it('sets deploying through the mounted WebSocket switch on deployLifecycle starting', async () => {
    RuntimeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', RuntimeWebSocket);
    saveDeployIntent(false);
    useKookrStore.setState({ deploying: false });

    const container = document.createElement('div');
    const root: Root = createRoot(container);

    await act(async () => {
      root.render(React.createElement(WebSocketProbe, { onReady: () => {} }));
    });

    const socket = RuntimeWebSocket.instances[0];
    expect(socket).toBeDefined();

    act(() => {
      socket.onmessage?.({
        data: JSON.stringify({ type: 'deployLifecycle', phase: 'starting' }),
      });
    });

    expect(useKookrStore.getState().deploying).toBe(true);

    await act(async () => {
      root.unmount();
    });
  });

  it('ignores unknown message types without throwing or mutating deploy state', async () => {
    RuntimeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', RuntimeWebSocket);
    saveDeployIntent(false);
    useKookrStore.setState({ deploying: false });

    const container = document.createElement('div');
    const root: Root = createRoot(container);

    await act(async () => {
      root.render(React.createElement(WebSocketProbe, { onReady: () => {} }));
    });

    const socket = RuntimeWebSocket.instances[0];
    expect(socket).toBeDefined();

    expect(() => {
      act(() => {
        socket.onmessage?.({
          data: JSON.stringify({ type: 'futureUnknownDeployEvent', phase: 'starting' }),
        });
      });
    }).not.toThrow();

    expect(useKookrStore.getState().deploying).toBe(false);

    await act(async () => {
      root.unmount();
    });
  });
});
