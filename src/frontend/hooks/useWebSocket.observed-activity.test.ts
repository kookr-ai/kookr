// @vitest-environment happy-dom

/**
 * hermes-fleet#15 slice 2: the `observed.snapshot` WebSocket frame must route to
 * `store.handleObservedActivity`, so the observed lane renders live. A one-line
 * dispatch case — this guards against a typo'd case label or handler name that
 * would otherwise leave the lane permanently empty while every other test stays
 * green.
 */

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useWebSocket } from './useWebSocket.js';
import { useKookrStore } from '../store/useStore.js';
import { resetBugReportRecorderForTests } from '../bug-report-recorder.js';
import type { ObservedActivitySnapshot } from '../../shared/contracts/observed-activity.js';

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  onmessage: ((event: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onclose: ((event?: { code?: number }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(): void {}
  close(): void {
    this.readyState = 3;
  }

  emitOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  emitClose(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }

  emit(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
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

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
  useKookrStore.setState({ connected: false, observedActivity: null });
});

afterEach(async () => {
  await unmountHook();
  vi.unstubAllGlobals();
  resetBugReportRecorderForTests();
});

describe('useWebSocket observed.snapshot dispatch', () => {
  it('routes an observed.snapshot frame into the store slice', async () => {
    await mountHook();
    const socket = FakeWebSocket.instances[0];
    socket.emitOpen();

    const observed: ObservedActivitySnapshot = {
      sessions: [
        {
          sessionId: 'hermes-obs-a',
          state: 'working',
          label: 'reviewing PR #1',
          receivedAt: 1000,
          firstSeen: 500,
          pulseCount: 4,
          effectiveState: 'working',
          ageMs: 800,
        },
      ],
      counters: { accepted: 4, deduped: 0, rejected: {}, lastAcceptedAt: 1000, lastRejectAt: null, startedAt: 0 },
      now: 1800,
    };

    await act(async () => {
      socket.emit({ type: 'observed.snapshot', observed });
    });

    expect(useKookrStore.getState().observedActivity).toEqual(observed);
  });

  it('clears the lane when the connection is lost, so a stale "working" never lingers', async () => {
    await mountHook();
    const socket = FakeWebSocket.instances[0];
    socket.emitOpen();
    // The connection counts as established on the first message.
    await act(async () => {
      socket.emit({
        type: 'observed.snapshot',
        observed: {
          sessions: [],
          counters: { accepted: 1, deduped: 0, rejected: {}, lastAcceptedAt: 1, lastRejectAt: null, startedAt: 0 },
          now: 1,
        },
      });
    });
    expect(useKookrStore.getState().observedActivity).not.toBeNull();

    await act(async () => {
      socket.emitClose();
    });

    expect(useKookrStore.getState().observedActivity).toBeNull();
  });
});
