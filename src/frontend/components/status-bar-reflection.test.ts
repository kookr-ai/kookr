// @vitest-environment jsdom

import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { StatusBar } from './StatusBar.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';

function syncGlobalStore() {
  const freshState = createKookrStore().getState();
  const nextData = Object.fromEntries(
    Object.entries(freshState).filter(([, value]) => typeof value !== 'function'),
  );
  useKookrStore.setState(nextData);
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('StatusBar reflection prompt', () => {
  let container: HTMLDivElement;
  let root: Root;
  let localStore: Map<string, string>;

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
  });

  test('renders reflection suggestion with actions', async () => {
    const onReflect = vi.fn();
    const onDismissReflection = vi.fn();

    await act(async () => {
      root.render(
        React.createElement(StatusBar, {
          findings: 0,
          total: 2,
          onShowShortcuts: vi.fn(),
          reflectionSuggestion: {
            sessionLabel: '09:00-09:45',
            summary: 'Session had 5 interventions and 2 friction signals.',
            totalInterventions: 5,
            totalFindings: 2,
          },
          onReflect,
          onDismissReflection,
        }),
      );
    });
    await flush();

    expect(container.textContent).toContain('Reflect on 09:00-09:45');
    expect(container.textContent).toContain('5 interventions');

    const buttons = Array.from(container.querySelectorAll('button'));
    const reflectButton = buttons.find((button) => button.textContent === 'Reflect');
    const dismissButton = buttons.find((button) => button.textContent === 'Dismiss');

    await act(async () => {
      reflectButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      dismissButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onReflect).toHaveBeenCalledTimes(1);
    expect(onDismissReflection).toHaveBeenCalledTimes(1);
  });
});
