// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { createKookrStore, useKookrStore } from '../store/useStore.js';
import { SafeModeBanner } from './SafeModeBanner.js';

function syncGlobalStore() {
  const freshState = createKookrStore().getState();
  const nextData = Object.fromEntries(
    Object.entries(freshState).filter(([, value]) => typeof value !== 'function'),
  );
  useKookrStore.setState(nextData);
}

describe('SafeModeBanner', () => {
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

  test('renders nothing while SAFE MODE is disengaged', () => {
    act(() => {
      root.render(React.createElement(SafeModeBanner));
    });

    expect(container.querySelector('[data-testid="safe-mode-banner"]')).toBeNull();
  });

  test('renders SAFE MODE since <ts> while the kill-switch is engaged', () => {
    useKookrStore.setState({
      safeMode: { engaged: true, since: '2026-08-01T12:00:00.000Z' },
    });

    act(() => {
      root.render(React.createElement(SafeModeBanner));
    });

    expect(container.textContent).toContain('SAFE MODE since 2026-08-01T12:00:00.000Z');
    expect(container.textContent).toContain('schedule fires and autonomous launches are paused');
  });
});
