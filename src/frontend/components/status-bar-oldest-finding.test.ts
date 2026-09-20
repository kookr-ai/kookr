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

function stubOutcomeLedger(totalKnownCostUsd: number) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('outcome-ledger')) {
      return {
        ok: true,
        json: async () => ({
          schemaVersion: 'outcome-ledger.v1',
          generatedAt: new Date().toISOString(),
          window: { value: '24h', start: null, end: new Date().toISOString() },
          scope: { kind: 'all' },
          readiness: 'ready',
          summary: { totalKnownCostUsd },
          quality: { costCoverage: 1 },
        }),
      };
    }
    return { ok: false, json: async () => ({}) };
  }));
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
    const chip = container.querySelector('[data-testid="oldest-finding-wait-chip"]');
    expect(chip).not.toBeNull();
    expect(chip?.tagName).toBe('SPAN');
    expect(chip?.getAttribute('role')).toBe('status');
  });

  test('clicking the visible chip calls the oldest-finding selector (issue #3343)', async () => {
    const onSelectOldestFinding = vi.fn();
    const onExpandCompleted = vi.fn();
    const onOpenCostComparison = vi.fn();

    await act(async () => {
      root.render(
        React.createElement(StatusBar, {
          findings: 2,
          total: 3,
          completedLast24h: 3,
          oldestFindingWaitStartedAt: new Date(Date.now() - 12 * 60_000).toISOString(),
          onShowShortcuts: vi.fn(),
          onSelectOldestFinding,
          onExpandCompleted,
          onOpenCostComparison,
        }),
      );
    });
    await flush();

    const chip = container.querySelector<HTMLButtonElement>('[data-testid="oldest-finding-wait-chip"]');
    expect(chip?.tagName).toBe('BUTTON');
    expect(chip?.getAttribute('role')).not.toBe('status');
    expect(chip?.textContent).toBe('oldest 12m');
    expect(chip?.getAttribute('aria-label')).toBe(
      'oldest 12m. Select oldest unanswered finding',
    );

    await act(async () => {
      chip!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onSelectOldestFinding).toHaveBeenCalledOnce();
    expect(onExpandCompleted).not.toHaveBeenCalled();
    expect(onOpenCostComparison).not.toHaveBeenCalled();
  });

  test('keeps completed-count and 24h cost click-throughs when the oldest-wait chip is also wired', async () => {
    const onSelectOldestFinding = vi.fn();
    const onExpandCompleted = vi.fn();
    const onOpenCostComparison = vi.fn();
    stubOutcomeLedger(12.3);

    await act(async () => {
      root.render(
        React.createElement(StatusBar, {
          findings: 1,
          total: 2,
          completedLast24h: 3,
          oldestFindingWaitStartedAt: new Date(Date.now() - 4 * 60_000).toISOString(),
          onShowShortcuts: vi.fn(),
          onSelectOldestFinding,
          onExpandCompleted,
          onOpenCostComparison,
        }),
      );
    });
    await flush();
    await flush();

    const completedChip = container.querySelector<HTMLButtonElement>('[data-testid="completed-24h-chip"]');
    expect(completedChip?.tagName).toBe('BUTTON');
    await act(async () => {
      completedChip!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onExpandCompleted).toHaveBeenCalledOnce();
    expect(onSelectOldestFinding).not.toHaveBeenCalled();

    const costChip = container.querySelector<HTMLButtonElement>('[data-testid="cost-24h-chip"]');
    expect(costChip?.tagName).toBe('BUTTON');
    await act(async () => {
      costChip!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onOpenCostComparison).toHaveBeenCalledOnce();
    expect(onSelectOldestFinding).not.toHaveBeenCalled();
  });

  test('does not invent a clickable chip when the oldest wait is hidden', async () => {
    const onSelectOldestFinding = vi.fn();

    await act(async () => {
      root.render(
        React.createElement(StatusBar, {
          findings: 0,
          total: 2,
          oldestFindingWaitStartedAt: new Date(Date.now() - 12 * 60_000).toISOString(),
          onShowShortcuts: vi.fn(),
          onSelectOldestFinding,
        }),
      );
    });
    await flush();

    expect(container.querySelector('[data-testid="oldest-finding-wait-chip"]')).toBeNull();
    expect(onSelectOldestFinding).not.toHaveBeenCalled();
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
    expect(container.textContent).toContain('5 unblocked (24h) · median 12m');
    expect(container.querySelector('[data-testid="oldest-finding-wait-chip"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="time-to-unblock-chip"]')).not.toBeNull();
  });
});
