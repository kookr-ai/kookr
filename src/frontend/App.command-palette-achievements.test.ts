// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { App } from './App.js';
import { createKookrStore, useKookrStore } from './store/useStore.js';

const { sendMock } = vi.hoisted(() => ({
  sendMock: vi.fn(() => true),
}));

vi.mock('./hooks/useWebSocket.js', () => ({
  useWebSocket: () => ({ send: sendMock }),
}));

vi.mock('./hooks/useNotifications.js', () => ({
  useNotifications: () => {},
}));

vi.mock('./hooks/useAudibleAlert.js', () => ({
  useAudibleAlert: () => {},
  isSoundEnabled: () => true,
  setSoundEnabled: vi.fn(),
}));

vi.mock('./telemetry.js', () => ({
  initTelemetry: vi.fn(),
  track: vi.fn(),
  trackClick: vi.fn(),
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
  while (Date.now() - startedAt < 5_000) {
    await flush();
    const element = container.querySelector<T>(selector);
    if (element) return element;
  }
  throw new Error(`Timed out waiting for ${selector}`);
}

async function waitForGone(container: Element, selector: string): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5_000) {
    await flush();
    if (!container.querySelector(selector)) return;
  }
  throw new Error(`Timed out waiting for ${selector} to disappear`);
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

// #3407: the command palette gained a second door to the Achievements panel,
// beside the status-bar trophy. These tests exercise the App-level wiring: the
// palette row is searchable by label and keyword (and the search actually
// narrows to it), it toggles the same panel the trophy opens, and choosing it
// twice closes it again.
describe('App command-palette achievements', () => {
  let container: HTMLDivElement;
  let root: Root;

  // Collect the action-row ids currently rendered in the palette, in rank order.
  function actionRowIds(): (string | undefined)[] {
    return Array.from(
      container.querySelectorAll<HTMLButtonElement>('[data-testid="command-palette-action"]'),
    ).map((row) => row.dataset.actionId);
  }

  // Open the palette (⌘K / Ctrl+K) and type a query, returning the input.
  async function openPaletteAndSearch(query: string): Promise<HTMLInputElement> {
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
    });
    const input = await waitForElement<HTMLInputElement>(container, '[data-testid="command-palette-input"]');
    await act(async () => {
      setInputValue(input, query);
    });
    return input;
  }

  beforeEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    sendMock.mockClear();
    syncGlobalStore();
    useKookrStore.setState({
      serverCwd: '/server/cwd',
      sttUrl: '',
      projectSummariesHydrated: true,
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await act(async () => {
      root.unmount();
    });
    document.body.innerHTML = '';
    localStorage.clear();
  });

  test('searching by label or by the "trophy" keyword narrows to exactly the achievements row', async () => {
    await act(async () => {
      root.render(React.createElement(App));
    });

    // Label match. Assert the filter narrows to exactly this row — not merely
    // that it is present — so a "filter renders everything" regression fails.
    const input = await openPaletteAndSearch('achievements');
    await waitForElement(container, '[data-action-id="achievements"]');
    expect(actionRowIds()).toEqual(['achievements']);

    // Keyword match: "trophy" is absent from the label, and unique to this
    // action, so it must resolve to the achievements row alone. Retype in the
    // same open palette — re-dispatching Ctrl+K would toggle it closed.
    await act(async () => {
      setInputValue(input, 'trophy');
    });
    await waitForElement(container, '[data-action-id="achievements"]');
    expect(actionRowIds()).toEqual(['achievements']);
  });

  test('choosing the row opens the Achievements panel, and choosing it again closes it', async () => {
    await act(async () => {
      root.render(React.createElement(App));
    });
    expect(useKookrStore.getState().showAchievements).toBe(false);

    // First choice opens the panel (and closes the palette).
    await openPaletteAndSearch('achievements');
    const row = await waitForElement<HTMLButtonElement>(container, '[data-action-id="achievements"]');
    await act(async () => {
      row.click();
    });
    await waitForElement(container, '.achievements-panel');
    expect(useKookrStore.getState().showAchievements).toBe(true);
    expect(container.querySelector('[data-testid="command-palette-input"]')).toBeNull();

    // Second choice toggles it back closed.
    await openPaletteAndSearch('achievements');
    const rowAgain = await waitForElement<HTMLButtonElement>(container, '[data-action-id="achievements"]');
    await act(async () => {
      rowAgain.click();
    });
    await waitForGone(container, '.achievements-panel');
    expect(useKookrStore.getState().showAchievements).toBe(false);
  });

  test('the palette row opens the same panel as the status-bar trophy', async () => {
    await act(async () => {
      root.render(React.createElement(App));
    });

    // The status-bar trophy opens the panel.
    const trophy = await waitForElement<HTMLButtonElement>(container, 'button[aria-label="Achievements"]');
    await act(async () => {
      trophy.click();
    });
    await waitForElement(container, '.achievements-panel');
    expect(useKookrStore.getState().showAchievements).toBe(true);

    // Close it again so the palette row starts from the same state.
    await act(async () => {
      trophy.click();
    });
    await waitForGone(container, '.achievements-panel');

    // The palette row opens the identical panel.
    await openPaletteAndSearch('achievements');
    const row = await waitForElement<HTMLButtonElement>(container, '[data-action-id="achievements"]');
    await act(async () => {
      row.click();
    });
    await waitForElement(container, '.achievements-panel');
    expect(useKookrStore.getState().showAchievements).toBe(true);
  });
});
