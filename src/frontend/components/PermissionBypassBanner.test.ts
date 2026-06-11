// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { createKookrStore, useKookrStore } from '../store/useStore.js';
import { PermissionBypassBanner } from './PermissionBypassBanner.js';

function syncGlobalStore() {
  const freshState = createKookrStore().getState();
  const nextData = Object.fromEntries(
    Object.entries(freshState).filter(([, value]) => typeof value !== 'function'),
  );
  useKookrStore.setState(nextData);
}

describe('PermissionBypassBanner', () => {
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

  test('renders nothing when bypass mode is inactive', () => {
    act(() => {
      root.render(React.createElement(PermissionBypassBanner));
    });

    expect(container.querySelector('[data-testid="permission-bypass-banner"]')).toBeNull();
  });

  test('renders the warning when bypass mode is active', () => {
    useKookrStore.setState({ bypassAllPermissions: true });

    act(() => {
      root.render(React.createElement(PermissionBypassBanner));
    });

    expect(container.textContent).toContain('Permissions bypassed');
    expect(container.textContent).toContain('without permission prompts');
  });
});
