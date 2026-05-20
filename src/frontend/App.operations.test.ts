// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { App } from './App.js';
import { STORAGE_KEY as ONBOARDING_STORAGE_KEY } from './store/onboarding-status.js';
import { createKookrStore, useKookrStore } from './store/useStore.js';

vi.mock('./hooks/useWebSocket.js', () => ({
  useWebSocket: () => ({ send: () => true }),
}));

vi.mock('./hooks/useNotifications.js', () => ({
  useNotifications: () => {},
}));

vi.mock('./hooks/useAudibleAlert.js', () => ({
  useAudibleAlert: () => {},
}));

vi.mock('./hooks/useTaskCompletionChime.js', () => ({
  useTaskCompletionChime: () => {},
}));

vi.mock('./telemetry.js', () => ({
  track: vi.fn(),
}));

vi.mock('./components/DetailPanel.js', () => ({
  DetailPanel: () => React.createElement('div', { 'data-testid': 'detail-panel' }),
}));

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
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function waitForElement<T extends Element>(container: Element, selector: string): Promise<T> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 1_000) {
    await flush();
    const element = container.querySelector<T>(selector);
    if (element) return element;
  }
  throw new Error(`Timed out waiting for ${selector}`);
}

describe('App operations modal shortcuts', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.setItem(ONBOARDING_STORAGE_KEY, 'true');
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/anomaly-stats')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ checks: {}, fires: {}, falsePositives: {} }),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ configured: false }),
      } as Response);
    }));
    syncGlobalStore();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    document.body.innerHTML = '';
    localStorage.clear();
    vi.restoreAllMocks();
  });

  test('global help shortcut is suppressed while diagnostics is modal', async () => {
    await act(async () => {
      root.render(React.createElement(App));
    });
    const operations = await waitForElement<HTMLButtonElement>(container, '.operations-trigger');

    await act(async () => {
      operations.click();
    });
    await waitForElement(container, '.operations-panel');

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: '?',
        bubbles: true,
        cancelable: true,
      }));
    });
    await flush();

    expect(container.querySelector('.shortcuts-help')).toBeNull();
    expect(container.querySelector('.operations-panel')).not.toBeNull();
  });
});
