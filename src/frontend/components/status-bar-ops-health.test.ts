// @vitest-environment jsdom

/**
 * Status-bar pills for prod smoke-tick failing streak + resourceWatchdog
 * disabled (issue #2037). Fixtures drive the store directly — the poll hook
 * is covered separately.
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

async function renderStatusBar(root: Root): Promise<void> {
  await act(async () => {
    root.render(
      React.createElement(StatusBar, {
        findings: 0,
        total: 1,
        onShowShortcuts: vi.fn(),
      }),
    );
  });
  await flush();
}

describe('StatusBar ops-health pills (issue #2037)', () => {
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

  test('hides both pills when healthy (no smoke failures, watchdog enabled)', async () => {
    useKookrStore.getState().handleOpsHealth({
      prodSmokeTick: { consecutiveFailures: 0, status: 'ok', failingChecks: [] },
      resourceWatchdog: { enabled: true, lastDecision: 'idle' },
    });

    await renderStatusBar(root);

    expect(container.querySelector('[data-testid="ops-health-pills"]')).toBeNull();
    expect(container.querySelector('[data-testid="ops-health-smoke-pill"]')).toBeNull();
    expect(container.querySelector('[data-testid="ops-health-watchdog-pill"]')).toBeNull();
    expect(container.textContent).not.toContain('Smoke: fail');
    expect(container.textContent).not.toContain('Watchdog: off');
  });

  test('hides both pills when store has no ops-health data yet', async () => {
    await renderStatusBar(root);

    expect(container.querySelector('[data-testid="ops-health-pills"]')).toBeNull();
    expect(container.textContent).not.toContain('Smoke: fail');
    expect(container.textContent).not.toContain('Watchdog: off');
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

  test('shows both pills when smoke is failing and watchdog is off', async () => {
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
});
