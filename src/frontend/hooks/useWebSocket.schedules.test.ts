// @vitest-environment jsdom

/**
 * Issue #2818: the two WebSocket schedule-refresh lifecycle points (first
 * snapshot per connection and 'scheduleFired') must go through the typed
 * listSchedules() API instead of a raw /api/schedules fetch, while preserving
 * the once-per-connection timing, the per-fire refresh, and best-effort
 * failure handling that never replaces newer schedule state with stale data.
 */

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listSchedulesMock = vi.hoisted(() => vi.fn());
vi.mock('../schedule-api.js', () => ({ listSchedules: listSchedulesMock }));

import { useWebSocket } from './useWebSocket.js';
import { useKookrStore } from '../store/useStore.js';
import { resetBugReportRecorderForTests } from '../bug-report-recorder.js';
import type { ScheduleListResponse, ScheduleResponse } from '../../shared/protocol.js';

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

  emitSnapshot(): void {
    this.onmessage?.({ data: JSON.stringify({ type: 'snapshot', agents: [], serverCwd: '/repo' }) });
  }

  emitScheduleFired(): void {
    this.onmessage?.({ data: JSON.stringify({ type: 'scheduleFired' }) });
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

const FIRST_RETRY_MS = 2_000;
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

function scheduleResponse(revision: number): ScheduleListResponse {
  // Distinctive per-revision payload so an assertion catches a dropped or
  // garbled `schedules`/`status` write, not just the revision number.
  return {
    revision,
    schedules: [{ id: `sched-${revision}` } as unknown as ScheduleResponse],
    status: {
      timezone: 'UTC',
      catchUpMode: 'off',
      catchUpEnabled: false,
      schedulerHealthy: true,
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
  listSchedulesMock.mockReset();
  listSchedulesMock.mockResolvedValue(scheduleResponse(1));
  useKookrStore.setState({ connected: false, scheduleRevision: 0 });
});

afterEach(async () => {
  await unmountHook();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  resetBugReportRecorderForTests();
});

describe('useWebSocket schedule refresh via typed API', () => {
  it('refreshes schedules through listSchedules() once per connection, not a raw fetch', async () => {
    await mountHook();
    const socket = FakeWebSocket.instances[0];
    socket.emitOpen();
    socket.emitSnapshot();
    socket.emitSnapshot();
    socket.emitSnapshot();
    expect(listSchedulesMock).toHaveBeenCalledTimes(1);

    // A reconnect is a fresh connection → exactly one more refresh.
    socket.emitClose();
    await act(async () => {
      vi.advanceTimersByTime(FIRST_RETRY_MS);
    });
    const second = FakeWebSocket.instances[1];
    second.emitOpen();
    second.emitSnapshot();
    second.emitSnapshot();
    expect(listSchedulesMock).toHaveBeenCalledTimes(2);
  });

  it('refreshes schedules through listSchedules() on every scheduleFired message', async () => {
    await mountHook();
    const socket = FakeWebSocket.instances[0];
    socket.emitOpen();
    socket.emitSnapshot();
    expect(listSchedulesMock).toHaveBeenCalledTimes(1); // snapshot refresh

    socket.emitScheduleFired();
    socket.emitScheduleFired();
    expect(listSchedulesMock).toHaveBeenCalledTimes(3); // + one per fire
  });

  it('applies the full resolved schedule payload to the store', async () => {
    listSchedulesMock.mockResolvedValue(scheduleResponse(5));
    await mountHook();
    const socket = FakeWebSocket.instances[0];
    socket.emitOpen();
    socket.emitSnapshot();
    await act(async () => {
      await Promise.resolve();
    });
    expect(useKookrStore.getState()).toMatchObject({
      scheduleRevision: 5,
      schedules: [{ id: 'sched-5' }],
      scheduleStatus: { timezone: 'UTC', schedulerHealthy: true },
    });
  });

  it('discards a stale successful resolve that predates newer pushed state', async () => {
    // The store's revision guard is the mechanism this refactor relies on to
    // keep an in-flight HTTP refresh from clobbering newer pushed state: a
    // 'schedules' message already advanced the store to revision 9 when an
    // earlier listSchedules() call resolves with the older revision 3.
    useKookrStore.setState({ scheduleRevision: 9, schedules: [], scheduleStatus: undefined });
    listSchedulesMock.mockResolvedValue(scheduleResponse(3));
    await mountHook();
    const socket = FakeWebSocket.instances[0];
    socket.emitOpen();
    socket.emitSnapshot();
    await act(async () => {
      await Promise.resolve();
    });
    expect(useKookrStore.getState().scheduleRevision).toBe(9);
    expect(useKookrStore.getState().schedules).toEqual([]);
  });

  it('swallows a listSchedules() rejection without throwing or clobbering state', async () => {
    useKookrStore.setState({ scheduleRevision: 9 });
    listSchedulesMock.mockRejectedValue(new Error('network'));
    await mountHook();
    const socket = FakeWebSocket.instances[0];
    socket.emitOpen();
    socket.emitSnapshot();
    await act(async () => {
      await Promise.resolve();
    });
    // Failure is best-effort: the newer revision already in the store is kept.
    expect(useKookrStore.getState().scheduleRevision).toBe(9);
  });
});
