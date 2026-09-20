// @vitest-environment jsdom

/**
 * Status-bar 24h cost chip click-through (issue #3335). The visible chip
 * becomes a button that opens Cost Comparison when App supplies the opener.
 * Isolated StatusBar tests still render a non-button status chip.
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

function stubOutcomeLedger(body: Record<string, unknown> | null) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('outcome-ledger') && body) {
      return { ok: true, json: async () => body };
    }
    return { ok: false, json: async () => ({}) };
  }));
}

function ledgerBody(
  totalKnownCostUsd: number,
  readiness: string,
  costCoverage: number | null = 1,
): Record<string, unknown> {
  return {
    schemaVersion: 'outcome-ledger.v1',
    generatedAt: new Date().toISOString(),
    window: { value: '24h', start: null, end: new Date().toISOString() },
    scope: { kind: 'all' },
    readiness,
    summary: { totalKnownCostUsd },
    quality: { costCoverage },
  };
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('StatusBar 24h cost chip click-through (issue #3335)', () => {
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
    stubOutcomeLedger(null);
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

  test('clicking the visible cost chip calls the Cost Comparison opener', async () => {
    const onOpenCostComparison = vi.fn();
    const onOpenDiagnostics = vi.fn();
    stubOutcomeLedger(ledgerBody(12.3, 'ready'));

    await act(async () => {
      root.render(
        React.createElement(StatusBar, {
          findings: 1,
          total: 2,
          onShowShortcuts: vi.fn(),
          onOpenCostComparison,
          onOpenDiagnostics,
        }),
      );
    });
    await flushEffects();

    const chip = container.querySelector<HTMLButtonElement>('[data-testid="cost-24h-chip"]');
    expect(chip?.tagName).toBe('BUTTON');
    expect(chip?.getAttribute('role')).not.toBe('status');
    expect(chip?.textContent).toBe('$12.30 (24h)');
    expect(chip?.getAttribute('aria-label')).toBe(
      '$12.30 (24h). Open Cost Comparison',
    );

    await act(async () => {
      chip!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onOpenCostComparison).toHaveBeenCalledOnce();
    expect(onOpenDiagnostics).not.toHaveBeenCalled();
  });

  test('isolated StatusBar tests still render a non-button chip without App wiring', async () => {
    stubOutcomeLedger(ledgerBody(12.3, 'ready'));

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

    const chip = container.querySelector('[data-testid="cost-24h-chip"]');
    expect(chip).not.toBeNull();
    expect(chip?.tagName).toBe('SPAN');
    expect(chip?.getAttribute('role')).toBe('status');
    expect(chip?.textContent).toBe('$12.30 (24h)');
  });

  test('does not invent a clickable chip when the 24h cost is hidden', async () => {
    const onOpenCostComparison = vi.fn();
    stubOutcomeLedger(ledgerBody(0, 'ready'));

    await act(async () => {
      root.render(
        React.createElement(StatusBar, {
          findings: 1,
          total: 2,
          onShowShortcuts: vi.fn(),
          onOpenCostComparison,
        }),
      );
    });
    await flushEffects();

    expect(container.querySelector('[data-testid="cost-24h-chip"]')).toBeNull();
    expect(onOpenCostComparison).not.toHaveBeenCalled();
  });
});
