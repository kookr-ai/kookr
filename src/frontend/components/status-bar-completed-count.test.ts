// @vitest-environment jsdom

/**
 * Status-bar 24-hour completed-task count (issue #2618). Counts live
 * agents whose finishedAt falls in the shared 24-hour window — not the
 * unblocked-finding volume from #2609.
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
import {
  formatCompletedInWindowChipLabel,
  formatCompletedInWindowChipTitle,
  shouldShowCompletedInWindowChip,
} from './status-bar-completed-count.js';

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

describe('completed-in-window chip copy (issue #2618)', () => {
  test('formats the glanceable label and hides a zero count', () => {
    expect(formatCompletedInWindowChipLabel(3)).toBe('3 completed / 24h');
    expect(formatCompletedInWindowChipLabel(1)).toBe('1 completed / 24h');
    expect(shouldShowCompletedInWindowChip(3)).toBe(true);
    expect(shouldShowCompletedInWindowChip(0)).toBe(false);
    expect(shouldShowCompletedInWindowChip(Number.NaN)).toBe(false);
  });

  test('tooltip names terminal-status throughput and the live-list lower bound', () => {
    expect(formatCompletedInWindowChipTitle(3)).toBe(
      '3 tasks reached a terminal status in the last 24 hours. Lower bound — may miss tasks that finished and then aged out of the live list.',
    );
    expect(formatCompletedInWindowChipTitle(1)).toBe(
      '1 task reached a terminal status in the last 24 hours. Lower bound — may miss tasks that finished and then aged out of the live list.',
    );
  });
});

describe('StatusBar completed-task count (issue #2618)', () => {
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

  test('renders the completed chip from the completedLast24h prop', async () => {
    await act(async () => {
      root.render(
        React.createElement(StatusBar, {
          findings: 2,
          total: 5,
          completedLast24h: 3,
          onShowShortcuts: vi.fn(),
        }),
      );
    });
    await flushEffects();

    const chip = container.querySelector('[data-testid="completed-24h-chip"]');
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toBe('3 completed / 24h');
    expect(chip?.getAttribute('title')).toBe(
      '3 tasks reached a terminal status in the last 24 hours. Lower bound — may miss tasks that finished and then aged out of the live list.',
    );
    expect(container.textContent).toContain('5 tasks · 2 findings');
  });

  test('hides the chip when completedLast24h is 0', async () => {
    await act(async () => {
      root.render(
        React.createElement(StatusBar, {
          findings: 1,
          total: 2,
          completedLast24h: 0,
          onShowShortcuts: vi.fn(),
        }),
      );
    });
    await flushEffects();

    expect(container.querySelector('[data-testid="completed-24h-chip"]')).toBeNull();
    expect(container.textContent).not.toContain('completed /');
    expect(container.textContent).toContain('2 tasks · 1 finding');
  });

  test('keeps the task/finding counts and median-unblock chip next to the completed count', async () => {
    stubTimeToUnblock({
      schemaVersion: 'time-to-unblock.v1',
      medianMs: 8 * 60_000,
      sampleCount: TIME_TO_UNBLOCK_MIN_SAMPLES,
      windowMs: 24 * 60 * 60 * 1000,
      generatedAt: new Date().toISOString(),
    });

    await act(async () => {
      root.render(
        React.createElement(StatusBar, {
          findings: 1,
          total: 4,
          completedLast24h: 3,
          oldestFindingWaitStartedAt: new Date(Date.now() - 4 * 60_000).toISOString(),
          onShowShortcuts: vi.fn(),
        }),
      );
    });
    await flushEffects();

    expect(container.textContent).toContain('4 tasks · 1 finding');
    expect(container.querySelector('[data-testid="completed-24h-chip"]')?.textContent)
      .toBe('3 completed / 24h');
    expect(container.querySelector('[data-testid="oldest-finding-wait-chip"]')?.textContent)
      .toContain('oldest');
    expect(container.querySelector('[data-testid="time-to-unblock-chip"]')?.textContent)
      .toBe('5 unblocked (24h) · median 8m');
    expect(container.querySelector('[data-testid="completed-24h-chip"]')?.textContent)
      .not.toContain('unblocked');
  });
});
