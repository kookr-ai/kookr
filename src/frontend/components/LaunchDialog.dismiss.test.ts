// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { LaunchDialog } from './LaunchDialog.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import { LAUNCH_DIALOG_DRAFT_KEY } from '../store/launch-dialog-draft.js';
import type { ClientMessage } from '../../shared/protocol.js';

const DRAFT_KEY = LAUNCH_DIALOG_DRAFT_KEY;

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

function getOverlay(container: HTMLElement): HTMLElement {
  const el = container.querySelector('.dialog-overlay');
  if (!el) throw new Error('overlay not rendered');
  return el as HTMLElement;
}

function getDialog(container: HTMLElement): HTMLElement {
  const el = container.querySelector('.dialog');
  if (!el) throw new Error('dialog not rendered');
  return el as HTMLElement;
}

function getPromptEl(container: HTMLElement): HTMLTextAreaElement {
  const el = container.querySelector('textarea');
  if (!el) throw new Error('textarea not rendered');
  return el as HTMLTextAreaElement;
}

function getCriteriaEl(container: HTMLElement): HTMLInputElement {
  const inputs = Array.from(container.querySelectorAll('input[type="text"]')) as HTMLInputElement[];
  if (inputs.length < 2) throw new Error('criteria input not rendered');
  return inputs[1];
}

interface RenderOpts {
  defaultPrompt?: string;
  defaultCwd?: string;
  defaultCriteria?: string;
  onClose?: () => void;
}

function renderDialog(container: HTMLElement, opts: RenderOpts = {}): { root: Root; closeCalls: { count: number } } {
  const closeCalls = { count: 0 };
  const root = createRoot(container);
  act(() => {
    root.render(
      React.createElement(LaunchDialog, {
        send: (_msg: ClientMessage) => true,
        onClose: () => {
          closeCalls.count++;
          opts.onClose?.();
        },
        defaultCwd: opts.defaultCwd,
        defaultPrompt: opts.defaultPrompt,
        defaultCriteria: opts.defaultCriteria,
      }),
    );
  });
  return { root, closeCalls };
}

describe('LaunchDialog dismiss behavior', () => {
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

  test('clicking on the .dialog-overlay does not close the dialog (empty form)', async () => {
    const { root, closeCalls } = renderDialog(container);
    await flush();

    const overlay = getOverlay(container);
    await act(async () => {
      overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(closeCalls.count).toBe(0);
    expect(getDialog(container)).toBeTruthy();

    act(() => root.unmount());
  });

  test('clicking on the .dialog-overlay does not close the dialog (with typed content)', async () => {
    const { root, closeCalls } = renderDialog(container);
    await flush();

    await act(async () => { setInputValue(getPromptEl(container), 'half-typed thought'); });
    await flush();

    const overlay = getOverlay(container);
    await act(async () => {
      overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(closeCalls.count).toBe(0);
    expect(getPromptEl(container).value).toBe('half-typed thought');

    act(() => root.unmount());
  });

  test('the X close button closes the dialog', async () => {
    const { root, closeCalls } = renderDialog(container);
    await flush();

    const closeBtn = container.querySelector('.dialog-close') as HTMLButtonElement;
    expect(closeBtn).toBeTruthy();
    await act(async () => {
      closeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(closeCalls.count).toBe(1);

    act(() => root.unmount());
  });

  test('the Cancel button closes the dialog', async () => {
    const { root, closeCalls } = renderDialog(container);
    await flush();

    // Cancel is the .btn-secondary in .dialog-actions
    const cancel = container.querySelector('.dialog-actions .btn-secondary') as HTMLButtonElement;
    expect(cancel).toBeTruthy();
    await act(async () => {
      cancel.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(closeCalls.count).toBe(1);

    act(() => root.unmount());
  });

  test('Escape closes the dialog', async () => {
    const { root, closeCalls } = renderDialog(container);
    await flush();

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await flush();

    expect(closeCalls.count).toBe(1);

    act(() => root.unmount());
  });
});

describe('LaunchDialog draft-restored banner', () => {
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

  test('renders the banner when a stored draft has restored content', async () => {
    localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({ prompt: 'restored task', cwd: '', criteria: '' }),
    );

    const { root } = renderDialog(container);
    await flush();

    const banner = container.querySelector('.draft-restored-banner');
    expect(banner).toBeTruthy();
    expect(banner!.textContent).toContain('Restored your last draft');
    expect(getPromptEl(container).value).toBe('restored task');

    act(() => root.unmount());
  });

  test('does not render the banner when no stored draft exists', async () => {
    const { root } = renderDialog(container);
    await flush();

    const banner = container.querySelector('.draft-restored-banner');
    expect(banner).toBeNull();

    act(() => root.unmount());
  });

  test('does not render the banner in relaunch mode even if a draft exists', async () => {
    localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({ prompt: 'my draft', cwd: '/my/repo', criteria: '' }),
    );

    const { root } = renderDialog(container, { defaultPrompt: 'relaunched' });
    await flush();

    const banner = container.querySelector('.draft-restored-banner');
    expect(banner).toBeNull();
    expect(getPromptEl(container).value).toBe('relaunched');

    act(() => root.unmount());
  });

  test('does not render the banner for a draft whose prompt and criteria are both empty', async () => {
    // saveLaunchDialogDraft already clears empty drafts, but defend against a
    // hand-rolled / pre-existing key that snuck in via a different code path.
    localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({ prompt: '   ', cwd: '/x', criteria: '' }),
    );

    const { root } = renderDialog(container);
    await flush();

    expect(container.querySelector('.draft-restored-banner')).toBeNull();

    act(() => root.unmount());
  });

  test('clicking Discard draft clears fields, removes localStorage entry, and hides banner', async () => {
    localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({ prompt: 'old draft', cwd: '/x', criteria: 'old criteria' }),
    );

    const { root } = renderDialog(container);
    await flush();

    expect(container.querySelector('.draft-restored-banner')).toBeTruthy();
    expect(getPromptEl(container).value).toBe('old draft');
    expect(getCriteriaEl(container).value).toBe('old criteria');

    const discard = container.querySelector('.draft-restored-banner .link-button') as HTMLButtonElement;
    expect(discard).toBeTruthy();
    await act(async () => {
      discard.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(getPromptEl(container).value).toBe('');
    expect(getCriteriaEl(container).value).toBe('');
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
    expect(container.querySelector('.draft-restored-banner')).toBeNull();

    act(() => root.unmount());
  });
});
