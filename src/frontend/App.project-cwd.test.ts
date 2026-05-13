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
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
}

describe('App project drawer launch cwd', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
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
        sourceCwd: '/server/cwd',
        scope: 'project',
      }],
      playbooksLastFetchedAt: Date.now(),
      playbooksLastFetchedCwd: '/server/cwd',
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
    await act(async () => {
      root.unmount();
    });
    document.body.innerHTML = '';
    localStorage.clear();
  });

  test('pre-fills Playbook task cwd from project localPath when the project has no agents', async () => {
    await act(async () => {
      root.render(React.createElement(App));
    });
    await flush();

    const runPlaybook = container.querySelector('[data-testid="run-playbook-btn"]');
    expect(runPlaybook).not.toBeNull();

    await act(async () => {
      runPlaybook!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    const cwdPaths = Array.from(container.querySelectorAll('.playbook-resolved-cwd-path'))
      .map((el) => el.textContent);
    expect(cwdPaths).toEqual(['/server/cwd', '/work/idle']);
  });

  test('opens a project manual task with the project cwd selected', async () => {
    await act(async () => {
      root.render(React.createElement(App));
    });
    await flush();

    const manualTask = container.querySelector('[data-testid="launch-manual-task-btn"]');
    expect(manualTask).not.toBeNull();

    await act(async () => {
      manualTask!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(container.querySelector('.dialog-tab.active')?.textContent).toBe('Manual');
    const cwdInput = container.querySelector<HTMLInputElement>('.combo-input input[type="text"]');
    expect(cwdInput?.value).toBe('/work/idle');
  });

  test('can reopen Playbook task from the same project drawer after closing the dialog', async () => {
    await act(async () => {
      root.render(React.createElement(App));
    });
    await flush();

    const firstRunPlaybook = container.querySelector('[data-testid="run-playbook-btn"]');
    expect(firstRunPlaybook).not.toBeNull();

    await act(async () => {
      firstRunPlaybook!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(container.querySelector('.dialog')).not.toBeNull();

    const closeButton = container.querySelector<HTMLButtonElement>('.dialog-close');
    expect(closeButton).not.toBeNull();

    await act(async () => {
      closeButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(container.querySelector('.dialog')).toBeNull();
    expect(container.querySelector('[data-testid="project-detail-drawer"]')).not.toBeNull();

    const secondRunPlaybook = container.querySelector('[data-testid="run-playbook-btn"]');
    expect(secondRunPlaybook).not.toBeNull();

    await act(async () => {
      secondRunPlaybook!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(container.querySelector('.dialog')).not.toBeNull();
  });
});
