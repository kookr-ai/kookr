// @vitest-environment jsdom

/**
 * Status-bar pills for prod smoke-tick failing streak + resourceWatchdog
 * disabled (issue #2037) + chronic FAA residual (issue #2082) + launch
 * dependency degradation (issue #2364) + fail-closed paused schedules
 * (issue #2432) + overdue lifecycle timers (issue #2643). Fixtures drive
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

async function renderStatusBar(
  root: Root,
  props: { onOpenCapacity?: () => void; onOpenDiagnostics?: () => void } = {},
): Promise<void> {
  await act(async () => {
    root.render(
      React.createElement(StatusBar, {
        findings: 0,
        total: 1,
        onShowShortcuts: vi.fn(),
        onOpenCapacity: props.onOpenCapacity,
        onOpenDiagnostics: props.onOpenDiagnostics,
      }),
    );
  });
  await flush();
}

describe('StatusBar ops-health pills (issue #2037 / #2082 / #2364 / #2432 / #2643)', () => {
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

  test('hides all pills when healthy (no smoke failures, watchdog enabled, FAA clear, deps clear, no paused schedules, no overdue timers)', async () => {
    useKookrStore.getState().handleOpsHealth({
      prodSmokeTick: { consecutiveFailures: 0, status: 'ok', failingChecks: [] },
      resourceWatchdog: { enabled: true, lastDecision: 'idle' },
      capacityResidual: { finishedAwaitingAck: 0, oldestFinishedAwaitingAckAgeMs: null },
      launchDependencies: { totalDegradedTasks: 0, totalFindings: 0, dependencies: [] },
      pausedSchedules: { schedulesPausedByFailure: [] },
      timerHealth: { overdue: 0, oldestName: null },
    });

    await renderStatusBar(root);

    expect(container.querySelector('[data-testid="ops-health-pills"]')).toBeNull();
    expect(container.querySelector('[data-testid="ops-health-smoke-pill"]')).toBeNull();
    expect(container.querySelector('[data-testid="ops-health-watchdog-pill"]')).toBeNull();
    expect(container.querySelector('[data-testid="ops-health-faa-pill"]')).toBeNull();
    expect(container.querySelector('[data-testid="ops-health-launch-deps-pill"]')).toBeNull();
    expect(container.querySelector('[data-testid="ops-health-paused-schedules-pill"]')).toBeNull();
    expect(container.querySelector('[data-testid="ops-health-timer-overdue-pill"]')).toBeNull();
    expect(container.textContent).not.toContain('Smoke: fail');
    expect(container.textContent).not.toContain('Watchdog: off');
    expect(container.textContent).not.toContain('FAA residual');
    expect(container.textContent).not.toContain('Deps:');
    expect(container.textContent).not.toContain('schedule paused');
    expect(container.textContent).not.toContain('timer overdue');
  });

  test('hides all pills when store has no ops-health data yet', async () => {
    await renderStatusBar(root);

    expect(container.querySelector('[data-testid="ops-health-pills"]')).toBeNull();
    expect(container.textContent).not.toContain('Smoke: fail');
    expect(container.textContent).not.toContain('Watchdog: off');
    expect(container.textContent).not.toContain('FAA residual');
    expect(container.textContent).not.toContain('Deps:');
    expect(container.textContent).not.toContain('schedule paused');
    expect(container.textContent).not.toContain('timer overdue');
    expect(container.querySelector('[data-testid="ops-health-timer-overdue-pill"]')).toBeNull();
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
    expect(container.querySelector('[data-testid="ops-health-paused-schedules-pill"]')).toBeNull();
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

  test('hides launch-deps pill when totalDegradedTasks === 0 (issue #2364)', async () => {
    useKookrStore.getState().handleOpsHealth({
      launchDependencies: {
        totalDegradedTasks: 0,
        totalFindings: 0,
        dependencies: [],
      },
    });

    await renderStatusBar(root);

    expect(container.querySelector('[data-testid="ops-health-launch-deps-pill"]')).toBeNull();
    expect(container.textContent).not.toContain('Deps:');
  });

  test('shows the launch-deps pill for parked work even without degraded launch history (issue #2841)', async () => {
    useKookrStore.getState().handleOpsHealth({
      launchDependencies: {
        totalDegradedTasks: 0,
        totalFindings: 0,
        dependencies: [],
        parkedTaskCount: 2,
        parkedByDependency: [{
          dependency: 'kb',
          taskCount: 2,
          reasons: ['dependency_degraded'],
        }],
      },
    });

    await renderStatusBar(root);

    const pill = container.querySelector('[data-testid="ops-health-launch-deps-pill"]');
    expect(pill?.textContent).toBe('Deps: 0 · Parked: kb×2');
    expect(pill?.getAttribute('title')).toContain('2 tasks parked awaiting dependency recovery');
    expect(pill?.getAttribute('title')).toContain('kb=2 (dependency_degraded)');
  });

  test('shows Deps: kb×N when launch dependencies are degraded (issue #2364)', async () => {
    useKookrStore.getState().handleOpsHealth({
      launchDependencies: {
        totalDegradedTasks: 8,
        totalFindings: 9,
        dependencies: [
          { dependency: 'kb', degradedTaskCount: 8, categories: ['provider_api'] },
        ],
      },
    });

    await renderStatusBar(root);

    const pill = container.querySelector('[data-testid="ops-health-launch-deps-pill"]');
    expect(pill).not.toBeNull();
    expect(pill?.textContent).toBe('Deps: kb×8');
    expect(pill?.getAttribute('title')).toContain('8 tasks launched with degraded dependencies');
    expect(pill?.getAttribute('title')).toContain('kb=8 (provider_api)');
    expect(pill?.getAttribute('title')).toContain('GET /api/health.launchDependencies');
  });

  test('shows multi-dependency segments and +N overflow on launch-deps pill (issue #2364)', async () => {
    useKookrStore.getState().handleOpsHealth({
      launchDependencies: {
        totalDegradedTasks: 6,
        totalFindings: 7,
        dependencies: [
          { dependency: 'kb', degradedTaskCount: 3, categories: ['provider_api'] },
          { dependency: 'gh', degradedTaskCount: 2, categories: ['auth'] },
          { dependency: 'tts', degradedTaskCount: 1, categories: ['binary'] },
        ],
      },
    });

    await renderStatusBar(root);

    const pill = container.querySelector('[data-testid="ops-health-launch-deps-pill"]');
    expect(pill?.textContent).toBe('Deps: kb×3 · gh×2 +1');
    expect(pill?.getAttribute('title')).toContain('tts=1 (binary)');
  });

  test('hides paused-schedules pill when the array is empty (issue #2432)', async () => {
    useKookrStore.getState().handleOpsHealth({
      pausedSchedules: { schedulesPausedByFailure: [] },
    });

    await renderStatusBar(root);

    expect(container.querySelector('[data-testid="ops-health-paused-schedules-pill"]')).toBeNull();
    expect(container.textContent).not.toContain('schedule paused');
  });

  test('shows N schedules paused when fail-closed pauses exist (issue #2432)', async () => {
    useKookrStore.getState().handleOpsHealth({
      pausedSchedules: {
        schedulesPausedByFailure: [
          { id: 's1', name: 'orchestrator', consecutiveFailures: 30 },
          { id: 's2', name: 'deploy-conv', consecutiveFailures: 55 },
        ],
      },
    });

    await renderStatusBar(root);

    const pill = container.querySelector('[data-testid="ops-health-paused-schedules-pill"]');
    expect(pill).not.toBeNull();
    expect(pill?.textContent).toBe('2 schedules paused');
    expect(pill?.getAttribute('title')).toContain('2 schedules paused after consecutive failures');
    expect(pill?.getAttribute('title')).toContain('orchestrator (fail×30)');
    expect(pill?.getAttribute('title')).toContain('GET /api/health.schedules');
    expect(container.querySelector('[data-testid="ops-health-smoke-pill"]')).toBeNull();
    expect(container.querySelector('[data-testid="ops-health-watchdog-pill"]')).toBeNull();
    expect(container.querySelector('[data-testid="ops-health-faa-pill"]')).toBeNull();
    expect(container.querySelector('[data-testid="ops-health-launch-deps-pill"]')).toBeNull();
  });

  test('shows singular 1 schedule paused without disturbing other pills (issue #2432)', async () => {
    useKookrStore.getState().handleOpsHealth({
      prodSmokeTick: { consecutiveFailures: 2, status: 'alert', failingChecks: ['health'] },
      pausedSchedules: {
        schedulesPausedByFailure: [
          { id: 's1', name: 'orchestrator', consecutiveFailures: 3 },
        ],
      },
    });

    await renderStatusBar(root);

    expect(container.querySelector('[data-testid="ops-health-paused-schedules-pill"]')?.textContent)
      .toBe('1 schedule paused');
    expect(container.querySelector('[data-testid="ops-health-smoke-pill"]')?.textContent)
      .toBe('Smoke: fail×2');
    expect(container.querySelector('[data-testid="ops-health-watchdog-pill"]')).toBeNull();
  });

  test('hides the timer-overdue pill when overdue is 0 (issue #2643)', async () => {
    useKookrStore.getState().handleOpsHealth({
      timerHealth: { overdue: 0, oldestName: 'save' },
    });

    await renderStatusBar(root);

    expect(container.querySelector('[data-testid="ops-health-timer-overdue-pill"]')).toBeNull();
    expect(container.textContent).not.toContain('timer overdue');
  });

  test('hides the timer-overdue pill when the health block is missing (issue #2643)', async () => {
    useKookrStore.getState().handleOpsHealth({
      timerHealth: null,
    });

    await renderStatusBar(root);

    expect(container.querySelector('[data-testid="ops-health-timer-overdue-pill"]')).toBeNull();
    expect(container.textContent).not.toContain('timer overdue');
  });

  test('shows the timer-overdue pill with count and oldest name (issue #2643)', async () => {
    useKookrStore.getState().handleOpsHealth({
      timerHealth: { overdue: 2, oldestName: 'maintenancePrune' },
    });

    await renderStatusBar(root);

    const pill = container.querySelector('[data-testid="ops-health-timer-overdue-pill"]');
    expect(pill).not.toBeNull();
    expect(pill?.tagName).toBe('SPAN');
    expect(pill?.getAttribute('role')).toBe('status');
    expect(pill?.textContent).toBe('2 timers overdue · maintenancePrune');
    expect(pill?.getAttribute('title')).toContain('2 lifecycle timers overdue');
    expect(pill?.getAttribute('title')).toContain('oldest maintenancePrune');
    expect(pill?.getAttribute('title')).toContain('A safety-net loop stopped ticking');
    expect(pill?.getAttribute('title')).toContain('GET /api/health.timerHealth');
    expect(container.querySelector('[data-testid="ops-health-smoke-pill"]')).toBeNull();
  });

  test('timer-overdue pill click opens Diagnostics (issue #2643)', async () => {
    const onOpenDiagnostics = vi.fn();
    useKookrStore.getState().handleOpsHealth({
      timerHealth: { overdue: 1, oldestName: 'deployLagDetector' },
    });

    await renderStatusBar(root, { onOpenDiagnostics });

    const pill = container.querySelector('[data-testid="ops-health-timer-overdue-pill"]');
    expect(pill?.tagName).toBe('BUTTON');
    expect(pill?.textContent).toBe('1 timer overdue · deployLagDetector');
    await act(async () => {
      (pill as HTMLButtonElement).click();
    });
    expect(onOpenDiagnostics).toHaveBeenCalledOnce();
  });
});
