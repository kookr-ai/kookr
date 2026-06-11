// @vitest-environment jsdom

/**
 * Regression tests for the disconnect/restart flicker (2026-06): the dashboard
 * socket must not flap the `connected` flag while the server is down or
 * restarting, must never run rival reconnect chains (zombie sockets double-
 * processing snapshots), and must back off instead of hammering.
 */

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWebSocket } from './useWebSocket.js';
import { useKookrStore } from '../store/useStore.js';
import { resetBugReportRecorderForTests } from '../bug-report-recorder.js';

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  closeCalls = 0;
  onmessage: ((event: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onclose: ((event?: { code?: number }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = 3;
  }

  emitOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  emitSnapshot(): void {
    this.onmessage?.({ data: JSON.stringify({ type: 'snapshot', agents: [], serverCwd: '/repo' }) });
  }

  emitClose(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

function Probe() {
  useWebSocket();
  return null;
}

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

async function mountHook(): Promise<void> {
  const container = document.createElement('div');
  root = createRoot(container);
  await act(async () => {
    root!.render(React.createElement(Probe));
  });
}

async function unmountHook(): Promise<void> {
  if (!root) return;
  const current = root;
  root = null;
  await act(async () => {
    current.unmount();
  });
}

// Generous upper bound for the first retry delay (1000ms ± 20% jitter).
const FIRST_RETRY_MS = 2_000;

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
    json: () => Promise.resolve({ revision: 0, schedules: [], status: undefined }),
  })));
  useKookrStore.setState({ connected: false });
});

afterEach(async () => {
  await unmountHook();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  resetBugReportRecorderForTests();
});

describe('useWebSocket reconnect lifecycle', () => {
  it('reports connected only once the server delivers data, not on bare socket open', async () => {
    await mountHook();
    const socket = FakeWebSocket.instances[0];
    socket.emitOpen();
    expect(useKookrStore.getState().connected).toBe(false);
    socket.emitSnapshot();
    expect(useKookrStore.getState().connected).toBe(true);
  });

  it('does not flap connected while a restarting server accepts upgrades and drops them', async () => {
    await mountHook();
    const observed: boolean[] = [];
    const unsubscribe = useKookrStore.subscribe((state, prev) => {
      if (state.connected !== prev.connected) observed.push(state.connected);
    });

    // Three retry cycles where the upgrade succeeds but dies before any data.
    for (let i = 0; i < 3; i++) {
      const socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
      socket.emitOpen();
      socket.emitClose();
      await act(async () => {
        vi.advanceTimersByTime(FIRST_RETRY_MS * 2 ** i);
      });
    }

    expect(observed).toEqual([]); // connected never flipped → no indicator flicker
    expect(FakeWebSocket.instances).toHaveLength(4); // ...while retries kept happening
    unsubscribe();
  });

  it('recovers across a server restart with a single socket chain (no zombies)', async () => {
    await mountHook();
    const first = FakeWebSocket.instances[0];
    first.emitOpen();
    first.emitSnapshot();
    expect(useKookrStore.getState().connected).toBe(true);

    first.emitClose(); // server restart
    expect(useKookrStore.getState().connected).toBe(false);

    await act(async () => {
      vi.advanceTimersByTime(FIRST_RETRY_MS);
    });
    expect(FakeWebSocket.instances).toHaveLength(2);

    const second = FakeWebSocket.instances[1];
    second.emitOpen();
    second.emitSnapshot();
    expect(useKookrStore.getState().connected).toBe(true);

    // A late close from the dead first socket must not disturb the live one
    // or spawn a rival reconnect chain.
    first.emitClose();
    expect(useKookrStore.getState().connected).toBe(true);
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('stops reconnecting after unmount, including from already-scheduled retries', async () => {
    await mountHook();
    FakeWebSocket.instances[0].emitClose(); // schedules a retry
    await unmountHook();
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('fetches /api/schedules once per connection even when snapshots rebroadcast', async () => {
    await mountHook();
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const socket = FakeWebSocket.instances[0];
    socket.emitOpen();
    socket.emitSnapshot();
    socket.emitSnapshot();
    socket.emitSnapshot();
    const scheduleCalls = fetchMock.mock.calls.filter(([url]) => url === '/api/schedules');
    expect(scheduleCalls).toHaveLength(1);

    // A reconnect is a fresh connection → one more refresh.
    socket.emitClose();
    await act(async () => {
      vi.advanceTimersByTime(FIRST_RETRY_MS);
    });
    const second = FakeWebSocket.instances[1];
    second.emitOpen();
    second.emitSnapshot();
    second.emitSnapshot();
    expect(fetchMock.mock.calls.filter(([url]) => url === '/api/schedules')).toHaveLength(2);
  });
});
