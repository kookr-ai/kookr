// @vitest-environment jsdom

/**
 * Status-bar oldest live finding wait (issue #2588). The chip reuses the
 * same wait timestamps the overview formats. Hidden when the findings
 * count is zero; visible next to the count for an aged finding.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { StatusBar } from './StatusBar.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import { __resetAudioAlertLogForTests } from '../audio/audio-alert-log.js';
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

describe('StatusBar oldest finding wait (issue #2588)', () => {
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
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  test('hides the oldest-wait chip when the findings count is zero', async () => {
    await act(async () => {
      root.render(
        React.createElement(StatusBar, {
          findings: 0,
          total: 2,
          oldestFindingWaitStartedAt: new Date(Date.now() - 12 * 60_000).toISOString(),
          onShowShortcuts: vi.fn(),
        }),
      );
    });
    await flush();

    expect(container.textContent).not.toContain('oldest');
    expect(container.querySelector('[data-testid="oldest-finding-wait-chip"]')).toBeNull();
  });

  test('shows the oldest-wait chip for one aged finding', async () => {
    await act(async () => {
      root.render(
        React.createElement(StatusBar, {
          findings: 1,
          total: 2,
          oldestFindingWaitStartedAt: new Date(Date.now() - 12 * 60_000).toISOString(),
          onShowShortcuts: vi.fn(),
        }),
      );
    });
    await flush();

    expect(container.textContent).toContain('oldest 12m');
    expect(container.querySelector('[data-testid="oldest-finding-wait-chip"]')).not.toBeNull();
  });

  test('keeps the historical median-unblock chip next to the live oldest wait', async () => {
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
          oldestFindingWaitStartedAt: new Date(Date.now() - 4 * 60_000).toISOString(),
          onShowShortcuts: vi.fn(),
        }),
      );
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('oldest 4m');
    expect(container.textContent).toContain('median unblock 12m');
    expect(container.querySelector('[data-testid="oldest-finding-wait-chip"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="time-to-unblock-chip"]')).not.toBeNull();
  });
});
