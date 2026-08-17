// @vitest-environment jsdom

/**
 * Status-bar live skip / snooze chip (issue #2596). Fetch is stubbed in
 * this file only so shared StatusBar tests keep their existing fetch
 * isolation (same pattern as time-to-unblock).
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { StatusBar } from './StatusBar.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import { __resetAudioAlertLogForTests } from '../audio/audio-alert-log.js';
import { __resetSoundPreferenceForTests } from '../audio/sound.js';
import { LIVE_FRICTION_CHIP_TITLE } from './live-friction-chip.js';
import { TIME_TO_UNBLOCK_MIN_SAMPLES } from '../../shared/contracts/time-to-unblock.js';

function syncGlobalStore() {
  const freshState = createKookrStore().getState();
  const nextData = Object.fromEntries(
    Object.entries(freshState).filter(([, value]) => typeof value !== 'function'),
  );
  useKookrStore.setState(nextData);
}

function frictionSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 'live-friction-calibration.v1',
    mode: 'diagnostics_only',
    generatedAt: new Date().toISOString(),
    routingMutationAllowed: false,
    interactionCount: 4,
    activeFindingCount: 1,
    signalCount: 4,
    signals: [
      { kind: 'skipped_finding', target: 'needs_input', count: 2, agentCount: 2, evidence: [] },
      { kind: 'snoozed_finding', target: 'stuck', count: 1, agentCount: 1, evidence: [] },
      { kind: 'false_positive_feedback', target: 'permission_blocked', count: 1, agentCount: 1, evidence: [] },
    ],
    recommendations: [],
    ...overrides,
  };
}

function stubFetch(handler: (url: string) => unknown) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = handler(url);
    if (body === undefined) {
      return { ok: false, json: async () => ({}) };
    }
    return { ok: true, json: async () => body };
  }));
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('StatusBar live friction chip (issue #2596)', () => {
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
    stubFetch(() => undefined);
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

  test('hides the chip when signalCount is 0', async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/live-friction-calibration')) {
        return frictionSnapshot({ signalCount: 0, signals: [] });
      }
      return undefined;
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

    expect(container.querySelector('[data-testid="live-friction-chip"]')).toBeNull();
    expect(container.textContent).not.toContain('skip ');
  });

  test('hides the chip when the fetch is a different snapshot schema', async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/live-friction-calibration') || url.includes('time-to-unblock')) {
        return {
          schemaVersion: 'time-to-unblock.v1',
          medianMs: 12 * 60_000,
          sampleCount: TIME_TO_UNBLOCK_MIN_SAMPLES,
          windowMs: 24 * 60 * 60 * 1000,
          generatedAt: new Date().toISOString(),
        };
      }
      return undefined;
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

    expect(container.querySelector('[data-testid="live-friction-chip"]')).toBeNull();
    expect(container.querySelector('[data-testid="time-to-unblock-chip"]')).not.toBeNull();
  });

  test('shows skip, snooze, and false-positive counts from the snapshot', async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/live-friction-calibration')) {
        return frictionSnapshot();
      }
      return undefined;
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

    const chip = container.querySelector('[data-testid="live-friction-chip"]');
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toBe('skip 2 · snooze 1 · false-positive 1');
    expect(chip?.getAttribute('title')).toBe(LIVE_FRICTION_CHIP_TITLE);
    expect(chip?.getAttribute('title')).toContain('does not reorder findings');
  });

  test('omits false-positive from the label when that kind is absent', async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/live-friction-calibration')) {
        return frictionSnapshot({
          signalCount: 3,
          signals: [
            { kind: 'skipped_finding', target: 'needs_input', count: 2, agentCount: 2, evidence: [] },
            { kind: 'snoozed_finding', target: 'stuck', count: 1, agentCount: 1, evidence: [] },
          ],
        });
      }
      return undefined;
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

    expect(container.querySelector('[data-testid="live-friction-chip"]')?.textContent)
      .toBe('skip 2 · snooze 1');
  });

  test('hides the chip when the live-friction fetch fails', async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/live-friction-calibration')) {
        return undefined;
      }
      return undefined;
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

    expect(container.querySelector('[data-testid="live-friction-chip"]')).toBeNull();
  });

  test('shows skip 0 · snooze 0 when signalCount comes only from direct interventions', async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/live-friction-calibration')) {
        return frictionSnapshot({
          signalCount: 2,
          signals: [
            { kind: 'direct_intervention_without_finding', target: 'unclassified_intervention', count: 2, agentCount: 1, evidence: [] },
          ],
        });
      }
      return undefined;
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

    expect(container.querySelector('[data-testid="live-friction-chip"]')?.textContent)
      .toBe('skip 0 · snooze 0');
  });

  test('clicking the chip opens live friction diagnostics', async () => {
    const onOpenLiveFriction = vi.fn();
    stubFetch((url) => {
      if (url.startsWith('/api/live-friction-calibration')) {
        return frictionSnapshot();
      }
      return undefined;
    });

    await act(async () => {
      root.render(
        React.createElement(StatusBar, {
          findings: 1,
          total: 2,
          onShowShortcuts: vi.fn(),
          onOpenLiveFriction,
        }),
      );
    });
    await flushEffects();

    const chip = container.querySelector<HTMLButtonElement>('[data-testid="live-friction-chip"]');
    expect(chip?.tagName).toBe('BUTTON');

    await act(async () => {
      chip!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onOpenLiveFriction).toHaveBeenCalledOnce();
  });
});
