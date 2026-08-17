// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { LaunchTaskDialog } from './LaunchTaskDialog.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import {
  CLAUDE_CODE_EFFORT_LEVELS,
  CLAUDE_CODE_MODEL_IDS,
} from '../../shared/contracts/agent-types.js';
import { LAST_EFFORT_KEY, LAST_MODEL_KEY } from '../store/last-launch-pins.js';
import type { AgentSelection, ClientMessage } from '../../shared/protocol.js';

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

function setSelectValue(el: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('change', { bubbles: true }));
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

function getAgentSelectEl(container: HTMLElement): HTMLSelectElement {
  const el = container.querySelector('.agent-type-select select');
  if (!el) throw new Error('agent select not rendered');
  return el as HTMLSelectElement;
}

function getEffortSelect(container: HTMLElement): HTMLSelectElement | null {
  return container.querySelector('select[aria-label="Reasoning effort"]');
}

function getModelSelect(container: HTMLElement): HTMLSelectElement | null {
  return container.querySelector('select[aria-label="Model"]');
}

function renderDialog(
  container: HTMLElement,
  defaultAgentType: AgentSelection = 'claude-code',
  sendImpl: (msg: ClientMessage) => boolean = () => true,
): { root: Root; sent: ClientMessage[] } {
  const sent: ClientMessage[] = [];
  const root = createRoot(container);
  act(() => {
    root.render(
      React.createElement(LaunchTaskDialog, {
        send: (msg: ClientMessage) => { sent.push(msg); return sendImpl(msg); },
        onClose: () => {},
        defaultAgentType: defaultAgentType === 'round-robin' ? undefined : defaultAgentType,
      }),
    );
  });
  return { root, sent };
}

async function submitManualLaunch(container: HTMLElement): Promise<void> {
  await act(async () => { setInputValue(getPromptEl(container), 'pin fable at max'); });
  await act(async () => { setInputValue(getCwdEl(container), '/tmp/work'); });
  const form = container.querySelector('form');
  if (!form) throw new Error('form not rendered');
  await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  await flush();
}

describe('LaunchTaskDialog effort and model pickers (#2448)', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    syncGlobalStore();
    useKookrStore.setState({
      serverCwd: '/tmp/work',
      sttUrl: '',
      availableAgentTypes: [
        { type: 'claude-code', label: 'Claude Code' },
        { type: 'codex-cli', label: 'Codex CLI' },
        { type: 'grok-build', label: 'Grok Build' },
      ],
    });
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
  });

  test('selecting effort and model includes them in the launch payload', async () => {
    const { root, sent } = renderDialog(container, 'claude-code');
    await flush();

    const effort = getEffortSelect(container);
    const model = getModelSelect(container);
    expect(effort).not.toBeNull();
    expect(model).not.toBeNull();
    expect([...effort!.options].map((o) => o.value)).toEqual(['', ...CLAUDE_CODE_EFFORT_LEVELS]);
    expect([...model!.options].map((o) => o.value)).toEqual(['', ...CLAUDE_CODE_MODEL_IDS]);
    await act(async () => { setSelectValue(effort!, 'max'); });
    await act(async () => { setSelectValue(model!, 'claude-fable-5'); });
    await submitManualLaunch(container);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: 'launch',
      prompt: 'pin fable at max',
      agentType: 'claude-code',
      effort: 'max',
      model: 'claude-fable-5',
    });
    act(() => root.unmount());
  });

  test('empty pickers omit effort and model so the server default applies', async () => {
    const { root, sent } = renderDialog(container, 'claude-code');
    await flush();
    await submitManualLaunch(container);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'launch', agentType: 'claude-code' });
    expect(sent[0]).not.toHaveProperty('effort');
    expect(sent[0]).not.toHaveProperty('model');
    act(() => root.unmount());
  });

  test('grok-build hides the model picker', async () => {
    const { root } = renderDialog(container, 'grok-build');
    await flush();

    expect(getModelSelect(container)).toBeNull();
    expect(getEffortSelect(container)).toBeNull();
    act(() => root.unmount());
  });

  test('codex-cli shows effort and hides model', async () => {
    const { root } = renderDialog(container, 'codex-cli');
    await flush();

    expect(getEffortSelect(container)).not.toBeNull();
    expect(getModelSelect(container)).toBeNull();
    act(() => root.unmount());
  });

  test('switching to grok-build drops a previously chosen model pin from the payload', async () => {
    const { root, sent } = renderDialog(container, 'claude-code');
    await flush();

    await act(async () => { setSelectValue(getEffortSelect(container)!, 'max'); });
    await act(async () => { setSelectValue(getModelSelect(container)!, 'claude-fable-5'); });
    await act(async () => { setSelectValue(getAgentSelectEl(container), 'grok-build'); });
    await submitManualLaunch(container);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'launch', agentType: 'grok-build' });
    expect(sent[0]).not.toHaveProperty('effort');
    expect(sent[0]).not.toHaveProperty('model');
    act(() => root.unmount());
  });
});

describe('LaunchTaskDialog last-used effort and model (#2616)', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    syncGlobalStore();
    useKookrStore.setState({
      serverCwd: '/tmp/work',
      sttUrl: '',
      availableAgentTypes: [
        { type: 'claude-code', label: 'Claude Code' },
        { type: 'codex-cli', label: 'Codex CLI' },
        { type: 'grok-build', label: 'Grok Build' },
      ],
    });
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
  });

  test('reopening after a pinned launch restores the same effort and model in the dropdowns', async () => {
    const first = renderDialog(container, 'claude-code');
    await flush();
    await act(async () => { setSelectValue(getEffortSelect(container)!, 'max'); });
    await act(async () => { setSelectValue(getModelSelect(container)!, 'claude-fable-5'); });
    await submitManualLaunch(container);
    expect(localStorage.getItem(LAST_EFFORT_KEY)).toBe('max');
    expect(localStorage.getItem(LAST_MODEL_KEY)).toBe('claude-fable-5');
    act(() => first.root.unmount());

    const second = renderDialog(container, 'claude-code');
    await flush();
    expect(getEffortSelect(container)?.value).toBe('max');
    expect(getModelSelect(container)?.value).toBe('claude-fable-5');
    act(() => second.root.unmount());
  });

  test('switching to an agent that rejects a stored pin falls back to Agent default for that pin', async () => {
    localStorage.setItem(LAST_EFFORT_KEY, 'high');
    localStorage.setItem(LAST_MODEL_KEY, 'claude-fable-5');

    const { root } = renderDialog(container, 'claude-code');
    await flush();
    expect(getEffortSelect(container)?.value).toBe('high');
    expect(getModelSelect(container)?.value).toBe('claude-fable-5');

    await act(async () => { setSelectValue(getAgentSelectEl(container), 'codex-cli'); });
    await flush();
    expect(getEffortSelect(container)?.value).toBe('high');
    expect(getModelSelect(container)).toBeNull();
    act(() => root.unmount());
  });

  test('a stored Codex-only effort falls back to Agent default while a valid model stays', async () => {
    localStorage.setItem(LAST_EFFORT_KEY, 'ultra');
    localStorage.setItem(LAST_MODEL_KEY, 'claude-fable-5');

    const { root } = renderDialog(container, 'claude-code');
    await flush();
    expect(getEffortSelect(container)?.value).toBe('');
    expect(getModelSelect(container)?.value).toBe('claude-fable-5');
    act(() => root.unmount());
  });

  test('failed send does not write the new pins', async () => {
    localStorage.setItem(LAST_EFFORT_KEY, 'high');
    localStorage.setItem(LAST_MODEL_KEY, 'claude-fable-5');

    const { root, sent } = renderDialog(container, 'claude-code', () => false);
    await flush();
    await act(async () => { setSelectValue(getEffortSelect(container)!, 'max'); });
    await act(async () => { setSelectValue(getModelSelect(container)!, 'claude-sonnet-5'); });
    await submitManualLaunch(container);

    expect(sent).toHaveLength(1);
    expect(localStorage.getItem(LAST_EFFORT_KEY)).toBe('high');
    expect(localStorage.getItem(LAST_MODEL_KEY)).toBe('claude-fable-5');
    act(() => root.unmount());
  });

  test('a default launch clears stored pins so the next open stays on Agent default', async () => {
    localStorage.setItem(LAST_EFFORT_KEY, 'high');
    localStorage.setItem(LAST_MODEL_KEY, 'claude-fable-5');

    const first = renderDialog(container, 'claude-code');
    await flush();
    await act(async () => { setSelectValue(getEffortSelect(container)!, ''); });
    await act(async () => { setSelectValue(getModelSelect(container)!, ''); });
    await submitManualLaunch(container);
    expect(localStorage.getItem(LAST_EFFORT_KEY)).toBeNull();
    expect(localStorage.getItem(LAST_MODEL_KEY)).toBeNull();
    act(() => first.root.unmount());

    const second = renderDialog(container, 'claude-code');
    await flush();
    expect(getEffortSelect(container)?.value).toBe('');
    expect(getModelSelect(container)?.value).toBe('');
    act(() => second.root.unmount());
  });
});
