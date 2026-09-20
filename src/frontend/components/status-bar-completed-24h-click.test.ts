// @vitest-environment jsdom

/**
 * Status-bar 24h completed-task chip click-through (issue #3333). The visible
 * chip becomes a button that expands the Completed rail when App supplies the
 * opener. Isolated StatusBar tests still render a non-button status chip.
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

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('StatusBar 24h completed chip click-through (issue #3333)', () => {
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
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })));
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

  test('clicking the visible completed chip calls the Completed-rail opener', async () => {
    const onExpandCompleted = vi.fn();
    const onOpenDiagnostics = vi.fn();

    await act(async () => {
      root.render(
        React.createElement(StatusBar, {
          findings: 1,
          total: 2,
          completedLast24h: 3,
          onShowShortcuts: vi.fn(),
          onExpandCompleted,
          onOpenDiagnostics,
        }),
      );
    });
    await flushEffects();

    const chip = container.querySelector<HTMLButtonElement>('[data-testid="completed-24h-chip"]');
    expect(chip?.tagName).toBe('BUTTON');
    expect(chip?.getAttribute('role')).not.toBe('status');
    expect(chip?.textContent).toBe('3 completed / 24h');
    expect(chip?.getAttribute('aria-label')).toBe(
      '3 completed / 24h. Show completed tasks',
    );

    await act(async () => {
      chip!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onExpandCompleted).toHaveBeenCalledOnce();
    expect(onOpenDiagnostics).not.toHaveBeenCalled();
  });

  test('isolated StatusBar tests still render a non-button chip without App wiring', async () => {
    await act(async () => {
      root.render(
        React.createElement(StatusBar, {
          findings: 1,
          total: 2,
          completedLast24h: 3,
          onShowShortcuts: vi.fn(),
        }),
      );
    });
    await flushEffects();

    const chip = container.querySelector('[data-testid="completed-24h-chip"]');
    expect(chip).not.toBeNull();
    expect(chip?.tagName).toBe('SPAN');
    expect(chip?.getAttribute('role')).toBe('status');
    expect(chip?.textContent).toBe('3 completed / 24h');
  });

  test('does not invent a clickable chip when the 24h completed count is hidden', async () => {
    const onExpandCompleted = vi.fn();

    await act(async () => {
      root.render(
        React.createElement(StatusBar, {
          findings: 1,
          total: 2,
          completedLast24h: 0,
          onShowShortcuts: vi.fn(),
          onExpandCompleted,
        }),
      );
    });
    await flushEffects();

    expect(container.querySelector('[data-testid="completed-24h-chip"]')).toBeNull();
    expect(onExpandCompleted).not.toHaveBeenCalled();
  });
});
