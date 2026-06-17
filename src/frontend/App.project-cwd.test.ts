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

describe('App project drawer launch cwd', () => {
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
      playbooks: [{
        id: 'test-playbook.md',
        name: 'Test Playbook',
        description: 'Exercise launch cwd',
        parameters: [],
        checklist: [],
        tags: [],
        body: 'Run this.',
        sourceCwd: '/work/idle',
        scope: 'project',
      }],
      playbooksLastFetchedAt: Date.now(),
      // Seed the per-cwd cache at the focused project's cwd: post-#1019 the
      // catalog follows the project, so a fresh cache at '/work/idle' avoids a
      // (mocked) refetch leaving the list stuck in the loading state.
      playbooksLastFetchedCwd: '/work/idle',
      playbooksLoading: false,
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
  });

  test('lists the focused project playbook catalog and runs in the project cwd (no agents)', async () => {
    await act(async () => {
      root.render(React.createElement(App));
    });
    const runPlaybook = await waitForElement<HTMLButtonElement>(container, '[data-testid="run-playbook-btn"]');

    await act(async () => {
      runPlaybook.click();
    });
    await waitForElement(container, '.playbook-resolved-cwd-path');

    // The catalog now follows the focused project (#1019). Catalog source and
    // execution cwd coincide on the project, so PlaybookBrowser collapses to a
    // single "Running in:" line at '/work/idle' — the execution cwd, unchanged.
    expect(container.textContent).toContain('Running in:');
    expect(container.textContent).not.toContain('Playbooks from:');
    const cwdPaths = Array.from(container.querySelectorAll('.playbook-resolved-cwd-path'))
      .map((el) => el.textContent);
    expect(cwdPaths).toEqual(['/work/idle']);
  });

  test('opens a project manual task with the project cwd selected', async () => {
    await act(async () => {
      root.render(React.createElement(App));
    });
    const manualTask = await waitForElement<HTMLButtonElement>(container, '[data-testid="launch-manual-task-btn"]');

    await act(async () => {
      manualTask.click();
    });
    await waitForElement(container, '.dialog-tab.active');

    expect(container.querySelector('.dialog-tab.active')?.textContent).toBe('Manual');
    const cwdInput = container.querySelector<HTMLInputElement>('.combo-input input[type="text"]');
    expect(cwdInput?.value).toBe('/work/idle');
  });

  test('can reopen Playbook task from the same project drawer after closing the dialog', async () => {
    await act(async () => {
      root.render(React.createElement(App));
    });
    const firstRunPlaybook = await waitForElement<HTMLButtonElement>(container, '[data-testid="run-playbook-btn"]');

    await act(async () => {
      firstRunPlaybook.click();
    });
    await waitForElement(container, '.dialog');

    expect(container.querySelector('.dialog')).not.toBeNull();

    const closeButton = await waitForElement<HTMLButtonElement>(container, '.dialog-close');

    await act(async () => {
      closeButton!.click();
    });
    await flush();

    expect(container.querySelector('.dialog')).toBeNull();
    expect(container.querySelector('[data-testid="project-detail-drawer"]')).not.toBeNull();

    const secondRunPlaybook = await waitForElement<HTMLButtonElement>(container, '[data-testid="run-playbook-btn"]');

    await act(async () => {
      secondRunPlaybook.click();
    });
    await waitForElement(container, '.dialog');

    expect(container.querySelector('.dialog')).not.toBeNull();
  });
});
