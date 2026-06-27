// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { LaunchTaskDialog } from './LaunchTaskDialog.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import { LAUNCH_TASK_DIALOG_DRAFT_KEY } from '../store/launch-task-dialog-draft.js';
import type { ClientMessage } from '../../shared/protocol.js';

const DRAFT_KEY = LAUNCH_TASK_DIALOG_DRAFT_KEY;

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

function getCriteriaEl(container: HTMLElement): HTMLInputElement {
  // Criteria is the second text input in the form — the first is the cwd
  // input inside .combo-input. Position-based lookup avoids coupling to UX
  // copy like the "Tests pass" placeholder.
  const inputs = Array.from(container.querySelectorAll('input[type="text"]')) as HTMLInputElement[];
  if (inputs.length < 2) throw new Error('criteria input not rendered');
  return inputs[1];
}

interface RenderOpts {
  defaultCwd?: string;
  defaultPrompt?: string;
  defaultCriteria?: string;
  sendReturns?: boolean;
  onClose?: () => void;
}

function renderDialog(container: HTMLElement, opts: RenderOpts = {}): { root: Root; sent: ClientMessage[] } {
  const sent: ClientMessage[] = [];
  const root = createRoot(container);
  act(() => {
    root.render(
      React.createElement(LaunchTaskDialog, {
        send: (msg: ClientMessage) => {
          sent.push(msg);
          return opts.sendReturns ?? true;
        },
        onClose: opts.onClose ?? (() => {}),
        defaultCwd: opts.defaultCwd,
        defaultPrompt: opts.defaultPrompt,
        defaultCriteria: opts.defaultCriteria,
      }),
    );
  });
  return { root, sent };
}

describe('LaunchTaskDialog draft persistence', () => {
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

  test('typing into prompt, unmounting, and remounting restores the draft', async () => {
    const { root } = renderDialog(container);
    await flush();

    const prompt = getPromptEl(container);
    await act(async () => { setInputValue(prompt, 'Draft in progress'); });
    await flush();

    // Close (unmount).
    act(() => root.unmount());

    // Between unmount and remount, storage should already reflect the save —
    // this isolates the save-effect from the load-on-mount path.
    const midStored = JSON.parse(localStorage.getItem(DRAFT_KEY)!);
    expect(midStored.prompt).toBe('Draft in progress');

    // Reopen on a new container.
    container.remove();
    container = document.createElement('div');
    document.body.appendChild(container);

    const { root: root2 } = renderDialog(container);
    await flush();

    expect(getPromptEl(container).value).toBe('Draft in progress');

    act(() => root2.unmount());
  });

  test('submit keeps the draft, marked as submitted (optimistic close must not lose it — RFC F12)', async () => {
    const { root, sent } = renderDialog(container, { sendReturns: true });
    await flush();

    await act(async () => { setInputValue(getPromptEl(container), 'do the thing'); });
    await act(async () => { setInputValue(getCwdEl(container), '/tmp/work'); });
    await flush();

    const form = container.querySelector('form')!;
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    await flush();

    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe('launch');
    const { alerts } = useKookrStore.getState();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe('info');
    expect(alerts[0].summary).toBe('Launching task: do the thing');
    // The dialog closes before the server confirms the launch, so the draft
    // survives submit — only stamped with a submittedAt marker.
    const stored = JSON.parse(localStorage.getItem(DRAFT_KEY)!);
    expect(stored.prompt).toBe('do the thing');
    expect(typeof stored.submittedAt).toBe('number');

    act(() => root.unmount());
  });

  test('confirmed launch (matching task in store) clears the draft so next open starts empty', async () => {
    const { root } = renderDialog(container, { sendReturns: true });
    await flush();

    await act(async () => { setInputValue(getPromptEl(container), 'do the thing'); });
    await act(async () => { setInputValue(getCwdEl(container), '/tmp/work'); });
    await flush();

    const form = container.querySelector('form')!;
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    await flush();

    act(() => root.unmount());

    // The launch went through: a snapshot delivered a task matching the
    // submitted prompt before the dialog reopened.
    useKookrStore.setState({
      agents: [{ agentId: 'kookr-1', events: [], anomaly: null, description: 'do the thing' }],
    });

    // Reopen — should be empty, draft consumed.
    container.remove();
    container = document.createElement('div');
    document.body.appendChild(container);
    const { root: root2 } = renderDialog(container);
    await flush();

    expect(getPromptEl(container).value).toBe('');
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull();

    act(() => root2.unmount());
  });

  test('failed server-side launch (no matching task) restores the draft on reopen', async () => {
    const { root } = renderDialog(container, { sendReturns: true });
    await flush();

    await act(async () => { setInputValue(getPromptEl(container), 'launch into missing dir'); });
    await act(async () => { setInputValue(getCwdEl(container), '/does/not/exist'); });
    await flush();

    const form = container.querySelector('form')!;
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    await flush();

    act(() => root.unmount());

    // No matching task ever appeared (the server rejected the launch, e.g.
    // nonexistent working directory). Reopen must restore the typed prompt.
    container.remove();
    container = document.createElement('div');
    document.body.appendChild(container);
    const { root: root2 } = renderDialog(container);
    await flush();

    expect(getPromptEl(container).value).toBe('launch into missing dir');
    expect(container.querySelector('.draft-restored-banner')).not.toBeNull();

    act(() => root2.unmount());
  });

  test('post-submit state mutations do not overwrite the submitted draft (submittedRef guard)', async () => {
    // Regression test for the race the RFC's H1 section calls out: after a
    // successful launch, the save effect is still wired; any subsequent render
    // that re-runs it must see submittedRef=true and early-return. We simulate
    // that "post-submit render" by typing into the prompt field after submit —
    // if the ref guard regresses, this mutation would overwrite the marked
    // draft (dropping the submittedAt marker and the launched prompt).
    const { root } = renderDialog(container, { sendReturns: true });
    await flush();

    await act(async () => { setInputValue(getPromptEl(container), 'ship it'); });
    await act(async () => { setInputValue(getCwdEl(container), '/tmp/work'); });
    await flush();

    const form = container.querySelector('form')!;
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    await flush();

    const afterSubmit = JSON.parse(localStorage.getItem(DRAFT_KEY)!);
    expect(afterSubmit.prompt).toBe('ship it');
    expect(typeof afterSubmit.submittedAt).toBe('number');

    // Mutate the field *after* submit while the component is still mounted.
    await act(async () => { setInputValue(getPromptEl(container), 'zombie draft'); });
    await flush();

    // The save effect must have early-returned due to submittedRef — the
    // marked draft must be byte-identical despite the state change.
    expect(JSON.parse(localStorage.getItem(DRAFT_KEY)!)).toEqual(afterSubmit);

    act(() => root.unmount());
  });

  test('failed launch (send returns false) retains the draft', async () => {
    const { root } = renderDialog(container, { sendReturns: false });
    await flush();

    await act(async () => { setInputValue(getPromptEl(container), 'retry me'); });
    await act(async () => { setInputValue(getCwdEl(container), '/tmp/work'); });
    await flush();

    const form = container.querySelector('form')!;
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    await flush();

    expect(localStorage.getItem(DRAFT_KEY)).not.toBeNull();
    const stored = JSON.parse(localStorage.getItem(DRAFT_KEY)!);
    expect(stored.prompt).toBe('retry me');

    act(() => root.unmount());
  });

  test('relaunch with defaultPrompt does not overwrite an existing draft', async () => {
    localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({ prompt: 'my draft', cwd: '/my/repo', criteria: 'my criteria' }),
    );

    // Open a relaunch dialog.
    const { root } = renderDialog(container, {
      defaultPrompt: 'relaunched',
      defaultCwd: '/other',
    });
    await flush();

    // Form shows relaunched values, not the draft.
    expect(getPromptEl(container).value).toBe('relaunched');
    expect(getCwdEl(container).value).toBe('/other');

    // Edit the relaunch fields.
    await act(async () => { setInputValue(getPromptEl(container), 'edited during relaunch'); });
    await flush();

    // Stored draft is untouched.
    const stored = JSON.parse(localStorage.getItem(DRAFT_KEY)!);
    expect(stored).toEqual({ prompt: 'my draft', cwd: '/my/repo', criteria: 'my criteria' });

    act(() => root.unmount());
  });

  test('opening and closing without typing does not create a zombie draft even though cwd is auto-populated', async () => {
    const { root } = renderDialog(container);
    await flush();

    // cwd auto-populates from serverCwd. User types nothing.
    expect(getCwdEl(container).value).toBe('/tmp/work');
    expect(getPromptEl(container).value).toBe('');

    // Close.
    act(() => root.unmount());

    expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
  });

  test('persisted empty-string cwd falls through to serverCwd on reopen (not a blank field)', async () => {
    // Seed a draft where the user had cleared cwd.
    localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({ prompt: 'some task', cwd: '', criteria: '' }),
    );

    const { root } = renderDialog(container);
    await flush();

    expect(getPromptEl(container).value).toBe('some task');
    // Empty-string cwd must fall through to recentPaths/serverCwd.
    expect(getCwdEl(container).value).toBe('/tmp/work');

    act(() => root.unmount());
  });

  test('criteria field is also persisted and restored', async () => {
    const { root } = renderDialog(container);
    await flush();

    await act(async () => { setInputValue(getPromptEl(container), 'task'); });
    await act(async () => { setInputValue(getCriteriaEl(container), 'all tests pass'); });
    await flush();

    act(() => root.unmount());

    container.remove();
    container = document.createElement('div');
    document.body.appendChild(container);

    const { root: root2 } = renderDialog(container);
    await flush();

    expect(getCriteriaEl(container).value).toBe('all tests pass');

    act(() => root2.unmount());
  });
});
