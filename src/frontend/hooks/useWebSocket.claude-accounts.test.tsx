// @vitest-environment happy-dom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWebSocket } from './useWebSocket.js';
import {
  refreshClaudeAccounts,
  requestTaskAccountSwitch,
  resetClaudeAccountsStore,
  useClaudeAccountsStore,
} from '../store/claude-accounts.js';
import { installFakeAccountsServer, makeAccount, type FakeAccountsServer } from '../store/claude-accounts-fixtures.js';

/**
 * The accounts store has its own tests. This file covers the lines in the
 * dashboard socket that feed it: replies to `switchClaudeAccount`, failing the
 * pending switches when the socket drops, and reloading the list on reconnect.
 */
class RuntimeWebSocket {
  static OPEN = 1;
  static instances: RuntimeWebSocket[] = [];
  readyState = RuntimeWebSocket.OPEN;
  onmessage: ((event: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public readonly url: string) {
    RuntimeWebSocket.instances.push(this);
  }
  send(): void {}
  close(): void {
    this.readyState = 3;
  }
}

function Probe() {
  useWebSocket();
  return null;
}

const names = () => useClaudeAccountsStore.getState().accounts.map((a) => a.name);

describe('useWebSocket: Claude accounts', () => {
  let root: Root;
  let server: FakeAccountsServer;
  const latest = () => RuntimeWebSocket.instances.at(-1)!;
  const receive = (socket: RuntimeWebSocket, message: unknown) =>
    act(() => { socket.onmessage?.({ data: JSON.stringify(message) }); });
  // Any frame establishes the connection (`establishOn: 'first-message'`).
  const establish = (socket: RuntimeWebSocket) => {
    act(() => { socket.onopen?.(); });
    receive(socket, { type: 'operatorAskResult', askId: 'none', ok: true });
  };
  const gets = () => server.calls.filter((c) => c.method === 'GET' && c.url === '/api/claude-accounts').length;
  const settle = () => act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });

  beforeEach(async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    RuntimeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', RuntimeWebSocket);
    resetClaudeAccountsStore();
    server = installFakeAccountsServer(['pro']);
    root = createRoot(document.createElement('div'));
    await act(async () => { root.render(React.createElement(Probe)); });
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    vi.useRealTimers();
    vi.unstubAllGlobals();
    resetClaudeAccountsStore();
  });

  it('resolves a switch with the claudeAccountSwitchResult that answers it', async () => {
    establish(latest());
    let requestId = '';
    const result = requestTaskAccountSwitch((msg) => {
      if (msg.type === 'switchClaudeAccount') requestId = msg.requestId;
      return true;
    }, 't1', 'pro');
    receive(latest(), { type: 'claudeAccountSwitchResult', requestId, taskId: 't1', ok: true, outcome: 'relaunched', from: 'host', to: 'pro' });
    await expect(result).resolves.toEqual({ kind: 'ok', text: 'Moved to pro.' });
  });

  it('ends a pending switch when the socket drops, since its reply can no longer arrive', async () => {
    establish(latest());
    const result = requestTaskAccountSwitch(() => true, 't1', 'pro');
    act(() => { latest().onclose?.(); });
    await expect(result).resolves.toMatchObject({ kind: 'error', text: expect.stringContaining('Lost the connection') });
  });

  it('reloads a loaded account list on reconnect, not on the first connect', async () => {
    await act(async () => { await refreshClaudeAccounts(); });
    expect(names()).toEqual(['host', 'pro']);
    const loaded = gets();
    establish(latest());
    await settle();
    expect(gets()).toBe(loaded);

    // `kookr account add work`, then the server restarts.
    server.accounts = [...server.accounts, makeAccount('work')];
    const first = latest();
    act(() => { first.onclose?.(); });
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(latest()).not.toBe(first);
    establish(latest());
    await settle();
    expect(gets()).toBe(loaded + 1);
    expect(names()).toEqual(['host', 'pro', 'work']);
  });
});
