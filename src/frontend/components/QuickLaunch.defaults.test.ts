// @vitest-environment jsdom

import React from 'react';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QuickLaunch } from './QuickLaunch.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import { LAST_AGENT_TYPE_KEY } from '../store/last-agent-type.js';
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

function getAgentSelectEl(container: HTMLElement): HTMLSelectElement {
  const el = container.querySelector('.agent-type-select select');
  if (!el) throw new Error('agent select not rendered');
  return el as HTMLSelectElement;
}

function renderQuickLaunch(
  container: HTMLElement,
  send: (msg: ClientMessage) => boolean = () => true,
): Root {
  const root = createRoot(container);
  act(() => {
    root.render(React.createElement(QuickLaunch, { send, onClose: () => {} }));
  });
  return root;
}

describe('QuickLaunch agent default chain (RFC F6)', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    syncGlobalStore();
    // Server default deliberately differs from claude-code so last-used wins
    // are observable (mirrors LaunchTaskDialog.defaults.test.ts).
    useKookrStore.setState({
      serverCwd: '/tmp/work',
      sttUrl: '',
      defaultAgentType: 'codex-cli',
      selectedAgentId: null,
      agents: [],
    });
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
  });

  test('last-used agent beats the server default when no agent is selected', async () => {
    localStorage.setItem(LAST_AGENT_TYPE_KEY, 'claude-code');

    const root = renderQuickLaunch(container);
    await flush();

    expect(getAgentSelectEl(container).value).toBe('claude-code');
    act(() => root.unmount());
  });

  test('falls back to the server default when nothing was persisted', async () => {
    const root = renderQuickLaunch(container);
    await flush();

    expect(getAgentSelectEl(container).value).toBe('codex-cli');
    act(() => root.unmount());
  });

  test('selected agent type beats last-used and server default', async () => {
    // last-used and server default both prefer claude-code; only the selected
    // agent path yields codex-cli — uniquely proves selected wins.
    localStorage.setItem(LAST_AGENT_TYPE_KEY, 'claude-code');
    useKookrStore.setState({
      defaultAgentType: 'claude-code',
      selectedAgentId: 'sess-1',
      agents: [{
        agentId: 'sess-1',
        events: [],
        anomaly: null,
        agentType: 'codex-cli',
        description: 'selected',
      }],
    });

    const root = renderQuickLaunch(container);
    await flush();

    expect(getAgentSelectEl(container).value).toBe('codex-cli');
    act(() => root.unmount());
  });

  test('an unknown persisted value is ignored', async () => {
    localStorage.setItem(LAST_AGENT_TYPE_KEY, 'gpt-cli');

    const root = renderQuickLaunch(container);
    await flush();

    expect(getAgentSelectEl(container).value).toBe('codex-cli');
    act(() => root.unmount());
  });

  test('successful submit persists the selected agent as last-used', async () => {
    const sent: ClientMessage[] = [];
    const root = renderQuickLaunch(container, (msg) => { sent.push(msg); return true; });
    await flush();

    // Server default is codex-cli; switch to claude-code and launch.
    const select = getAgentSelectEl(container);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
      setter.call(select, 'claude-code');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const input = container.querySelector('input.quick-launch-input') as HTMLInputElement;
    await act(async () => { setInputValue(input, 'do the thing'); });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'launch', agentType: 'claude-code' });
    expect(localStorage.getItem(LAST_AGENT_TYPE_KEY)).toBe('claude-code');
    act(() => root.unmount());
  });

  test('failed submit (send returns false) does not persist last-used', async () => {
    localStorage.setItem(LAST_AGENT_TYPE_KEY, 'claude-code');
    const sent: ClientMessage[] = [];
    const root = renderQuickLaunch(container, (msg) => { sent.push(msg); return false; });
    await flush();

    const select = getAgentSelectEl(container);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
      setter.call(select, 'codex-cli');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const input = container.querySelector('input.quick-launch-input') as HTMLInputElement;
    await act(async () => { setInputValue(input, 'do the thing'); });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    // Send ran but failed — must not overwrite the last-used preference.
    expect(sent).toHaveLength(1);
    expect(localStorage.getItem(LAST_AGENT_TYPE_KEY)).toBe('claude-code');
    act(() => root.unmount());
  });
});
