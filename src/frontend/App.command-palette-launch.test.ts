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

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

// Exercises the App-level wiring the CommandPalette component tests can't reach:
// that App actually passes a working onLaunchProject and that the handler
// resolves the palette's projectId to a summary and opens the manual launch
// dialog scoped to that project — without first navigating into its context.
// Also covers the global Outcome Scoreboard palette action (issue #3281).
describe('App command-palette project launch', () => {
  let container: HTMLDivElement;
  let root: Root;

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

  test('passes stored relaunch lineage through App into the submitted launch', async () => {
    useKookrStore.getState().setRelaunchTask({
      sourceTaskId: 'original-task',
      prompt: 'Retry this task',
      cwd: '/work/idle',
    });

    await act(async () => {
      root.render(React.createElement(App));
    });
    const form = await waitForElement<HTMLFormElement>(container, '.dialog-overlay form');

    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush();

    expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'launch',
      prompt: 'Retry this task',
      cwd: '/work/idle',
      parentTaskId: 'original-task',
    }));
  });
});

describe('App command-palette Outcome Scoreboard', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    localStorage.setItem('kookr:onboarding:seen-v2', 'true');
    sendMock.mockClear();
    syncGlobalStore();
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/settings')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ cleanupWorktreeOnComplete: true }),
        } as Response);
      }
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
    // Select a project so the findings rail is scoped — the scoreboard action
    // must stay global and still appear (issue #3281).
    useKookrStore.getState().selectProject('github.com/me/idle');
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
    vi.unstubAllGlobals();
  });

  async function openPaletteAndSearch(query: string): Promise<HTMLButtonElement[]> {
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
    });
    const input = await waitForElement<HTMLInputElement>(container, '[data-testid="command-palette-input"]');
    await act(async () => {
      setInputValue(input, query);
    });
    return Array.from(container.querySelectorAll<HTMLButtonElement>('[data-testid="command-palette-action"]'));
  }

  test('searching scoreboard or outcome finds the global action and opens the existing Outcome Scoreboard', async () => {
    await act(async () => {
      root.render(React.createElement(App));
    });

    const scoreboardHits = await openPaletteAndSearch('scoreboard');
    expect(scoreboardHits.map((row) => row.dataset.actionId)).toEqual(['outcome-scoreboard']);
    expect(scoreboardHits[0].textContent).toContain('Outcome Scoreboard');

    await act(async () => {
      scoreboardHits[0].click();
    });
    await waitForElement(container, '.operations-panel');
    const scoreboardTitle = await waitForElement(container, '#outcome-ledger-title');
    expect(scoreboardTitle.textContent).toBe('Outcome Scoreboard');
    expect(container.querySelector('[data-testid="command-palette-input"]')).toBeNull();

    // Palette can open over Diagnostics. Running the action again must keep
    // the panel open (openDiagnostics, not toggleOperations).
    const stillOpenHits = await openPaletteAndSearch('scoreboard');
    await act(async () => {
      stillOpenHits[0].click();
    });
    expect(container.querySelector('.operations-panel')).not.toBeNull();
    expect(container.querySelector('#outcome-ledger-title')?.textContent).toBe('Outcome Scoreboard');

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Close diagnostics"]')?.click();
    });
    const startedAt = Date.now();
    while (Date.now() - startedAt < 5_000) {
      await flush();
      if (container.querySelector('.operations-panel') === null) break;
    }
    expect(container.querySelector('.operations-panel')).toBeNull();

    const outcomeHits = await openPaletteAndSearch('outcome');
    expect(outcomeHits.map((row) => row.dataset.actionId)).toEqual(['outcome-scoreboard']);
    await act(async () => {
      outcomeHits[0].click();
    });
    await waitForElement(container, '#outcome-ledger-title');
    expect(container.querySelector('.operations-panel')).not.toBeNull();
  });

  test('searching Diagnostics still finds the existing Diagnostics action', async () => {
    await act(async () => {
      root.render(React.createElement(App));
    });

    const diagnosticsHits = await openPaletteAndSearch('diagnostics');
    expect(diagnosticsHits.map((row) => row.dataset.actionId)).toEqual(['diagnostics']);
    expect(diagnosticsHits[0].textContent).toContain('Diagnostics');

    await act(async () => {
      diagnosticsHits[0].click();
    });
    await waitForElement(container, '.operations-panel');
    expect(container.querySelector('#outcome-ledger-title')?.textContent).toBe('Outcome Scoreboard');
  });
});
