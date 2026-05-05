// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { LaunchTaskDialog } from './LaunchTaskDialog.js';
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

function setInputValue(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function getCwdEl(container: HTMLElement): HTMLInputElement {
  const el = container.querySelector('.combo-input input[type="text"]');
  if (!el) throw new Error('cwd input not rendered');
  return el as HTMLInputElement;
}

function getServerCwdButton(container: HTMLElement): HTMLButtonElement | null {
  return container.querySelector('.cwd-server-button') as HTMLButtonElement | null;
}

function renderDialog(container: HTMLElement, serverCwd: string): { root: Root } {
  // serverCwd is set on the global store in beforeEach; this just helps the
  // call-site read clearly.
  useKookrStore.setState({ serverCwd, sttUrl: '' });
  const root = createRoot(container);
  act(() => {
    root.render(
      React.createElement(LaunchTaskDialog, {
        send: (_msg: ClientMessage) => true,
        onClose: () => {},
      }),
    );
  });
  return { root };
}

describe('LaunchTaskDialog server-cwd button', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    syncGlobalStore();
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
  });

  test('button is hidden when cwd already equals server cwd (non-protected case)', async () => {
    const { root } = renderDialog(container, '/home/jean/git/myrepo');
    await flush();

    // No MRU, no draft → cwd auto-populates to serverCwd → button hidden.
    expect(getCwdEl(container).value).toBe('/home/jean/git/myrepo');
    expect(getServerCwdButton(container)).toBeNull();

    act(() => root.unmount());
  });

  test('button populates cwd with server cwd when user has typed a different path', async () => {
    const { root } = renderDialog(container, '/home/jean/git/myrepo');
    await flush();

    // User types a different path.
    await act(async () => { setInputValue(getCwdEl(container), '/elsewhere'); });
    await flush();

    const button = getServerCwdButton(container);
    expect(button).not.toBeNull();
    expect(button!.textContent).toContain('/home/jean/git/myrepo');

    await act(async () => {
      button!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(getCwdEl(container).value).toBe('/home/jean/git/myrepo');
    // Now hidden again.
    expect(getServerCwdButton(container)).toBeNull();

    act(() => root.unmount());
  });

  test('protected server cwd: button derives parent and labels accordingly', async () => {
    const { root } = renderDialog(container, '/home/jean/git/kookr-prod');
    await flush();

    // The dialog auto-populated cwd with serverCwd verbatim ('/home/jean/git/kookr-prod').
    // The button's *target* is the parent path, so the button is visible
    // because cwd ('/home/jean/git/kookr-prod') !== target ('/home/jean/git/kookr').
    const button = getServerCwdButton(container);
    expect(button).not.toBeNull();
    expect(button!.textContent).toContain('Use parent of server cwd');
    expect(button!.textContent).toContain('/home/jean/git/kookr');

    await act(async () => {
      button!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(getCwdEl(container).value).toBe('/home/jean/git/kookr');
    // Now matches target → hidden.
    expect(getServerCwdButton(container)).toBeNull();

    act(() => root.unmount());
  });
});
