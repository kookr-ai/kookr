// @vitest-environment jsdom

/**
 * Status-bar rolling-24h agent-spend chip (issue #3096). Covers the formatter
 * and the zero/low-sample guard, plus the StatusBar rendering sourced from the
 * outcome-ledger 24h window.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { StatusBar } from './StatusBar.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import { __resetAudioAlertLogForTests } from '../audio/audio-alert-log.js';
import { __resetSoundPreferenceForTests } from '../audio/sound.js';
import {
  format24hCostChipLabel,
  format24hCostChipTitle,
  shouldShow24hCostChip,
} from './status-bar-24h-cost.js';

function syncGlobalStore() {
  const freshState = createKookrStore().getState();
  const nextData = Object.fromEntries(
    Object.entries(freshState).filter(([, value]) => typeof value !== 'function'),
  );
  useKookrStore.setState(nextData);
}

/**
 * Stub fetch so the outcome-ledger 24h request resolves to `body` and every
 * other StatusBar fetch (time-to-unblock, live-friction) is a benign miss.
 */
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

describe('24h cost chip copy (issue #3096)', () => {
  test('formats the glanceable dollar label', () => {
    expect(format24hCostChipLabel(12.3)).toBe('$12.30 (24h)');
    expect(format24hCostChipLabel(0.5)).toBe('$0.50 (24h)');
    expect(format24hCostChipLabel(1234.5)).toBe('$1234.50 (24h)');
  });

  test('tooltip names rolling-24h agent spend and the known-cost lower bound', () => {
    expect(format24hCostChipTitle(12.3)).toBe(
      'Agents cost $12.30 in the last 24 hours (rolling). Sums tasks with a known cost — a lower bound when some tasks did not report cost.',
    );
  });

  test('guard shows a non-trivial, well-covered cost', () => {
    expect(shouldShow24hCostChip(12.3, 'ready', 1)).toBe(true);
    expect(shouldShow24hCostChip(0.5, 'ready', 0.8)).toBe(true);
  });

  test('guard still shows a caution window when cost coverage is high', () => {
    // Caution from an outlier / verification gap does not make the *total*
    // misleading once coverage itself is known to be high.
    expect(shouldShow24hCostChip(12.3, 'caution', 0.9)).toBe(true);
  });

  test('guard hides zero, negative, and non-finite costs', () => {
    expect(shouldShow24hCostChip(0, 'ready', 1)).toBe(false);
    expect(shouldShow24hCostChip(-1, 'ready', 1)).toBe(false);
    expect(shouldShow24hCostChip(Number.NaN, 'ready', 1)).toBe(false);
    expect(shouldShow24hCostChip(Number.POSITIVE_INFINITY, 'ready', 1)).toBe(false);
  });

  test('guard hides sub-cent spend that would render as a misleading $0.00', () => {
    // 0.004 is > 0 but rounds to $0.00, so the chip would read as zero spend.
    expect(format24hCostChipLabel(0.004)).toBe('$0.00 (24h)');
    expect(shouldShow24hCostChip(0.004, 'ready', 1)).toBe(false);
    // At/above half a cent the label rounds to at least $0.01, so it shows.
    expect(format24hCostChipLabel(0.005)).toBe('$0.01 (24h)');
    expect(shouldShow24hCostChip(0.005, 'ready', 1)).toBe(true);
  });

  test('guard hides a low-sample / low-coverage (blocked) window even with a positive cost', () => {
    expect(shouldShow24hCostChip(42, 'blocked', 1)).toBe(false);
  });

  test('guard hides a low-coverage window even below the ledger 3-task blocked threshold', () => {
    // A 2-task window with one missing-cost task: coverage 0.5, readiness not
    // blocked (the ledger's <0.8 rule needs >=3 tasks). The summed total would
    // understate real spend, so the chip must stay hidden.
    expect(shouldShow24hCostChip(200, 'caution', 0.5)).toBe(false);
    expect(shouldShow24hCostChip(200, 'ready', 0.5)).toBe(false);
  });

  test('guard hides when cost coverage is unknown', () => {
    expect(shouldShow24hCostChip(200, 'ready', null)).toBe(false);
  });
});

describe('StatusBar 24h cost chip (issue #3096)', () => {
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

  test('renders the cost chip from the outcome-ledger 24h window', async () => {
    stubOutcomeLedger(ledgerBody(12.3, 'ready'));

    await act(async () => {
      root.render(
        React.createElement(StatusBar, {
          findings: 2,
          total: 5,
          onShowShortcuts: vi.fn(),
        }),
      );
    });
    await flushEffects();

    const chip = container.querySelector('[data-testid="cost-24h-chip"]');
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toBe('$12.30 (24h)');
    expect(chip?.getAttribute('title')).toBe(
      'Agents cost $12.30 in the last 24 hours (rolling). Sums tasks with a known cost — a lower bound when some tasks did not report cost.',
    );
  });

  test('refreshes the cost chip on the 60s poll interval', async () => {
    vi.useFakeTimers();
    try {
      let cost = 12.3;
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('outcome-ledger')) {
          return { ok: true, json: async () => ledgerBody(cost, 'ready') };
        }
        return { ok: false, json: async () => ({}) };
      }));

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
      expect(container.querySelector('[data-testid="cost-24h-chip"]')?.textContent)
        .toBe('$12.30 (24h)');

      // Next poll picks up a new figure without a remount.
      cost = 30;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(container.querySelector('[data-testid="cost-24h-chip"]')?.textContent)
        .toBe('$30.00 (24h)');
    } finally {
      vi.useRealTimers();
    }
  });

  test('hides the cost chip for a zero-cost window', async () => {
    stubOutcomeLedger(ledgerBody(0, 'ready'));

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

    expect(container.querySelector('[data-testid="cost-24h-chip"]')).toBeNull();
    expect(container.textContent).not.toContain('(24h)');
  });

  test('hides the cost chip for a blocked (low-sample) window', async () => {
    stubOutcomeLedger(ledgerBody(42, 'blocked'));

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

    expect(container.querySelector('[data-testid="cost-24h-chip"]')).toBeNull();
  });

  test('hides the cost chip for a low-coverage window under the 3-task threshold', async () => {
    // 2-task window, one missing cost: coverage 0.5, readiness caution (not
    // blocked). The confident total would understate real spend — must hide.
    stubOutcomeLedger(ledgerBody(200, 'caution', 0.5));

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

    expect(container.querySelector('[data-testid="cost-24h-chip"]')).toBeNull();
  });

  test('hides the cost chip when the ledger request fails', async () => {
    stubOutcomeLedger(null);

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

    expect(container.querySelector('[data-testid="cost-24h-chip"]')).toBeNull();
  });
});
