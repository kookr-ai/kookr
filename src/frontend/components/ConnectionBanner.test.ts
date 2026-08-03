// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  DEPLOY_INTENT_TTL_MS,
  saveDeployIntent,
} from '../store/deploy-intent-storage.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import { ConnectionBanner } from './ConnectionBanner.js';

function syncGlobalStore() {
  const freshState = createKookrStore().getState();
  const nextData = Object.fromEntries(
    Object.entries(freshState).filter(([, value]) => typeof value !== 'function'),
  );
  useKookrStore.setState(nextData);
}

describe('ConnectionBanner', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useRealTimers();
    try {
      sessionStorage.clear();
    } catch {
      // ignore
    }
    syncGlobalStore();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    try {
      sessionStorage.clear();
    } catch {
      // ignore
    }
  });

  test('renders nothing while the main dashboard WebSocket is connected', () => {
    useKookrStore.setState({ connected: true, deploying: false });

    act(() => {
      root.render(React.createElement(ConnectionBanner));
    });

    expect(container.querySelector('[data-testid="connection-banner"]')).toBeNull();
  });

  test('renders accessible reconnect copy when disconnected without a deploy in flight', () => {
    useKookrStore.setState({ connected: false, deploying: false });

    act(() => {
      root.render(React.createElement(ConnectionBanner));
    });

    const banner = container.querySelector<HTMLElement>('[data-testid="connection-banner"]');
    expect(banner).not.toBeNull();
    expect(banner?.getAttribute('role')).toBe('status');
    expect(banner?.getAttribute('aria-live')).toBe('polite');
    expect(container.textContent).toContain('Reconnecting');
    expect(container.textContent).toContain('Dashboard data may be stale');
    expect(container.textContent).not.toContain('Redeploying production');
  });

  test('shows accessible redeploy copy when disconnected after deploying=true', () => {
    useKookrStore.setState({ connected: false, deploying: true });

    act(() => {
      root.render(React.createElement(ConnectionBanner));
    });

    const banner = container.querySelector<HTMLElement>('[data-testid="connection-banner"]');
    expect(banner).not.toBeNull();
    expect(banner?.getAttribute('role')).toBe('status');
    expect(banner?.getAttribute('aria-live')).toBe('polite');
    expect(container.textContent).toContain('Redeploying');
    expect(container.textContent).toContain(
      'Redeploying production — API should return within a few seconds',
    );
    expect(container.textContent).not.toContain('Dashboard data may be stale');
  });

  test('reload hydrates deploy window from sessionStorage and keeps redeploy copy (#1982)', () => {
    // Simulate a prior Deploy click in this tab session, then a full remount
    // (reload) while still disconnected — store must rehydrate from storage.
    saveDeployIntent(true, { preDeployCommit: 'abc123d', now: Date.now() });
    syncGlobalStore();
    useKookrStore.setState({ connected: false });

    expect(useKookrStore.getState().deploying).toBe(true);

    act(() => {
      root.render(React.createElement(ConnectionBanner));
    });

    expect(container.textContent).toContain('Redeploying');
    expect(container.textContent).toContain(
      'Redeploying production — API should return within a few seconds',
    );
  });

  test('clears redeploy copy when the deploy-window TTL elapses without remount (#1982)', () => {
    vi.useFakeTimers();
    const now = 1_700_000_000_000;
    vi.setSystemTime(now);
    // setDeploying so the store clear path matches production (sessionStorage + flag).
    act(() => {
      useKookrStore.getState().setDeploying(true, 'abc123d');
    });
    useKookrStore.setState({ connected: false });

    act(() => {
      root.render(React.createElement(ConnectionBanner));
    });
    expect(container.textContent).toContain('Redeploying');

    act(() => {
      vi.advanceTimersByTime(DEPLOY_INTENT_TTL_MS + 1);
    });

    expect(useKookrStore.getState().deploying).toBe(false);
    expect(sessionStorage.getItem('kookr.deploying')).toBeNull();
    expect(container.textContent).toContain('Reconnecting');
    expect(container.textContent).not.toContain('Redeploying production');
  });

  test('re-stamp mid-window re-arms the TTL instead of clearing early (#1982)', () => {
    vi.useFakeTimers();
    const t0 = 1_700_000_000_000;
    vi.setSystemTime(t0);
    act(() => {
      useKookrStore.getState().setDeploying(true, 'abc123d');
    });
    useKookrStore.setState({ connected: false });

    act(() => {
      root.render(React.createElement(ConnectionBanner));
    });
    expect(container.textContent).toContain('Redeploying');

    // Simulate reload + status poll re-assert halfway through the window:
    // stampedAt refreshes but `deploying` stays true so the effect does not re-run.
    const halfway = t0 + DEPLOY_INTENT_TTL_MS / 2;
    act(() => {
      vi.setSystemTime(halfway);
      useKookrStore.getState().setDeploying(true, 'abc123d');
    });

    // Old one-shot would have fired here; re-arm must keep redeploy copy.
    act(() => {
      vi.advanceTimersByTime(DEPLOY_INTENT_TTL_MS / 2 + 1);
    });
    expect(useKookrStore.getState().deploying).toBe(true);
    expect(container.textContent).toContain('Redeploying');

    // Full new window from re-stamp must still expire.
    act(() => {
      vi.advanceTimersByTime(DEPLOY_INTENT_TTL_MS);
    });
    expect(useKookrStore.getState().deploying).toBe(false);
    expect(container.textContent).toContain('Reconnecting');
  });
});
