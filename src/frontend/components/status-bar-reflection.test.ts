// @vitest-environment jsdom

import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { StatusBar } from './StatusBar.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import { __resetAudioAlertLogForTests, recordAudioAlertDecision } from '../audio/audio-alert-log.js';
import { __resetSoundPreferenceForTests } from '../audio/sound.js';
import { TIME_TO_UNBLOCK_MIN_SAMPLES } from '../../shared/contracts/time-to-unblock.js';

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

describe('StatusBar reflection prompt', () => {
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
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      json: async () => ({}),
    })));
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
    vi.unstubAllGlobals();
  });

  test('renders reflection suggestion with actions', async () => {
    const onReflect = vi.fn();
    const onDismissReflection = vi.fn();

    await act(async () => {
      root.render(
        React.createElement(StatusBar, {
          findings: 0,
          total: 2,
          onShowShortcuts: vi.fn(),
          reflectionSuggestion: {
            sessionLabel: '09:00-09:45',
            summary: 'Session had 5 interventions and 2 friction signals.',
            totalInterventions: 5,
            totalFindings: 2,
          },
          onReflect,
          onDismissReflection,
        }),
      );
    });
    await flush();

    expect(container.textContent).toContain('Reflect on 09:00-09:45');
    expect(container.textContent).toContain('5 interventions');

    const buttons = Array.from(container.querySelectorAll('button'));
    const reflectButton = buttons.find((button) => button.textContent === 'Reflect');
    const dismissButton = buttons.find((button) => button.textContent === 'Dismiss');

    await act(async () => {
      reflectButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      dismissButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onReflect).toHaveBeenCalledTimes(1);
    expect(onDismissReflection).toHaveBeenCalledTimes(1);
  });

  test('sound toggle title includes the last alert decision', async () => {
    recordAudioAlertDecision({
      id: 'decision-1',
      timestamp: new Date().toISOString(),
      source: 'manual_test',
      outcome: 'suppressed_muted',
      reason: 'sound disabled',
      soundEnabled: false,
      audioVolume: 1,
      chimeSound: 'classic',
      soundStateSource: 'localStorage',
      soundStorageAvailable: true,
      dndEnabled: false,
      dndExpiresAt: null,
      pageVisibility: 'visible',
      documentHasFocus: true,
      clientSessionId: 'session-1',
      clientTabId: 'tab-1',
    });

    await act(async () => {
      root.render(
        React.createElement(StatusBar, {
          findings: 0,
          total: 2,
          onShowShortcuts: vi.fn(),
        }),
      );
    });
    await flush();

    const soundButton = container.querySelector('.btn-sound-toggle');
    expect(soundButton?.getAttribute('title')).toContain('Last alert: manual_test -> suppressed_muted');
    expect(soundButton?.getAttribute('title')).toContain('sound disabled');
  });

  test('renders resource status with keyboard accessible detail', async () => {
    useKookrStore.getState().handleResourceStatus({
      source: { kind: 'server-host' },
      sampledAt: new Date().toISOString(),
      sampleGapMs: 2_000,
      timerDriftMs: 15,
      host: {
        cpuUsagePercent: 42,
        memoryUsedPercent: 68,
        memoryFreeBytes: 4_000_000_000,
        memoryTotalBytes: 12_000_000_000,
        dataDirectory: {
          path: '/tmp/kookr-data',
          diskFreeBytes: 8_000_000_000,
          diskTotalBytes: 100_000_000_000,
          diskFreePercent: 8,
        },
      },
      server: {
        eventLoopDelayP95Ms: 21,
        processRssBytes: 160_000_000,
        processHeapUsedBytes: 70_000_000,
        processHeapTotalBytes: 100_000_000,
      },
      unavailable: [],
    }, Date.now());

    await act(async () => {
      root.render(
        React.createElement(StatusBar, {
          findings: 0,
          total: 2,
          onShowShortcuts: vi.fn(),
        }),
      );
    });
    await flush();

    expect(container.textContent).toContain('CPU 42%');
    expect(container.textContent).toContain('RAM 68%');
    const resourceButton = container.querySelector<HTMLButtonElement>('.resource-status-trigger');
    expect(resourceButton?.getAttribute('aria-label')).toContain('Server loop p95 21 ms');

    await act(async () => {
      resourceButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.textContent).toContain('Kookr RSS');
  });

  test('surfaces high event-loop delay visibly', async () => {
    useKookrStore.getState().handleResourceStatus({
      source: { kind: 'server-host' },
      sampledAt: new Date().toISOString(),
      sampleGapMs: 2_000,
      timerDriftMs: 0,
      host: {
        cpuUsagePercent: 42,
        memoryUsedPercent: 68,
        memoryFreeBytes: 4_000_000_000,
        memoryTotalBytes: 12_000_000_000,
        dataDirectory: {
          path: '/tmp/kookr-data',
          diskFreeBytes: 8_000_000_000,
          diskTotalBytes: 100_000_000_000,
          diskFreePercent: 8,
        },
      },
      server: {
        eventLoopDelayP95Ms: 180,
        processRssBytes: 160_000_000,
        processHeapUsedBytes: 70_000_000,
        processHeapTotalBytes: 100_000_000,
      },
      unavailable: [],
    }, Date.now());

    await act(async () => {
      root.render(
        React.createElement(StatusBar, {
          findings: 0,
          total: 2,
          compact: true,
          onShowShortcuts: vi.fn(),
        }),
      );
    });
    await flush();

    expect(container.textContent).toContain('Loop 180ms');
  });

  test('shows the median-unblock chip once five human-reply samples exist', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        schemaVersion: 'time-to-unblock.v1',
        medianMs: 12 * 60_000,
        sampleCount: TIME_TO_UNBLOCK_MIN_SAMPLES,
        windowMs: 24 * 60 * 60 * 1000,
        generatedAt: new Date().toISOString(),
      }),
    })));

    await act(async () => {
      root.render(
        React.createElement(StatusBar, {
          findings: 1,
          total: 2,
          onShowShortcuts: vi.fn(),
        }),
      );
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('median unblock 12m');
    expect(container.querySelector('[data-testid="time-to-unblock-chip"]')).not.toBeNull();
  });

  test('hides the median-unblock chip below the five-sample floor', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        schemaVersion: 'time-to-unblock.v1',
        medianMs: 12 * 60_000,
        sampleCount: TIME_TO_UNBLOCK_MIN_SAMPLES - 1,
        windowMs: 24 * 60 * 60 * 1000,
        generatedAt: new Date().toISOString(),
      }),
    })));

    await act(async () => {
      root.render(
        React.createElement(StatusBar, {
          findings: 1,
          total: 2,
          onShowShortcuts: vi.fn(),
        }),
      );
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).not.toContain('median unblock');
    expect(container.querySelector('[data-testid="time-to-unblock-chip"]')).toBeNull();
  });
});
