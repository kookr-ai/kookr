// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { App } from './App.js';
import { createKookrStore, useKookrStore } from './store/useStore.js';
import { __resetDndForTests, getDndState, setQuietHoursWindows } from './hooks/useDnd.js';

/**
 * A quiet-hours window guaranteed to include the current minute regardless of
 * the day boundary: a window that wraps almost all the way around the clock,
 * excluding only a one-minute slice in the near future. Lets us drive the
 * `source === 'quiet-hours'` state deterministically without fake timers.
 */
function quietHoursCoveringNow(): { start: string; end: string } {
  const now = new Date();
  const m = now.getHours() * 60 + now.getMinutes();
  const fmt = (min: number) => {
    const mm = ((min % 1440) + 1440) % 1440;
    return `${String(Math.floor(mm / 60)).padStart(2, '0')}:${String(mm % 60).padStart(2, '0')}`;
  };
  return { start: fmt(m + 2), end: fmt(m + 1) };
}

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

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function dndRow(container: Element): HTMLButtonElement | undefined {
  return Array.from(
    container.querySelectorAll<HTMLButtonElement>('[data-testid="command-palette-action"]'),
  ).find((row) => row.dataset.actionId === 'dnd');
}

async function openPalette(container: Element): Promise<HTMLInputElement> {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
  });
  return waitForElement<HTMLInputElement>(container, '[data-testid="command-palette-input"]');
}

async function openPaletteAndSearch(container: Element, query: string): Promise<void> {
  const input = await openPalette(container);
  await act(async () => {
    setInputValue(input, query);
  });
}

// Exercises the App-level wiring for the Do Not Disturb command-palette entry
// (#3104): that App lists a DND action whose label reflects the current state
// and whose `run` drives the same shared manual-layer toggle as the top-bar
// pill (`useDnd().toggle`).
describe('App command-palette Do Not Disturb', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    __resetDndForTests();
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
    __resetDndForTests();
  });

  test('lists a DND entry that toggles the shared manual layer and reflects its state', async () => {
    await act(async () => {
      root.render(React.createElement(App));
    });

    // Off → the palette lists the entry in browse mode (empty query), under the
    // Session section, offering "Turn on Do Not Disturb".
    await openPalette(container);
    await flush();
    let row = dndRow(container);
    expect(row).toBeTruthy();
    expect(row!.textContent).toContain('Turn on Do Not Disturb');
    expect(row!.closest('[data-testid="command-palette-list"]')?.textContent).toContain('Session');
    expect(getDndState().enabled).toBe(false);

    // Running it enables the manual layer and closes the palette.
    await act(async () => {
      row!.click();
    });
    await flush();
    expect(getDndState().enabled).toBe(true);
    expect(getDndState().source).toBe('manual');
    expect(container.querySelector('[data-testid="command-palette-input"]')).toBeNull();

    // Reopening shows the flipped label — state is reflected.
    await openPaletteAndSearch(container, 'do not disturb');
    row = dndRow(container);
    expect(row).toBeTruthy();
    expect(row!.textContent).toContain('Turn off Do Not Disturb');

    // Running it again disables DND.
    await act(async () => {
      row!.click();
    });
    await flush();
    expect(getDndState().enabled).toBe(false);
    expect(getDndState().source).toBe('off');
  });

  test('the DND entry is reachable by keywords absent from its label', async () => {
    await act(async () => {
      root.render(React.createElement(App));
    });

    // "dnd" and "focus" are not substrings of the "…Do Not Disturb" label, so
    // these exercise the keyword-match path rather than the label-match path.
    // Re-search within the one open palette (a second Ctrl+K would toggle it shut).
    const input = await openPalette(container);
    for (const term of ['dnd', 'focus']) {
      await act(async () => {
        setInputValue(input, term);
      });
      await flush();
      expect(dndRow(container), `expected DND entry to match "${term}"`).toBeTruthy();
    }
  });

  test('during scheduled quiet hours the entry still reads "Turn on" and pins the manual layer', async () => {
    await act(async () => {
      root.render(React.createElement(App));
    });

    // Seed an active quiet-hours window: DND is effectively on via the schedule,
    // but the manual layer is off (source === 'quiet-hours').
    await act(async () => {
      setQuietHoursWindows([quietHoursCoveringNow()]);
    });
    expect(getDndState().enabled).toBe(true);
    expect(getDndState().source).toBe('quiet-hours');

    // The label keys off the manual layer (what the toggle will do), not the
    // effective `enabled` flag — so it reads "Turn on", matching the pill's
    // behavior of pinning manual DND on rather than no-opping.
    await openPaletteAndSearch(container, 'do not disturb');
    const row = dndRow(container);
    expect(row).toBeTruthy();
    expect(row!.textContent).toContain('Turn on Do Not Disturb');

    await act(async () => {
      row!.click();
    });
    await flush();
    // Running it pins the manual layer on (does not no-op).
    expect(getDndState().enabled).toBe(true);
    expect(getDndState().source).toBe('manual');
  });
});
