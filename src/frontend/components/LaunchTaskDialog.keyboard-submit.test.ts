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

function setInputValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function getPromptEl(container: HTMLElement): HTMLTextAreaElement {
  const el = container.querySelector('textarea');
  if (!el) throw new Error('textarea not rendered');
  return el as HTMLTextAreaElement;
}

interface KeydownInit {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
}

function dispatchKeydown(el: HTMLElement, init: KeydownInit): boolean {
  const event = new KeyboardEvent('keydown', {
    key: init.key,
    ctrlKey: init.ctrlKey ?? false,
    metaKey: init.metaKey ?? false,
    altKey: init.altKey ?? false,
    bubbles: true,
    cancelable: true,
  });
  // isComposing is readonly on KeyboardEvent; override for the IME-guard case.
  if (init.isComposing) {
    Object.defineProperty(event, 'isComposing', { value: true });
  }
  el.dispatchEvent(event);
  return event.defaultPrevented;
}

interface RenderResult {
  root: Root;
  sent: ClientMessage[];
  closeCalls: { count: number };
}

function renderDialog(container: HTMLElement): RenderResult {
  const sent: ClientMessage[] = [];
  const closeCalls = { count: 0 };
  const root = createRoot(container);
  act(() => {
    root.render(
      React.createElement(LaunchTaskDialog, {
        send: (msg: ClientMessage) => { sent.push(msg); return true; },
        onClose: () => { closeCalls.count++; },
      }),
    );
  });
  return { root, sent, closeCalls };
}

describe('LaunchTaskDialog keyboard submit', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    syncGlobalStore();
    useKookrStore.setState({ serverCwd: '/tmp/work', sttUrl: '' });
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
  });

  test('Ctrl+Enter submits a valid form', async () => {
    const { root, sent, closeCalls } = renderDialog(container);
    await flush();

    const prompt = getPromptEl(container);
    await act(async () => { setInputValue(prompt, 'do the thing'); });
    await flush();

    let prevented = false;
    await act(async () => { prevented = dispatchKeydown(prompt, { key: 'Enter', ctrlKey: true }); });
    await flush();

    expect(prevented).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'launch', prompt: 'do the thing', cwd: '/tmp/work' });
    expect(closeCalls.count).toBe(1);

    act(() => root.unmount());
  });

  test('Cmd+Enter (metaKey) submits a valid form', async () => {
    const { root, sent } = renderDialog(container);
    await flush();

    const prompt = getPromptEl(container);
    await act(async () => { setInputValue(prompt, 'mac submit'); });
    await flush();

    await act(async () => { dispatchKeydown(prompt, { key: 'Enter', metaKey: true }); });
    await flush();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'launch', prompt: 'mac submit' });

    act(() => root.unmount());
  });

  test('plain Enter does not submit (leaves newline handling to the textarea)', async () => {
    const { root, sent, closeCalls } = renderDialog(container);
    await flush();

    const prompt = getPromptEl(container);
    await act(async () => { setInputValue(prompt, 'still typing'); });
    await flush();

    let prevented = false;
    await act(async () => { prevented = dispatchKeydown(prompt, { key: 'Enter' }); });
    await flush();

    expect(prevented).toBe(false);
    expect(sent).toHaveLength(0);
    expect(closeCalls.count).toBe(0);

    act(() => root.unmount());
  });

  test('Ctrl+Enter during IME composition does not submit', async () => {
    const { root, sent } = renderDialog(container);
    await flush();

    const prompt = getPromptEl(container);
    await act(async () => { setInputValue(prompt, 'composing'); });
    await flush();

    await act(async () => { dispatchKeydown(prompt, { key: 'Enter', ctrlKey: true, isComposing: true }); });
    await flush();

    expect(sent).toHaveLength(0);

    act(() => root.unmount());
  });

  test('Ctrl+Enter with an empty prompt does not submit', async () => {
    const { root, sent, closeCalls } = renderDialog(container);
    await flush();

    const prompt = getPromptEl(container);
    await act(async () => { dispatchKeydown(prompt, { key: 'Enter', ctrlKey: true }); });
    await flush();

    expect(sent).toHaveLength(0);
    expect(closeCalls.count).toBe(0);

    act(() => root.unmount());
  });
});
