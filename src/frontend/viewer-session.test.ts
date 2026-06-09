// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { READ_ONLY_BLOCKED_EVENT } from './auth-session.js';
import { useKookrStore } from './store/useStore.js';
import {
  __resetViewerSessionForTests,
  fetchViewerSession,
  formatViewerScope,
  installReadOnlyNoticeListener,
  isViewerCached,
  parseViewerSessionResponse,
  showReadOnlyNotice,
  useViewerGuardedSend,
  useViewerSession,
} from './viewer-session.js';
import type { ClientMessage } from '../shared/contracts/messages.js';

function clearAlerts(): void {
  // The singleton store is shared across tests; drain it between cases.
  let guard = 0;
  while (useKookrStore.getState().alerts.length > 0 && guard < 100) {
    useKookrStore.getState().dismissAlert(0);
    guard += 1;
  }
}

beforeEach(() => {
  __resetViewerSessionForTests();
  window.sessionStorage.clear();
  clearAlerts();
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetViewerSessionForTests();
  clearAlerts();
});

describe('parseViewerSessionResponse', () => {
  test('200 + viewer ⇒ viewer session with normalized scope', () => {
    expect(parseViewerSessionResponse(200, { actor: 'viewer', scope: { kind: 'projects', projectIds: ['p1'] } })).toEqual({
      isViewer: true,
      scope: { kind: 'projects', projectIds: ['p1'] },
    });
  });

  test('200 + viewer with malformed scope ⇒ default-deny to all', () => {
    expect(parseViewerSessionResponse(200, { actor: 'viewer', scope: { kind: 'bogus' } })).toEqual({
      isViewer: true,
      scope: { kind: 'all' },
    });
  });

  test('owner / non-200 / junk ⇒ owner session', () => {
    expect(parseViewerSessionResponse(200, { actor: 'owner' })).toEqual({ isViewer: false, scope: null });
    expect(parseViewerSessionResponse(401, null)).toEqual({ isViewer: false, scope: null });
    expect(parseViewerSessionResponse(200, 'nope')).toEqual({ isViewer: false, scope: null });
  });
});

describe('formatViewerScope', () => {
  test('all / null ⇒ whole dashboard', () => {
    expect(formatViewerScope(null)).toBe('the whole dashboard');
    expect(formatViewerScope({ kind: 'all' })).toBe('the whole dashboard');
  });

  test('projects ⇒ resolved names, with counts for 3+', () => {
    const names: Record<string, string> = { p1: 'Alpha', p2: 'Beta', p3: 'Gamma' };
    const resolve = (id: string) => names[id] ?? id;
    expect(formatViewerScope({ kind: 'projects', projectIds: ['p1'] }, resolve)).toBe('Alpha');
    expect(formatViewerScope({ kind: 'projects', projectIds: ['p1', 'p2'] }, resolve)).toBe('Alpha and Beta');
    expect(formatViewerScope({ kind: 'projects', projectIds: ['p1', 'p2', 'p3'] }, resolve)).toBe('3 projects');
    expect(formatViewerScope({ kind: 'projects', projectIds: [] })).toBe('no projects');
  });
});

describe('fetchViewerSession', () => {
  test('caches the viewer answer and persists it to sessionStorage', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ actor: 'viewer', scope: { kind: 'all' } }), { status: 200 })),
    );
    // Concurrent + sequential calls share the single in-flight probe.
    const [a, b] = await Promise.all([fetchViewerSession(), fetchViewerSession()]);
    const c = await fetchViewerSession();
    expect(a).toEqual({ isViewer: true, scope: { kind: 'all' } });
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(isViewerCached()).toBe(true);
    expect(window.sessionStorage.getItem('kookr.viewer.session')).toContain('"isViewer":true');
    // Three calls, one network round-trip.
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  test('a 401 / network failure resolves to the owner session', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('no', { status: 401 })));
    expect(await fetchViewerSession()).toEqual({ isViewer: false, scope: null });
    expect(isViewerCached()).toBe(false);
  });
});

describe('showReadOnlyNotice', () => {
  test('pushes one info alert and throttles a burst', () => {
    showReadOnlyNotice();
    showReadOnlyNotice();
    showReadOnlyNotice();
    const alerts = useKookrStore.getState().alerts;
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe('info');
    expect(alerts[0].summary).toMatch(/read-only/i);
  });
});

describe('installReadOnlyNoticeListener', () => {
  test('fires the notice on the blocked event only when the actor is a viewer', () => {
    installReadOnlyNoticeListener();
    // Owner cache (default): event is ignored.
    window.dispatchEvent(new CustomEvent(READ_ONLY_BLOCKED_EVENT));
    expect(useKookrStore.getState().alerts).toHaveLength(0);

    // Persist a viewer session so isViewerCached() is true, then dispatch again.
    window.sessionStorage.setItem('kookr.viewer.session', JSON.stringify({ isViewer: true, scope: { kind: 'all' } }));
    window.dispatchEvent(new CustomEvent(READ_ONLY_BLOCKED_EVENT));
    expect(useKookrStore.getState().alerts).toHaveLength(1);
  });
});

describe('useViewerGuardedSend', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function mountGuard(isViewer: boolean, rawSend: (m: ClientMessage) => boolean): { current: (m: ClientMessage) => boolean } {
    const ref: { current: (m: ClientMessage) => boolean } = { current: () => false };
    function Probe() {
      ref.current = useViewerGuardedSend(rawSend, isViewer);
      return null;
    }
    act(() => root.render(React.createElement(Probe)));
    return ref;
  }

  test('owner ⇒ delegates to the real send', () => {
    const rawSend = vi.fn(() => true);
    const guarded = mountGuard(false, rawSend);
    expect(guarded.current({ type: 'ping' } as unknown as ClientMessage)).toBe(true);
    expect(rawSend).toHaveBeenCalledTimes(1);
  });

  test('viewer ⇒ no-ops, returns false, and shows the read-only notice', () => {
    const rawSend = vi.fn(() => true);
    const guarded = mountGuard(true, rawSend);
    expect(guarded.current({ type: 'ping' } as unknown as ClientMessage)).toBe(false);
    expect(rawSend).not.toHaveBeenCalled();
    expect(useKookrStore.getState().alerts).toHaveLength(1);
  });
});

describe('useViewerSession', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  test('probes on mount and updates to the viewer session', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ actor: 'viewer', scope: { kind: 'all' } }), { status: 200 })),
    );
    let seen: { isViewer: boolean } = { isViewer: false };
    function Probe() {
      seen = useViewerSession();
      return null;
    }
    await act(async () => {
      root.render(React.createElement(Probe));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(seen.isViewer).toBe(true);
  });
});
