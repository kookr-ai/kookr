// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import React from 'react';
import { useOpsHealthPoll } from './useOpsHealthPoll.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';

function syncGlobalStore() {
  const freshState = createKookrStore().getState();
  const nextData = Object.fromEntries(
    Object.entries(freshState).filter(([, value]) => typeof value !== 'function'),
  );
  useKookrStore.setState(nextData);
}

function PollHarness({ intervalMs = 0 }: { intervalMs?: number }) {
  useOpsHealthPoll(intervalMs);
  return null;
}

describe('useOpsHealthPoll', () => {
  let container: HTMLDivElement;
  let root: Root;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    syncGlobalStore();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  test('parses /api/health smoke + watchdog into the store', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 'ok',
        prodSmokeTick: {
          schemaVersion: 'prod-smoke-tick.v1',
          status: 'alert',
          consecutiveFailures: 7,
          failingChecks: ['version-probe'],
          generatedAt: '2026-08-04T00:00:00.000Z',
          firstFailedAt: '2026-08-03T17:00:00.000Z',
        },
        resourceWatchdog: {
          enabled: false,
          lastDecision: 'disabled',
          pressureWhileDisabled: false,
          pressureWhileDisabledReason: null,
        },
      }),
    });

    await act(async () => {
      root.render(React.createElement(PollHarness, { intervalMs: 0 }));
    });
    // Allow the async poll to settle.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/health', { cache: 'no-store' });
    expect(useKookrStore.getState().prodSmokeTick).toEqual({
      consecutiveFailures: 7,
      status: 'alert',
      failingChecks: ['version-probe'],
      generatedAt: '2026-08-04T00:00:00.000Z',
      firstFailedAt: '2026-08-03T17:00:00.000Z',
    });
    expect(useKookrStore.getState().resourceWatchdog).toEqual({
      enabled: false,
      lastDecision: 'disabled',
      pressureWhileDisabled: false,
      pressureWhileDisabledReason: null,
    });
  });

  test('soft-fails on network error without throwing', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));

    await act(async () => {
      root.render(React.createElement(PollHarness, { intervalMs: 0 }));
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(useKookrStore.getState().prodSmokeTick).toBeNull();
    expect(useKookrStore.getState().resourceWatchdog).toBeNull();
  });
});
