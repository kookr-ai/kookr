// @vitest-environment jsdom

import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QuickLaunch } from './QuickLaunch.js';
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
  // Two microtask turns: the cwd-resolve effect and any follow-up state set.
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
}

/**
 * React attaches a property setter to HTMLInputElement.value; to trigger an
 * onChange reliably in jsdom we have to use the prototype's native setter so
 * React's internal input-tracker sees a value change.
 */
function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('QuickLaunch optimistic toast', () => {
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
    useKookrStore.setState({ serverCwd: '/tmp/work' });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  test('submitting a prompt sends first, then pushes a "Starting task" info toast on success', async () => {
    const sent: ClientMessage[] = [];
    let alertWhenSent: number | null = null;
    const send = (msg: ClientMessage): boolean => {
      alertWhenSent = useKookrStore.getState().alerts.length;
      sent.push(msg);
      return true;
    };
    await act(async () => {
      root.render(React.createElement(QuickLaunch, { send, onClose: () => {} }));
    });
    await flush();

    const input = container.querySelector('input.quick-launch-input') as HTMLInputElement;
    expect(input).toBeTruthy();
    await act(async () => { setInputValue(input, 'Add pagination to the /users route'); });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    // Send happens BEFORE the toast is pushed — reviewer flagged the prior
    // ordering because useWebSocket.send returns false when the socket is
    // closed; pushing the "Starting task" toast first would lie to the user.
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe('launch');
    expect(alertWhenSent).toBe(0);

    const { alerts } = useKookrStore.getState();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe('info');
    expect(alerts[0].summary).toBe('Starting task: Add pagination to the /users route');
  });

  test('long prompts are truncated to 40 chars with ellipsis in the toast', async () => {
    const send = (_msg: ClientMessage): boolean => true;
    await act(async () => {
      root.render(React.createElement(QuickLaunch, { send, onClose: () => {} }));
    });
    await flush();

    const input = container.querySelector('input.quick-launch-input') as HTMLInputElement;
    const long = 'y'.repeat(60);
    await act(async () => { setInputValue(input, long); });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    const { alerts } = useKookrStore.getState();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].summary).toBe(`Starting task: ${'y'.repeat(40)}…`);
  });

  test('empty or whitespace-only prompts do not push a toast', async () => {
    const sent: ClientMessage[] = [];
    await act(async () => {
      root.render(React.createElement(QuickLaunch, {
        send: (m) => { sent.push(m); return true; },
        onClose: () => {},
      }));
    });
    await flush();

    const input = container.querySelector('input.quick-launch-input') as HTMLInputElement;
    await act(async () => { setInputValue(input, '   '); });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    expect(sent).toHaveLength(0);
    expect(useKookrStore.getState().alerts).toHaveLength(0);
  });

  test('when send returns false (socket closed), shows an error toast instead of an info toast', async () => {
    const sent: ClientMessage[] = [];
    const send = (msg: ClientMessage): boolean => {
      sent.push(msg);
      return false; // socket not open
    };
    await act(async () => {
      root.render(React.createElement(QuickLaunch, { send, onClose: () => {} }));
    });
    await flush();

    const input = container.querySelector('input.quick-launch-input') as HTMLInputElement;
    await act(async () => { setInputValue(input, 'Fix the nav bug'); });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    expect(sent).toHaveLength(1);
    const { alerts } = useKookrStore.getState();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe('error');
    expect(alerts[0].summary).toBe('Could not start task: not connected. Fix the nav bug');
  });
});
