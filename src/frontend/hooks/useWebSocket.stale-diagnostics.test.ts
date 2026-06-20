// @vitest-environment jsdom

/**
 * AC6 of issue #1078: ignored stale-socket events must surface as *bounded,
 * rate-limited* diagnostics. The controller already drops zombie events; this
 * verifies the hook coalesces a burst of them into a single telemetry event
 * per window rather than one event per zombie callback.
 */

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { useWebSocket } from './useWebSocket.js';
import { useKookrStore } from '../store/useStore.js';
import { track } from '../telemetry.js';

vi.mock('../telemetry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../telemetry.js')>();
  return { ...actual, track: vi.fn() };
});

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

// Safely above the max jittered first-retry delay (DEFAULT_BACKOFF
// initialDelayMs 1000ms ±20% → ≤1200ms), and well under the 10s stale window.
const FIRST_RETRY_MS = 2_000;
// Matches STALE_TELEMETRY_WINDOW_MS in useWebSocket.ts.
const STALE_WINDOW_MS = 10_000;

function staleEventCalls(): unknown[] {
  return (track as unknown as Mock).mock.calls
    .map((args) => args[0])
    .filter((event): event is { type: string } =>
      typeof event === 'object' && event !== null && (event as { type?: unknown }).type === 'websocket_stale_event');
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
  (track as unknown as Mock).mockClear();
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
    json: () => Promise.resolve({ revision: 0, schedules: [], status: undefined }),
  })));
  useKookrStore.setState({ connected: false });
});

afterEach(async () => {
  if (root) {
    const current = root;
    root = null;
    await act(async () => { current.unmount(); });
  }
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('useWebSocket stale-socket diagnostics', () => {
  it('coalesces a burst of stale zombie events into a single rate-limited telemetry event', async () => {
    await mountHook();
    const first = FakeWebSocket.instances[0];
    first.emitOpen();
    first.emitSnapshot();
    first.emitClose(); // real disconnect → schedules a reconnect

    await act(async () => { vi.advanceTimersByTime(FIRST_RETRY_MS); });
    const second = FakeWebSocket.instances[1];
    second.emitOpen();
    second.emitSnapshot();

    // The dead first socket keeps firing zombie callbacks. Fake timers freeze
    // Date.now(), so the whole burst falls inside one rate-limit window.
    await act(async () => {
      for (let i = 0; i < 12; i += 1) {
        first.emitSnapshot(); // stale message
        first.emitClose();    // stale close
      }
    });

    // Many zombie events, but diagnostics are bounded to a single telemetry
    // event for the window — emitted leading-edge on the first stale event, so
    // it carries the count as of that moment (one stale message).
    const calls = staleEventCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ type: 'websocket_stale_event', staleMessageCount: 1 });
  });

  it('emits again in a later window carrying the cumulative tally (rate-limited, not one-shot)', async () => {
    await mountHook();
    const first = FakeWebSocket.instances[0];
    first.emitOpen();
    first.emitSnapshot();
    first.emitClose(); // real disconnect → schedules a reconnect

    await act(async () => { vi.advanceTimersByTime(FIRST_RETRY_MS); });
    const second = FakeWebSocket.instances[1];
    second.emitOpen();
    second.emitSnapshot();

    // Window 1: a burst of zombie events. Only one emission (leading edge); the
    // rest of the counts accumulate but are not flushed yet.
    await act(async () => {
      for (let i = 0; i < 12; i += 1) {
        first.emitSnapshot(); // stale message
        first.emitClose();    // stale close
      }
    });
    expect(staleEventCalls()).toHaveLength(1);

    // Advance past the window; the next stale event opens a fresh emission that
    // now carries the full cumulative tally (12 messages + 12 closes from the
    // burst, plus this triggering 13th stale message).
    await act(async () => { vi.advanceTimersByTime(STALE_WINDOW_MS + 1); });
    await act(async () => { first.emitSnapshot(); });

    const calls = staleEventCalls();
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ staleMessageCount: 13, staleCloseCount: 12, staleErrorCount: 0 });
  });

  it('does not emit stale diagnostics on a clean single-connection lifecycle', async () => {
    await mountHook();
    const socket = FakeWebSocket.instances[0];
    socket.emitOpen();
    socket.emitSnapshot();
    socket.emitSnapshot();
    expect(staleEventCalls()).toHaveLength(0);
  });
});
