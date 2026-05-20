// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { Toasts } from './Toasts.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';

function syncGlobalStore() {
  const freshState = createKookrStore().getState();
  const nextData = Object.fromEntries(
    Object.entries(freshState).filter(([, value]) => typeof value !== 'function'),
  );
  useKookrStore.setState(nextData);
}

describe('Toasts', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    syncGlobalStore();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = '';
  });

  test('renders alert details under the summary', () => {
    useKookrStore.getState().handleAlert(
      '',
      'Error starting "demo": spawn failed',
      'error',
      'Run `pnpm run doctor` from the Kookr checkout.',
    );

    act(() => {
      root.render(React.createElement(Toasts));
    });

    expect(container.querySelector('.toast-message')?.textContent).toContain('Error starting "demo"');
    expect(container.querySelector('.toast-details')?.textContent).toContain('pnpm run doctor');
  });
});
