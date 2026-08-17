// @vitest-environment jsdom

/**
 * Status-bar 24-hour unblocked-finding count (issue #2609). Reuses the
 * existing time-to-unblock snapshot — no second event source. Hidden when
 * sampleCount is 0; visible next to the median when samples exist.
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

function stubTimeToUnblock(body: Record<string, unknown> | null) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('time-to-unblock') && body) {
      return { ok: true, json: async () => body };
    }
    return { ok: false, json: async () => ({}) };
  }));
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('StatusBar unblocked-finding count (issue #2609)', () => {
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
    stubTimeToUnblock(null);
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

  test('shows the unblocked count next to the median when sampleCount is 12', async () => {
    stubTimeToUnblock({
      schemaVersion: 'time-to-unblock.v1',
      medianMs: 8 * 60_000,
      sampleCount: 12,
      windowMs: 24 * 60 * 60 * 1000,
      generatedAt: new Date().toISOString(),
    });

    await act(async () => {
      root.render(
        React.createElement(StatusBar, {
          findings: 1,
          total: 2,
          onShowShortcuts: vi.fn(),
        }),
      );
    });
    await flushEffects();

    const chip = container.querySelector('[data-testid="time-to-unblock-chip"]');
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toBe('12 unblocked (24h) · median 8m');
    expect(chip?.getAttribute('title')).toContain('last 24 hours');
    expect(chip?.getAttribute('title')).toContain('12 findings');
  });

  test('hides the chip and the unblocked copy when sampleCount is 0', async () => {
    stubTimeToUnblock({
      schemaVersion: 'time-to-unblock.v1',
      medianMs: null,
      sampleCount: 0,
      windowMs: 24 * 60 * 60 * 1000,
      generatedAt: new Date().toISOString(),
    });

    await act(async () => {
      root.render(
        React.createElement(StatusBar, {
          findings: 1,
          total: 2,
          onShowShortcuts: vi.fn(),
        }),
      );
    });
    await flushEffects();

    expect(container.querySelector('[data-testid="time-to-unblock-chip"]')).toBeNull();
    expect(container.textContent).not.toContain('unblocked');
    expect(container.textContent).not.toContain('24h');
  });

  test('does not reuse the oldest-wait or live-friction labels', async () => {
    stubTimeToUnblock({
      schemaVersion: 'time-to-unblock.v1',
      medianMs: 8 * 60_000,
      sampleCount: 12,
      windowMs: 24 * 60 * 60 * 1000,
      generatedAt: new Date().toISOString(),
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
    await flushEffects();

    const chip = container.querySelector('[data-testid="time-to-unblock-chip"]');
    expect(chip?.textContent).toContain('12 unblocked (24h)');
    expect(chip?.textContent).not.toContain('oldest');
    expect(chip?.textContent).not.toContain('skip');
    expect(chip?.textContent).not.toContain('snooze');
  });
});
