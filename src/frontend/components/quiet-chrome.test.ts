// @vitest-environment jsdom

/**
 * Quiet chrome (issue #3561 slice 2). Acceptance:
 * - no permanent red chrome at rest: bypass mode is a neutral chip, not a banner;
 * - the build hash moves from the top bar into the System detail ("About");
 * - the status bar keeps counts, spend and quota; the other readouts sit
 *   behind the System indicator, which turns amber when one of them is degraded.
 * The "Abort all" menu + confirmation is covered in FindingsPanel.abort.test.ts.
 */

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { TopBar } from './TopBar.js';
import { StatusBar } from './StatusBar.js';
import { systemAttentionReasons } from './SystemStatusDetails.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import { __resetAudioAlertLogForTests } from '../audio/audio-alert-log.js';
import { __resetSoundPreferenceForTests } from '../audio/sound.js';
import type { SystemResourceStatus } from '../../shared/protocol.js';

function syncGlobalStore() {
  const freshState = createKookrStore().getState();
  const nextData = Object.fromEntries(
    Object.entries(freshState).filter(([, value]) => typeof value !== 'function'),
  );
  useKookrStore.setState(nextData);
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function resources(overrides: { cpu?: number; loopMs?: number } = {}): SystemResourceStatus {
  return {
    source: { kind: 'server-host' },
    sampledAt: new Date().toISOString(),
    sampleGapMs: 2_000,
    timerDriftMs: 0,
    host: {
      cpuUsagePercent: overrides.cpu ?? 42,
      memoryUsedPercent: 50,
      memoryFreeBytes: 6_000_000_000,
      memoryTotalBytes: 12_000_000_000,
      dataDirectory: {
        path: '/tmp/kookr-data',
        diskFreeBytes: 50_000_000_000,
        diskTotalBytes: 100_000_000_000,
        diskFreePercent: 50,
      },
    },
    server: {
      eventLoopDelayP95Ms: overrides.loopMs ?? 10,
      processRssBytes: 160_000_000,
      processHeapUsedBytes: 70_000_000,
      processHeapTotalBytes: 100_000_000,
    },
    unavailable: [],
  } as SystemResourceStatus;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  document.body.innerHTML = '';
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear(),
  });
  // Every poll (deploy status, toolkit, time to unblock, live friction,
  // outcome ledger) gets an empty, well-formed answer.
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }) as Response));
  __resetSoundPreferenceForTests();
  __resetAudioAlertLogForTests();
  syncGlobalStore();
  useKookrStore.setState({
    connected: true,
    buildInfo: {
      commitHash: 'abc123def4567890abc123def4567890abc123de',
      commitShort: 'abc123d',
      branch: 'main',
      buildTimestamp: '2026-05-29T12:00:00.000Z',
      version: '1.2.3',
    },
    serverStartedAt: '2026-05-29T12:00:00.000Z',
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function renderTopBar(): Promise<void> {
  act(() => {
    root.render(
      React.createElement(TopBar, {
        findings: 0,
        currentIndex: -1,
        totalFindings: 0,
        onLaunch: vi.fn(),
        onCommandPalette: vi.fn(),
        onOpenPluginManager: vi.fn(),
        onOperations: vi.fn(),
        onCoordinatorFindings: vi.fn(),
        onTerminalFocusToggle: vi.fn(),
      }),
    );
  });
  await flush();
}

function systemButton(): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>('[data-testid="system-indicator"]');
  expect(button).not.toBeNull();
  return button!;
}

async function openSystem(): Promise<HTMLElement> {
  await act(async () => {
    systemButton().click();
  });
  await flush();
  const popover = container.querySelector<HTMLElement>('#system-popover');
  expect(popover).not.toBeNull();
  return popover!;
}

describe('TopBar: mode chip instead of the bypass banner', () => {
  test('bypass mode shows a quiet "Bypass mode" chip that explains itself', async () => {
    useKookrStore.setState({ bypassAllPermissions: true });
    await renderTopBar();

    const chip = container.querySelector<HTMLElement>('[data-testid="permission-mode-chip"]');
    expect(chip?.textContent).toBe('Bypass mode');
    expect(chip?.className).toBe('mode-chip');
    expect(chip?.getAttribute('title')).toContain('without permission prompts');
  });

  test('no chip when bypass mode is off', async () => {
    useKookrStore.setState({ bypassAllPermissions: false });
    await renderTopBar();
    expect(container.querySelector('[data-testid="permission-mode-chip"]')).toBeNull();
  });
});

describe('TopBar: System indicator and About', () => {
  test('the build hash is not in the top bar at rest; System keeps the connection dot', async () => {
    await renderTopBar();

    const topbar = container.querySelector('.topbar');
    expect(topbar?.textContent).not.toContain('abc123d');
    expect(topbar?.textContent).not.toContain('DEV');
    expect(systemButton().textContent).toContain('System');
    expect(systemButton().querySelector('.health-dot-connected')).not.toBeNull();
    expect(systemButton().getAttribute('aria-expanded')).toBe('false');
  });

  test('opening System shows the status detail, then About with the build', async () => {
    await renderTopBar();
    const popover = await openSystem();

    expect(systemButton().getAttribute('aria-expanded')).toBe('true');
    const headings = Array.from(popover.querySelectorAll('.system-popover-heading')).map((h) => h.textContent);
    expect(headings).toEqual(['Status', 'About']);
    expect(popover.querySelector('[data-testid="system-status-details"]')).not.toBeNull();
    expect(popover.textContent).toContain('abc123def4567890');
    expect(popover.textContent).toContain('1.2.3');
  });

  test('clicking System again closes it (the trigger is not an "outside" click)', async () => {
    await renderTopBar();
    await openSystem();
    await act(async () => {
      systemButton().dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      systemButton().click();
    });
    expect(container.querySelector('#system-popover')).toBeNull();
  });

  test('Escape closes the System detail', async () => {
    await renderTopBar();
    await openSystem();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(container.querySelector('#system-popover')).toBeNull();
  });

  test('a degraded hidden readout turns the indicator amber and names it', async () => {
    useKookrStore.setState({
      prodSmokeTick: { consecutiveFailures: 2, failingChecks: ['health'], firstFailedAt: null } as never,
    });
    await renderTopBar();

    expect(systemButton().classList.contains('needs-attention')).toBe(true);
    expect(systemButton().querySelector('.system-attention-dot')).not.toBeNull();
    expect(systemButton().getAttribute('aria-label')).toContain('prod smoke tick failing');

    const popover = await openSystem();
    expect(popover.querySelector('[data-testid="system-attention-summary"]')?.textContent)
      .toContain('prod smoke tick failing');
    expect(popover.querySelector('[data-testid="ops-health-smoke-pill"]')?.textContent).toBe('Smoke: fail×2');
  });

  test('the default watchdog-off state stays a passive readout, not an amber dot', async () => {
    useKookrStore.setState({ resourceWatchdog: { enabled: false, pressureWhileDisabled: false } as never });
    await renderTopBar();
    expect(systemButton().classList.contains('needs-attention')).toBe(false);

    const popover = await openSystem();
    expect(popover.querySelector('[data-testid="ops-health-watchdog-pill"]')?.textContent).toBe('Watchdog: off');
    expect(popover.querySelector('[data-testid="system-attention-summary"]')).toBeNull();
  });

  test('a healthy system shows no attention dot', async () => {
    useKookrStore.setState({ resourceStatus: resources(), resourceStatusReceivedAtMs: Date.now() });
    await renderTopBar();
    expect(systemButton().classList.contains('needs-attention')).toBe(false);
    expect(systemButton().querySelector('.system-attention-dot')).toBeNull();
  });
});

describe('StatusBar: counts, spend and quota only', () => {
  test('at rest the bar shows the counts and quota but none of the moved readouts', async () => {
    useKookrStore.setState({
      resourceStatus: resources({ loopMs: 600 }),
      resourceStatusReceivedAtMs: Date.now(),
      prodSmokeTick: { consecutiveFailures: 3, failingChecks: [], firstFailedAt: null } as never,
      sttUrl: 'http://stt.local',
      quotaStatus: {
        fiveHour: { utilization: 14, resetsAt: new Date(Date.now() + 3_600_000).toISOString() },
        sevenDay: { utilization: 27, resetsAt: new Date(Date.now() + 86_400_000).toISOString() },
        updatedAt: Date.now(),
      },
    });
    act(() => {
      root.render(React.createElement(StatusBar, { findings: 1, total: 3, onShowShortcuts: vi.fn() }));
    });
    await flush();

    const bar = container.querySelector('.statusbar');
    expect(bar?.textContent).toContain('3 tasks · 1 finding');
    expect(bar?.querySelector('[data-testid="statusbar-spend-quota"] .quota-display')).not.toBeNull();
    for (const moved of [
      '.resource-status',
      '[data-testid="ops-health-pills"]',
      '.stt-status-pill',
      '.btn-sound-toggle',
      '.btn-trophy',
      '[data-testid="time-to-unblock-chip"]',
      '[data-testid="live-friction-chip"]',
    ]) {
      expect(bar?.querySelector(moved), moved).toBeNull();
    }
  });
});

describe('systemAttentionReasons', () => {
  test('a healthy system has no reasons', () => {
    expect(systemAttentionReasons({ resourceStatus: resources() })).toEqual([]);
    expect(systemAttentionReasons({})).toEqual([]);
  });

  test.each([
    ['prod smoke tick failing', { prodSmokeTick: { consecutiveFailures: 1 } }],
    ['host pressure while the resource watchdog is off', { resourceWatchdog: { enabled: false, pressureWhileDisabled: true } }],
    ['finished tasks holding capacity', { capacityResidual: { finishedAwaitingAck: 3, oldestFinishedAwaitingAckAgeMs: null } }],
    ['schedules paused', { pausedSchedules: { schedulesPausedByFailure: [{ name: 'nightly' }] } }],
    ['CPU high', { resourceStatus: resources({ cpu: 90 }) }],
    ['server event loop slow', { resourceStatus: resources({ loopMs: 200 }) }],
  ])('raises "%s"', (reason, input) => {
    expect(systemAttentionReasons(input as never)).toContain(reason);
  });

  test('below the thresholds nothing is raised', () => {
    expect(systemAttentionReasons({
      prodSmokeTick: { consecutiveFailures: 0 } as never,
      resourceWatchdog: { enabled: true } as never,
      capacityResidual: { finishedAwaitingAck: 1, oldestFinishedAwaitingAckAgeMs: 60_000 } as never,
      resourceStatus: resources({ cpu: 80, loopMs: 100 }),
    })).toEqual([]);
  });

  test('the watchdog being off is the default, not a reason by itself', () => {
    expect(systemAttentionReasons({ resourceWatchdog: { enabled: false } as never })).toEqual([]);
    expect(systemAttentionReasons({
      resourceWatchdog: { enabled: false, pressureWhileDisabled: false } as never,
    })).toEqual([]);
  });

  test('a stale resource sample raises nothing', () => {
    expect(systemAttentionReasons({ resourceStatus: resources({ cpu: 99 }), resourceStale: true })).toEqual([]);
  });
});
