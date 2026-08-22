// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { LaunchTaskDialog, looksLikeAbsoluteClipboardPath } from './LaunchTaskDialog.js';
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

function setInputValue(el: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function getPromptEl(container: HTMLElement): HTMLTextAreaElement {
  const el = container.querySelector('textarea');
  if (!el) throw new Error('textarea not rendered');
  return el as HTMLTextAreaElement;
}

function getPasteChip(container: HTMLElement): HTMLButtonElement {
  const el = container.querySelector('.paste-prompt-chip');
  if (!el) throw new Error('paste chip not rendered');
  return el as HTMLButtonElement;
}

/** Install a `navigator.clipboard.readText` stub for the duration of a test. */
function stubReadText(readText: () => Promise<string>): void {
  Object.defineProperty(navigator, 'clipboard', {
    value: { readText },
    configurable: true,
  });
}

function renderDialog(container: HTMLElement, opts: { defaultPrompt?: string } = {}): Root {
  const root = createRoot(container);
  act(() => {
    root.render(
      React.createElement(LaunchTaskDialog, {
        send: (_msg: ClientMessage) => true,
        onClose: () => {},
        defaultCwd: '/tmp/work',
        defaultPrompt: opts.defaultPrompt,
      }),
    );
  });
  return root;
}

describe('LaunchTaskDialog paste-from-clipboard chip', () => {
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
    // Clear the per-test clipboard stub so it never leaks into other suites.
    Reflect.deleteProperty(navigator, 'clipboard');
    vi.restoreAllMocks();
  });

  test('a successful paste fills the task description with the trimmed clipboard text', async () => {
    stubReadText(() => Promise.resolve('  Fix the flaky login test  '));
    const root = renderDialog(container);
    await flush();

    expect(getPromptEl(container).value).toBe('');

    await act(async () => { getPasteChip(container).click(); });
    await flush();

    expect(getPromptEl(container).value).toBe('Fix the flaky login test');
    root.unmount();
  });

  test('a denied clipboard read leaves an existing prompt unchanged', async () => {
    stubReadText(() => Promise.reject(new DOMException('denied', 'NotAllowedError')));
    const alert = vi.fn();
    useKookrStore.setState({ handleAlert: alert });

    const root = renderDialog(container, { defaultPrompt: 'operator already typed this' });
    await flush();

    const prompt = getPromptEl(container);
    expect(prompt.value).toBe('operator already typed this');

    await act(async () => { getPasteChip(container).click(); });
    await flush();

    expect(prompt.value).toBe('operator already typed this');
    expect(alert).toHaveBeenCalledWith('', expect.stringContaining('Nothing to paste'), 'info');
    root.unmount();
  });

  test('an empty clipboard does not overwrite a typed prompt', async () => {
    stubReadText(() => Promise.resolve('   '));
    const root = renderDialog(container);
    await flush();

    const prompt = getPromptEl(container);
    await act(async () => { setInputValue(prompt, 'keep me'); });
    await flush();

    await act(async () => { getPasteChip(container).click(); });
    await flush();

    expect(prompt.value).toBe('keep me');
    root.unmount();
  });

  test('a missing Clipboard API falls back without overwriting a typed prompt', async () => {
    // No navigator.clipboard at all — the non-secure-origin / unsupported case,
    // distinct from a denied read. readClipboardText() must return null.
    Reflect.deleteProperty(navigator, 'clipboard');
    const alert = vi.fn();
    useKookrStore.setState({ handleAlert: alert });

    const root = renderDialog(container);
    await flush();

    const prompt = getPromptEl(container);
    await act(async () => { setInputValue(prompt, 'keep me'); });
    await flush();

    await act(async () => { getPasteChip(container).click(); });
    await flush();

    expect(prompt.value).toBe('keep me');
    expect(alert).toHaveBeenCalledWith('', expect.stringContaining('Nothing to paste'), 'info');
    root.unmount();
  });

  test('a successful paste replaces an already-typed prompt', async () => {
    stubReadText(() => Promise.resolve('pasted issue body'));
    const root = renderDialog(container);
    await flush();

    const prompt = getPromptEl(container);
    await act(async () => { setInputValue(prompt, 'half-typed note'); });
    await flush();

    await act(async () => { getPasteChip(container).click(); });
    await flush();

    expect(prompt.value).toBe('pasted issue body');
    root.unmount();
  });
});

function getCwdEl(container: HTMLElement): HTMLInputElement {
  const el = container.querySelector('.combo-input input[type="text"]');
  if (!el) throw new Error('cwd input not rendered');
  return el as HTMLInputElement;
}

function getClipboardCwdButton(container: HTMLElement): HTMLButtonElement {
  const el = container.querySelector('.cwd-clipboard-button');
  if (!el) throw new Error('clipboard-path cwd button not rendered');
  return el as HTMLButtonElement;
}

describe('looksLikeAbsoluteClipboardPath', () => {
  test('accepts absolute unix and home-relative paths', () => {
    expect(looksLikeAbsoluteClipboardPath('/tmp/demo-repo')).toBe(true);
    expect(looksLikeAbsoluteClipboardPath('~/git/demo')).toBe(true);
    expect(looksLikeAbsoluteClipboardPath('  /tmp/demo-repo\n')).toBe(true);
    expect(looksLikeAbsoluteClipboardPath('~/')).toBe(true);
  });

  test('rejects prose, relative paths, and empty text', () => {
    expect(looksLikeAbsoluteClipboardPath('Please fix the login bug.')).toBe(false);
    expect(looksLikeAbsoluteClipboardPath('tmp/demo-repo')).toBe(false);
    expect(looksLikeAbsoluteClipboardPath('~')).toBe(false);
    expect(looksLikeAbsoluteClipboardPath('')).toBe(false);
    expect(looksLikeAbsoluteClipboardPath('   ')).toBe(false);
  });
});

describe('LaunchTaskDialog clipboard-path cwd action', () => {
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
    Reflect.deleteProperty(navigator, 'clipboard');
    vi.restoreAllMocks();
  });

  test('a clipboard absolute path fills Working directory', async () => {
    stubReadText(() => Promise.resolve('  /tmp/demo-repo  '));
    const root = renderDialog(container);
    await flush();

    expect(getCwdEl(container).value).toBe('/tmp/work');

    await act(async () => { getClipboardCwdButton(container).click(); });
    await flush();

    expect(getCwdEl(container).value).toBe('/tmp/demo-repo');
    root.unmount();
  });

  test('a clipboard home-relative path fills Working directory', async () => {
    stubReadText(() => Promise.resolve('~/git/demo'));
    const root = renderDialog(container);
    await flush();

    await act(async () => { getClipboardCwdButton(container).click(); });
    await flush();

    expect(getCwdEl(container).value).toBe('~/git/demo');
    root.unmount();
  });

  test('a multi-line clipboard uses the first line when it is a path', async () => {
    stubReadText(() => Promise.resolve('/tmp/demo-repo\nextra terminal noise'));
    const root = renderDialog(container);
    await flush();

    await act(async () => { getClipboardCwdButton(container).click(); });
    await flush();

    expect(getCwdEl(container).value).toBe('/tmp/demo-repo');
    root.unmount();
  });

  test('a multi-line clipboard does not hunt later lines for a path', async () => {
    stubReadText(() => Promise.resolve('Please fix the login bug.\n/tmp/demo-repo'));
    const alert = vi.fn();
    useKookrStore.setState({ handleAlert: alert });

    const root = renderDialog(container);
    await flush();

    await act(async () => { getClipboardCwdButton(container).click(); });
    await flush();

    expect(getCwdEl(container).value).toBe('/tmp/work');
    expect(alert).toHaveBeenCalledWith('', expect.stringContaining('not a path'), 'info');
    root.unmount();
  });

  test('prose on the clipboard does not change cwd and explains it is not a path', async () => {
    stubReadText(() => Promise.resolve('Please fix the login bug in src/auth.ts'));
    const alert = vi.fn();
    useKookrStore.setState({ handleAlert: alert });

    const root = renderDialog(container);
    await flush();
    expect(getCwdEl(container).value).toBe('/tmp/work');

    await act(async () => { getClipboardCwdButton(container).click(); });
    await flush();

    expect(getCwdEl(container).value).toBe('/tmp/work');
    expect(alert).toHaveBeenCalledWith('', expect.stringContaining('not a path'), 'info');
    root.unmount();
  });

  test('an empty clipboard does not change cwd or throw', async () => {
    stubReadText(() => Promise.resolve('   '));
    const alert = vi.fn();
    useKookrStore.setState({ handleAlert: alert });

    const root = renderDialog(container);
    await flush();

    await act(async () => { getClipboardCwdButton(container).click(); });
    await flush();

    expect(getCwdEl(container).value).toBe('/tmp/work');
    expect(alert).toHaveBeenCalledWith('', expect.stringContaining('Nothing to paste'), 'info');
    root.unmount();
  });

  test('a denied clipboard read does not change cwd or throw', async () => {
    stubReadText(() => Promise.reject(new DOMException('denied', 'NotAllowedError')));
    const alert = vi.fn();
    useKookrStore.setState({ handleAlert: alert });

    const root = renderDialog(container);
    await flush();

    await act(async () => { getClipboardCwdButton(container).click(); });
    await flush();

    expect(getCwdEl(container).value).toBe('/tmp/work');
    expect(alert).toHaveBeenCalledWith('', expect.stringContaining('Nothing to paste'), 'info');
    root.unmount();
  });

  test('opening the dialog does not read the clipboard', async () => {
    const readText = vi.fn(() => Promise.resolve('/tmp/should-not-apply'));
    stubReadText(readText);
    const root = renderDialog(container);
    await flush();

    expect(readText).not.toHaveBeenCalled();
    expect(getCwdEl(container).value).toBe('/tmp/work');
    root.unmount();
  });
});
