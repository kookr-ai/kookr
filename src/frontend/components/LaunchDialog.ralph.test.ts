// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { LaunchTaskDialog as LaunchDialog } from './LaunchTaskDialog.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import { LAUNCH_TASK_DIALOG_DRAFT_KEY as LAUNCH_DIALOG_DRAFT_KEY } from '../store/launch-task-dialog-draft.js';
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

function getCwdEl(container: HTMLElement): HTMLInputElement {
  const el = container.querySelector('.combo-input input[type="text"]');
  if (!el) throw new Error('cwd input not rendered');
  return el as HTMLInputElement;
}

function getRalphCapEl(container: HTMLElement): HTMLInputElement {
  const el = container.querySelector('input[name="ralph-iteration-cap"]');
  if (!el) throw new Error('Ralph iteration cap input not rendered');
  return el as HTMLInputElement;
}

function getSubmit(container: HTMLElement): HTMLButtonElement {
  const el = container.querySelector('.dialog-actions .btn-primary');
  if (!el) throw new Error('submit button not rendered');
  return el as HTMLButtonElement;
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
      React.createElement(LaunchDialog, {
        send: (msg: ClientMessage) => {
          sent.push(msg);
          return true;
        },
        onClose: () => { closeCalls.count += 1; },
      }),
    );
  });
  return { root, sent, closeCalls };
}

describe('LaunchDialog Ralph task mode', () => {
  let container: HTMLDivElement;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    syncGlobalStore();
    useKookrStore.setState({ serverCwd: '/tmp/work', sttUrl: '', alerts: [] });
    container = document.createElement('div');
    document.body.appendChild(container);
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  test('submits a Ralph task through the transactional HTTP endpoint', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ id: 'task-1', ralphLoop: { status: 'running' } }),
    });
    const { root, sent, closeCalls } = renderDialog(container);
    await flush();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-pressed="false"]')!.click();
    });
    await act(async () => { setInputValue(getPromptEl(container), 'Keep iterating until done'); });
    await act(async () => { setInputValue(getCwdEl(container), '/tmp/work'); });
    await act(async () => { setInputValue(getRalphCapEl(container), '9'); });
    await act(async () => {
      setInputValue(container.querySelector<HTMLInputElement>('input[name="ralph-zero-diff-threshold"]')!, '3');
    });
    await act(async () => {
      setInputValue(container.querySelector<HTMLInputElement>('input[name="ralph-cost-cap"]')!, '2.5');
    });
    await act(async () => {
      container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush();

    expect(sent).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledWith('/api/tasks/ralph-loop', expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Kookr-Launch-Source': 'ui' },
    }));
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({
      prompt: 'Keep iterating until done',
      cwd: '/tmp/work',
      iterationCap: 9,
      zeroDiffConvergence: { consecutiveIterations: 3 },
      costCapUsd: 2.5,
    });
    expect(closeCalls.count).toBe(1);
    expect(localStorage.getItem(LAUNCH_DIALOG_DRAFT_KEY)).toBeNull();

    act(() => root.unmount());
  });

  test('keeps the dialog open and preserves draft when Ralph launch fails', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({ error: 'standalone ralph-wiggum plugin detected' }),
    });
    const { root, closeCalls } = renderDialog(container);
    await flush();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-pressed="false"]')!.click();
    });
    await act(async () => { setInputValue(getPromptEl(container), 'Retry this Ralph task'); });
    await act(async () => { setInputValue(getCwdEl(container), '/tmp/work'); });
    await act(async () => {
      container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush();

    expect(closeCalls.count).toBe(0);
    expect(getPromptEl(container).value).toBe('Retry this Ralph task');
    expect(localStorage.getItem(LAUNCH_DIALOG_DRAFT_KEY)).not.toBeNull();
    expect(useKookrStore.getState().alerts.at(-1)?.summary).toContain('standalone ralph-wiggum');
    expect(useKookrStore.getState().alerts.at(-1)?.severity).toBe('error');

    act(() => root.unmount());
  });

  test('disables Ralph launch when iteration cap is invalid', async () => {
    const { root } = renderDialog(container);
    await flush();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-pressed="false"]')!.click();
    });
    await act(async () => { setInputValue(getPromptEl(container), 'Need a valid cap'); });
    await act(async () => { setInputValue(getCwdEl(container), '/tmp/work'); });
    await act(async () => { setInputValue(getRalphCapEl(container), '0'); });
    await flush();

    expect(getSubmit(container).disabled).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();

    act(() => root.unmount());
  });
});
