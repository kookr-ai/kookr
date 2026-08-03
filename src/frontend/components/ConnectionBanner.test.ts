// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

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
});
