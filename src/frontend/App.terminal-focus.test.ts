// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { App } from './App.js';
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
  DetailPanel: ({ terminalFocusMode }: { terminalFocusMode?: boolean }) =>
    React.createElement('div', {
      'data-testid': 'detail-panel',
      'data-terminal-focus': String(Boolean(terminalFocusMode)),
    }),
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

describe('App terminal focus mode', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1440 });
    localStorage.clear();
    localStorage.setItem('kookr:onboarding:seen-v2', 'true');
    localStorage.setItem('kookr-terminal-focus-mode', '1');
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ configured: false }),
    } as Response)));
    syncGlobalStore();
    useKookrStore.setState({
      projectSummariesHydrated: true,
      sttUrl: '',
    });
    useKookrStore.getState().handleProjectSummaries([
      {
        project: 'github.com/me/focus',
        displayName: 'me/focus',
        activeAgents: 1,
        attentionScore: 2,
        findingCount: 1,
        todayPrCount: 0,
        weekPrCount: 0,
        openPrs: 0,
        recentTasks: [],
      },
    ]);
    useKookrStore.getState().selectProject('github.com/me/focus');
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
    vi.unstubAllGlobals();
  });

  test('loads persisted focus mode and suppresses desktop secondary chrome', async () => {
    await act(async () => {
      root.render(React.createElement(App));
    });
    const trigger = await waitForElement<HTMLButtonElement>(container, '.terminal-focus-trigger');

    expect(trigger.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('[data-testid="detail-panel"]')?.getAttribute('data-terminal-focus')).toBe('true');
    expect(container.querySelector('[data-testid="project-sidebar"]')).toBeNull();
    expect(container.querySelector('[data-testid="project-detail-drawer"]')).toBeNull();

    await act(async () => {
      trigger.click();
    });
    await flush();

    expect(useKookrStore.getState().terminalFocusMode).toBe(false);
    expect(localStorage.getItem('kookr-terminal-focus-mode')).toBeNull();
  });

  test('Alt+T enables focus mode and moves focus to the stable top-bar toggle', async () => {
    localStorage.removeItem('kookr-terminal-focus-mode');
    syncGlobalStore();
    useKookrStore.setState({
      projectSummariesHydrated: true,
      sttUrl: '',
    });
    useKookrStore.getState().handleProjectSummaries([
      {
        project: 'github.com/me/focus',
        displayName: 'me/focus',
        activeAgents: 1,
        attentionScore: 2,
        findingCount: 1,
        todayPrCount: 0,
        weekPrCount: 0,
        openPrs: 0,
        recentTasks: [],
      },
    ]);
    useKookrStore.getState().selectProject('github.com/me/focus');

    await act(async () => {
      root.render(React.createElement(App));
    });
    const projectButton = await waitForElement<HTMLButtonElement>(container, '.project-drawer-close');

    projectButton.focus();
    expect(document.activeElement).toBe(projectButton);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', {
        altKey: true,
        code: 'KeyT',
        key: '†',
        bubbles: true,
        cancelable: true,
      }));
    });
    await flush();

    const trigger = await waitForElement<HTMLButtonElement>(container, '.terminal-focus-trigger');
    expect(useKookrStore.getState().terminalFocusMode).toBe(true);
    expect(trigger.getAttribute('aria-pressed')).toBe('true');
    expect(document.activeElement).toBe(trigger);
    expect(container.querySelector('[data-testid="project-sidebar"]')).toBeNull();
  });

  test('Cmd+Ctrl+T enables focus mode on macOS defaults', async () => {
    Object.defineProperty(window.navigator, 'platform', { configurable: true, value: 'MacIntel' });
    localStorage.removeItem('kookr-terminal-focus-mode');
    syncGlobalStore();
    useKookrStore.setState({
      projectSummariesHydrated: true,
      sttUrl: '',
    });
    useKookrStore.getState().handleProjectSummaries([
      {
        project: 'github.com/me/focus',
        displayName: 'me/focus',
        activeAgents: 1,
        attentionScore: 2,
        findingCount: 1,
        todayPrCount: 0,
        weekPrCount: 0,
        openPrs: 0,
        recentTasks: [],
      },
    ]);
    useKookrStore.getState().selectProject('github.com/me/focus');

    await act(async () => {
      root.render(React.createElement(App));
    });
    await waitForElement<HTMLButtonElement>(container, '.terminal-focus-trigger');

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', {
        metaKey: true,
        ctrlKey: true,
        key: 't',
        bubbles: true,
        cancelable: true,
      }));
    });
    await flush();

    expect(useKookrStore.getState().terminalFocusMode).toBe(true);
  });

  test('uses custom shortcut bindings loaded from settings', async () => {
    localStorage.removeItem('kookr-terminal-focus-mode');
    syncGlobalStore();
    useKookrStore.setState({
      projectSummariesHydrated: true,
      sttUrl: '',
    });
    useKookrStore.getState().handleProjectSummaries([
      {
        project: 'github.com/me/focus',
        displayName: 'me/focus',
        activeAgents: 1,
        attentionScore: 2,
        findingCount: 1,
        todayPrCount: 0,
        weekPrCount: 0,
        openPrs: 0,
        recentTasks: [],
      },
    ]);
    useKookrStore.getState().selectProject('github.com/me/focus');

    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        shortcutBindings: {
          default: { toggle_terminal_focus: 'Ctrl+Shift+T' },
          mac: { toggle_terminal_focus: 'Ctrl+Shift+T' },
        },
      }),
    } as Response)));

    await act(async () => {
      root.render(React.createElement(App));
    });
    await waitForElement<HTMLButtonElement>(container, '.terminal-focus-trigger');
    const fetchMock = vi.mocked(fetch);
    const startedAt = Date.now();
    while (Date.now() - startedAt < 1_000) {
      await flush();
      if (fetchMock.mock.calls.some(([url]) => url === '/api/settings')) break;
    }
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/settings')).toBe(true);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', {
        ctrlKey: true,
        shiftKey: true,
        key: 't',
        code: 'KeyT',
        bubbles: true,
        cancelable: true,
      }));
    });
    await flush();

    expect(useKookrStore.getState().terminalFocusMode).toBe(true);
  });

  test('keeps the normal mobile layout even when focus mode is persisted', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 390 });

    await act(async () => {
      root.render(React.createElement(App));
    });
    await waitForElement(container, '[data-testid="mobile-dashboard-tabs"]');

    expect(useKookrStore.getState().terminalFocusMode).toBe(true);
    expect(useKookrStore.getState().narrowTab).toBe('activity');
    expect(container.querySelector('[data-testid="project-sidebar"]')).not.toBeNull();
    expect(container.querySelector('.app')?.className).toBe('app app-mobile');
  });
});
