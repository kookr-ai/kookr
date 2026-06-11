// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { ReadOnlyBanner } from './ReadOnlyBanner.js';
import { __resetViewerSessionForTests } from '../viewer-session.js';
import { useKookrStore } from '../store/useStore.js';

describe('ReadOnlyBanner', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    __resetViewerSessionForTests();
    window.sessionStorage.clear();
    // Probe never resolves to viewer here; the seeded cache drives the render.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('no', { status: 401 })));
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    __resetViewerSessionForTests();
  });

  test('renders nothing for the owner', async () => {
    await act(async () => {
      root.render(React.createElement(ReadOnlyBanner));
    });
    expect(container.querySelector('.read-only-banner')).toBeNull();
  });

  test('renders the whole-dashboard label for an all-scope viewer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ actor: 'viewer', scope: { kind: 'all' } }), { status: 200 })),
    );
    window.sessionStorage.setItem(
      'kookr.viewer.session',
      JSON.stringify({ isViewer: true, scope: { kind: 'all' } }),
    );
    await act(async () => {
      root.render(React.createElement(ReadOnlyBanner));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const banner = container.querySelector('.read-only-banner');
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain('the whole dashboard');
  });

  test('renders the banner with a resolved project-scope label for a viewer', async () => {
    // The identity probe confirms a project-scoped viewer.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ actor: 'viewer', scope: { kind: 'projects', projectIds: ['p1'] } }), { status: 200 })),
    );
    // Seed the same viewer session so the first render shows the banner immediately.
    window.sessionStorage.setItem(
      'kookr.viewer.session',
      JSON.stringify({ isViewer: true, scope: { kind: 'projects', projectIds: ['p1'] } }),
    );
    useKookrStore.setState({
      projectSummaries: [
        {
          project: 'p1',
          displayName: 'Alpha',
          color: 0,
          activeAgents: 0,
          findingCount: 0,
          todayPrCount: 0,
          weekPrCount: 0,
          openContributionAttempts: 0,
          recentTasks: [],
        },
      ],
    } as never);

    await act(async () => {
      root.render(React.createElement(ReadOnlyBanner));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const banner = container.querySelector('.read-only-banner');
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain('Alpha');
    expect(banner?.textContent?.toLowerCase()).toContain('read-only');
  });
});
