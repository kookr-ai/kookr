// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { TopBar } from './TopBar.js';
import { useKookrStore } from '../store/useStore.js';

let root: Root;
let container: HTMLDivElement;

function fetchResponse(body: unknown, ok = true, status = ok ? 200 : 500): Response {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function renderTopBar(): void {
  act(() => {
    root.render(
      React.createElement(TopBar, {
        findings: 0,
        currentIndex: -1,
        totalFindings: 0,
        onLaunch: vi.fn(),
        onCommandPalette: vi.fn(),
        onOperations: vi.fn(),
        onCoordinatorFindings: vi.fn(),
        onTerminalFocusToggle: vi.fn(),
      }),
    );
  });
}

describe('TopBar plugin update UX', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useKookrStore.setState({
      connected: true,
      buildInfo: {
        commitHash: 'abc123def456',
        commitShort: 'abc123d',
        branch: 'main',
        buildTimestamp: '2026-05-29T12:00:00.000Z',
        version: '0.0.0',
      },
      serverStartedAt: '2026-05-29T12:00:00.000Z',
      totalSpendUsd: 0,
      agents: [],
      circuitBreakers: [],
      diagnosticReport: null,
      coordinator: null,
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  test('runs the backend plugin update and keeps manual commands in details', async () => {
    const stalePlugin = {
      pluginId: 'kookr-toolkit@kookr',
      installedVersion: '0.4.1',
      availableVersion: '0.7.4',
      stale: true,
    };
    const currentPlugin = { ...stalePlugin, installedVersion: '0.7.4', stale: false };
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/deploy/status') {
        return Promise.resolve(fetchResponse({
          configured: true,
          available: false,
          runningPort: 4800,
          prodPort: 4800,
          plugin: stalePlugin,
        }));
      }
      if (url === '/api/deploy/plugin-update' && init?.method === 'POST') {
        return Promise.resolve(fetchResponse({
          status: 'updated',
          plugin: currentPlugin,
          commands: {
            slash: ['/plugin marketplace update kookr', '/plugin update kookr-toolkit@kookr'],
            cli: ['claude plugin marketplace update kookr', 'claude plugin update kookr-toolkit@kookr'],
          },
        }));
      }
      return Promise.resolve(fetchResponse({}, false, 404));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderTopBar();
    await flush();
    await act(async () => {
      container.querySelector<HTMLElement>('.version-badge')?.click();
    });

    expect(container.textContent).toContain('Toolkit plugin update available');
    expect(container.textContent).toContain('/plugin marketplace update kookr');

    const updateButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === 'Update plugin') as HTMLButtonElement | undefined;
    expect(updateButton).toBeDefined();
    await act(async () => {
      updateButton?.click();
    });
    await flush();

    expect(fetchMock).toHaveBeenCalledWith('/api/deploy/plugin-update', { method: 'POST' });
    expect(container.textContent).toContain('Toolkit plugin updated. Restart Claude Code sessions to load it.');
    expect(container.textContent).toContain('claude plugin update kookr-toolkit@kookr');
  });

  test('labels the health dot with the current dashboard connection state', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(fetchResponse({ configured: false }))));

    renderTopBar();
    await flush();

    const connectedDot = container.querySelector<HTMLElement>('.health-dot-connected');
    expect(connectedDot?.getAttribute('role')).toBe('img');
    expect(connectedDot?.getAttribute('aria-label')).toBe('Dashboard WebSocket connected');
    expect(connectedDot?.getAttribute('title')).toBe('Dashboard WebSocket connected');

    useKookrStore.setState({ connected: false });
    renderTopBar();

    const disconnectedDot = container.querySelector<HTMLElement>('.health-dot-disconnected');
    expect(disconnectedDot?.getAttribute('aria-label')).toBe('Dashboard WebSocket disconnected');
    expect(disconnectedDot?.getAttribute('title')).toBe('Dashboard WebSocket disconnected');
  });
});
