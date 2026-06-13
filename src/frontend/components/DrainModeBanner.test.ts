// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { createKookrStore, useKookrStore } from '../store/useStore.js';
import { DrainModeBanner } from './DrainModeBanner.js';

function syncGlobalStore() {
  const freshState = createKookrStore().getState();
  const nextData = Object.fromEntries(
    Object.entries(freshState).filter(([, value]) => typeof value !== 'function'),
  );
  useKookrStore.setState(nextData);
}

describe('DrainModeBanner', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    syncGlobalStore();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  test('renders nothing while the server is accepting launches', () => {
    act(() => {
      root.render(React.createElement(DrainModeBanner));
    });

    expect(container.querySelector('[data-testid="drain-mode-banner"]')).toBeNull();
  });

  test('renders a persistent warning while drain mode is active', () => {
    useKookrStore.setState({
      drainStatus: { accepting: false, draining: true, since: '2026-05-29T12:00:00.000Z' },
    });

    act(() => {
      root.render(React.createElement(DrainModeBanner));
    });

    expect(container.textContent).toContain('Drain mode');
    expect(container.textContent).toContain('New launches and scheduled starts are paused');
    expect(container.textContent).toContain('kookr resume');
  });
});
