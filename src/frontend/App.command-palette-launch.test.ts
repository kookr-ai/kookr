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

// Exercises the App-level wiring the CommandPalette component tests can't reach:
// that App actually passes a working onLaunchProject and that the handler
// resolves the palette's projectId to a summary and opens the manual launch
// dialog scoped to that project — without first navigating into its context.
describe('App command-palette project launch', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    syncGlobalStore();
    useKookrStore.setState({
      serverCwd: '/server/cwd',
      sttUrl: '',
      projectSummariesHydrated: true,
    });
    useKookrStore.getState().handleProjectSummaries([
      {
        project: 'github.com/me/idle',
        displayName: 'me/idle',
        activeAgents: 0,
        attentionScore: 0,
        recentTasks: [],
        localPath: '/work/idle',
      },
    ]);
    // Deliberately do NOT selectProject: the palette launch must work without
    // the project being the current context.
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

  test('launching a searched project from the palette opens the manual dialog scoped to it', async () => {
    await act(async () => {
      root.render(React.createElement(App));
    });

    // Open the palette (⌘K / Ctrl+K), then search for the project.
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
    });
    const input = await waitForElement<HTMLInputElement>(container, '[data-testid="command-palette-input"]');
    await act(async () => {
      setInputValue(input, 'idle');
    });

    const launchRow = await waitForElement<HTMLButtonElement>(
      container,
      '[data-testid="command-palette-project-launch"]',
    );
    await act(async () => {
      launchRow.click();
    });

    // The manual launch dialog opens, scoped to the searched project's cwd —
    // proving App wired onLaunchProject and the handler resolved the summary.
    await waitForElement(container, '.dialog-tab.active');
    expect(container.querySelector('.dialog-tab.active')?.textContent).toBe('Manual');
    const cwdInput = container.querySelector<HTMLInputElement>('.combo-input input[type="text"]');
    expect(cwdInput?.value).toBe('/work/idle');
    // The palette itself closed on launch.
    expect(container.querySelector('[data-testid="command-palette-input"]')).toBeNull();
  });
});
