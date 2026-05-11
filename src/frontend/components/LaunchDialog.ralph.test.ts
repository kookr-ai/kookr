// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { LaunchTaskDialog as LaunchDialog } from './LaunchTaskDialog.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import type { ClientMessage } from '../../shared/protocol.js';

function syncGlobalStore() {
  const freshState = createKookrStore().getState();
  const nextData = Object.fromEntries(
    Object.entries(freshState).filter(([, value]) => typeof value !== 'function'),
  );
  useKookrStore.setState(nextData);
}

async function flush() {
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
}

describe('LaunchDialog legacy Ralph task mode', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    syncGlobalStore();
    useKookrStore.setState({ serverCwd: '/tmp/work', sttUrl: '', alerts: [] });
    container = document.createElement('div');
    document.body.appendChild(container);
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  test('does not advertise the legacy generic Ralph launch mode', async () => {
    const sent: ClientMessage[] = [];
    const root = createRoot(container);
    act(() => {
      root.render(
        React.createElement(LaunchDialog, {
          send: (msg: ClientMessage) => {
            sent.push(msg);
            return true;
          },
          onClose: () => undefined,
        }),
      );
    });
    await flush();

    expect(container.querySelector('.ralph-mode-toggle')).toBeNull();
    expect(container.querySelector('input[name="ralph-iteration-cap"]')).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);

    act(() => root.unmount());
  });
});
