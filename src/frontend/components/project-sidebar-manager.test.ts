// @vitest-environment jsdom

import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ProjectSidebarManager } from './ProjectSidebarManager.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import type { ProjectSummary } from '../../shared/protocol.js';

function syncGlobalStore() {
  const freshState = createKookrStore().getState();
  const nextData = Object.fromEntries(
    Object.entries(freshState).filter(([, value]) => typeof value !== 'function'),
  );
  useKookrStore.setState(nextData);
}

function summary(
  project: string,
  displayName: string,
  extras: Partial<ProjectSummary> = {},
): ProjectSummary {
  return {
    project,
    displayName,
    color: 1,
    activeAgents: 0,
    findingCount: 0,
    todayPrCount: 0,
    weekPrCount: 0,
    openPrs: 0,
    recentTasks: [],
    ...extras,
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('ProjectSidebarManager untrack affordance', () => {
  let container: HTMLDivElement;
  let root: Root;
  let localStore: Map<string, string>;
  let fetchMock: ReturnType<typeof vi.fn>;

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
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
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
    vi.unstubAllGlobals();
  });

  test('renders a dedicated scrollable body wrapper around panel content', async () => {
    useKookrStore.getState().handleProjectSummaries([
      summary('github.com/grafana/grafana', 'grafana/grafana', { tracked: true }),
    ]);

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ projects: [], warnings: [] }),
    });

    await act(async () => {
      root.render(React.createElement(ProjectSidebarManager, { onClose: vi.fn() }));
    });
    await flush();

    const body = container.querySelector('[data-testid="project-sidebar-manager-body"]');
    expect(body).not.toBeNull();
    expect(body?.textContent).toContain('Track OSS repository');
    expect(body?.textContent).toContain('Visible');
    expect(body?.textContent).toContain('Hidden / Offline');
  });

  test('shows Untrack button only on rows whose summary has tracked:true', async () => {
    useKookrStore.getState().handleProjectSummaries([
      summary('github.com/grafana/grafana', 'grafana/grafana', { tracked: true }),
      summary('github.com/n8n-io/n8n', 'n8n-io/n8n'), // skill-discovered, no tracked
      summary('github.com/foo/bar', 'foo/bar', { activeAgents: 1 }), // activity-based, no tracked
    ]);

    // discovery-status fetch is called on mount — answer it.
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ projects: [], warnings: [] }),
    });

    await act(async () => {
      root.render(React.createElement(ProjectSidebarManager, { onClose: vi.fn() }));
    });
    await flush();

    // Only the tracked row exposes an Untrack button.
    const trackedBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="project-sidebar-untrack-github.com/grafana/grafana"]',
    );
    expect(trackedBtn).not.toBeNull();
    expect(trackedBtn?.textContent).toContain('Untrack');

    expect(
      container.querySelector('[data-testid="project-sidebar-untrack-github.com/n8n-io/n8n"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="project-sidebar-untrack-github.com/foo/bar"]'),
    ).toBeNull();
  });

  test('clicking Untrack calls /api/projects/untrack with normalized owner/repo', async () => {
    useKookrStore.getState().handleProjectSummaries([
      summary('github.com/grafana/grafana', 'grafana/grafana', { tracked: true }),
    ]);

    fetchMock.mockImplementation((url: string) => {
      if (typeof url === 'string' && url.startsWith('/api/projects/discovery-status')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ projects: [], warnings: [] }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ project: 'github.com/grafana/grafana', removed: true, config: null }),
      });
    });

    await act(async () => {
      root.render(React.createElement(ProjectSidebarManager, { onClose: vi.fn() }));
    });
    await flush();

    const untrackBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="project-sidebar-untrack-github.com/grafana/grafana"]',
    );
    expect(untrackBtn).not.toBeNull();

    await act(async () => {
      untrackBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    const untrackCall = fetchMock.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0] === '/api/projects/untrack',
    );
    expect(untrackCall).toBeDefined();
    const body = JSON.parse(untrackCall![1].body);
    expect(body.repo).toBe('grafana/grafana');
  });

  test('untrack error message is rendered and row keeps its button', async () => {
    useKookrStore.getState().handleProjectSummaries([
      summary('github.com/grafana/grafana', 'grafana/grafana', { tracked: true }),
    ]);

    fetchMock.mockImplementation((url: string) => {
      if (typeof url === 'string' && url.startsWith('/api/projects/discovery-status')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ projects: [], warnings: [] }),
        });
      }
      return Promise.resolve({
        ok: false,
        status: 500,
        json: async () => ({ error: 'boom' }),
      });
    });

    await act(async () => {
      root.render(React.createElement(ProjectSidebarManager, { onClose: vi.fn() }));
    });
    await flush();

    const untrackBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="project-sidebar-untrack-github.com/grafana/grafana"]',
    );
    await act(async () => {
      untrackBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(container.textContent).toContain('boom');
    // Project is still present (server rejected) so button still there.
    expect(
      container.querySelector('[data-testid="project-sidebar-untrack-github.com/grafana/grafana"]'),
    ).not.toBeNull();
  });
});
