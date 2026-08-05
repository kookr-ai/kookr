// @vitest-environment jsdom

/**
 * Status-bar pills for prod smoke-tick failing streak + resourceWatchdog
 * disabled (issue #2037) + chronic FAA residual (issue #2082). Fixtures drive
 * the store directly — the poll hook is covered separately.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { StatusBar } from './StatusBar.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import { __resetAudioAlertLogForTests } from '../audio/audio-alert-log.js';
import { __resetSoundPreferenceForTests } from '../audio/sound.js';

function syncGlobalStore() {
  const freshState = createKookrStore().getState();
  const nextData = Object.fromEntries(
    Object.entries(freshState).filter(([, value]) => typeof value !== 'function'),
  );
  useKookrStore.setState(nextData);
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

async function renderStatusBar(root: Root, props: { onOpenCapacity?: () => void } = {}): Promise<void> {
  await act(async () => {
    root.render(
      React.createElement(StatusBar, {
        findings: 0,
        total: 1,
        onShowShortcuts: vi.fn(),
        onOpenCapacity: props.onOpenCapacity,
      }),
    );
  });
  await flush();
}

describe('StatusBar ops-health pills (issue #2037 / #2082)', () => {
  let container: HTMLDivElement;
  let root: Root;
  let localStore: Map<string, string>;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStore = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => localStore.get(key) ?? null,
      setItem: (key: string, value: string) => localStore.set(key, value),
      removeItem: (key: string) => localStore.delete(key),
      clear: () => localStore.clear(),
    });
    __resetSoundPreferenceForTests();
    __resetAudioAlertLogForTests();
    syncGlobalStore();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    __resetAudioAlertLogForTests();
    __resetSoundPreferenceForTests();
    document.body.innerHTML = '';
  });

  test('hides all pills when healthy (no smoke failures, watchdog enabled, FAA clear)', async () => {
    useKookrStore.getState().handleOpsHealth({
      prodSmokeTick: { consecutiveFailures: 0, status: 'ok', failingChecks: [] },
      resourceWatchdog: { enabled: true, lastDecision: 'idle' },
      capacityResidual: { finishedAwaitingAck: 0, oldestFinishedAwaitingAckAgeMs: null },
    });

    await renderStatusBar(root);

    expect(container.querySelector('[data-testid="ops-health-pills"]')).toBeNull();
    expect(container.querySelector('[data-testid="ops-health-smoke-pill"]')).toBeNull();
    expect(container.querySelector('[data-testid="ops-health-watchdog-pill"]')).toBeNull();
    expect(container.querySelector('[data-testid="ops-health-faa-pill"]')).toBeNull();
    expect(container.textContent).not.toContain('Smoke: fail');
    expect(container.textContent).not.toContain('Watchdog: off');
    expect(container.textContent).not.toContain('FAA residual');
  });

  test('hides all pills when store has no ops-health data yet', async () => {
    await renderStatusBar(root);

    expect(container.querySelector('[data-testid="ops-health-pills"]')).toBeNull();
    expect(container.textContent).not.toContain('Smoke: fail');
    expect(container.textContent).not.toContain('Watchdog: off');
    expect(container.textContent).not.toContain('FAA residual');
  });

  test('shows Smoke: fail×N when consecutiveFailures >= 1', async () => {
    useKookrStore.getState().handleOpsHealth({
      prodSmokeTick: {
        consecutiveFailures: 113,
        status: 'alert',
        failingChecks: ['version-probe'],
        firstFailedAt: '2026-07-28T15:45:37.810Z',
      },
      resourceWatchdog: { enabled: true },
    });

    await renderStatusBar(root);

    const smoke = container.querySelector('[data-testid="ops-health-smoke-pill"]');
    expect(smoke).not.toBeNull();
    expect(smoke?.textContent).toBe('Smoke: fail×113');
    expect(smoke?.getAttribute('title')).toContain('version-probe');
    expect(smoke?.getAttribute('title')).toContain('2026-07-28T15:45:37.810Z');
    expect(container.querySelector('[data-testid="ops-health-watchdog-pill"]')).toBeNull();
  });

  test('shows Watchdog: off when resourceWatchdog is disabled', async () => {
    useKookrStore.getState().handleOpsHealth({
      prodSmokeTick: { consecutiveFailures: 0, status: 'ok' },
      resourceWatchdog: {
        enabled: false,
        lastDecision: 'disabled',
        pressureWhileDisabled: true,
        pressureWhileDisabledReason: 'staleProcesses.dtach.count=12 ≥ soft bound 8',
      },
    });

    await renderStatusBar(root);

    const watchdog = container.querySelector('[data-testid="ops-health-watchdog-pill"]');
    expect(watchdog).not.toBeNull();
    expect(watchdog?.textContent).toBe('Watchdog: off');
    expect(watchdog?.getAttribute('title')).toContain('lastDecision=disabled');
    expect(watchdog?.getAttribute('title')).toContain('staleProcesses.dtach.count=12');
    expect(container.querySelector('[data-testid="ops-health-smoke-pill"]')).toBeNull();
  });

  test('shows both smoke and watchdog pills when both unhealthy', async () => {
    useKookrStore.getState().handleOpsHealth({
      prodSmokeTick: { consecutiveFailures: 3, status: 'alert', failingChecks: ['health'] },
      resourceWatchdog: { enabled: false, lastDecision: 'disabled' },
    });

    await renderStatusBar(root);

    expect(container.querySelector('[data-testid="ops-health-smoke-pill"]')?.textContent)
      .toBe('Smoke: fail×3');
    expect(container.querySelector('[data-testid="ops-health-watchdog-pill"]')?.textContent)
      .toBe('Watchdog: off');
  });

  test('shows FAA residual pill when count >= 3 (issue #2082)', async () => {
    useKookrStore.getState().handleOpsHealth({
      capacityResidual: {
        finishedAwaitingAck: 7,
        oldestFinishedAwaitingAckAgeMs: 9e6,
      },
    });

    await renderStatusBar(root);

    const faa = container.querySelector('[data-testid="ops-health-faa-pill"]');
    expect(faa).not.toBeNull();
    expect(faa?.textContent).toBe('FAA residual 7 · 2.5h');
    expect(faa?.getAttribute('title')).toContain('7 tasks finished');
    expect(faa?.getAttribute('title')).toContain('2.5h');
  });

  test('hides FAA residual pill when residual is below thresholds', async () => {
    useKookrStore.getState().handleOpsHealth({
      capacityResidual: {
        finishedAwaitingAck: 2,
        oldestFinishedAwaitingAckAgeMs: 10 * 60_000,
      },
    });

    await renderStatusBar(root);

    expect(container.querySelector('[data-testid="ops-health-faa-pill"]')).toBeNull();
    expect(container.textContent).not.toContain('FAA residual');
  });

  test('shows FAA residual pill when oldest age >= 30m with small count', async () => {
    useKookrStore.getState().handleOpsHealth({
      capacityResidual: {
        finishedAwaitingAck: 1,
        oldestFinishedAwaitingAckAgeMs: 45 * 60_000,
      },
    });

    await renderStatusBar(root);

    expect(container.querySelector('[data-testid="ops-health-faa-pill"]')?.textContent)
      .toBe('FAA residual 1 · 45m');
  });

  test('FAA residual pill click invokes onOpenCapacity (capacity settings deep-link)', async () => {
    const onOpenCapacity = vi.fn();
    useKookrStore.getState().handleOpsHealth({
      capacityResidual: {
        finishedAwaitingAck: 3,
        oldestFinishedAwaitingAckAgeMs: null,
      },
    });

    await renderStatusBar(root, { onOpenCapacity });

    const faa = container.querySelector('[data-testid="ops-health-faa-pill"]');
    expect(faa?.tagName).toBe('BUTTON');
    await act(async () => {
      (faa as HTMLButtonElement).click();
    });
    expect(onOpenCapacity).toHaveBeenCalledOnce();
  });
});
