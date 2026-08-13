// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { LaunchTaskDialog } from './LaunchTaskDialog.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import type { AgentState, ClientMessage } from '../../shared/protocol.js';

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

function getLaunchButton(container: HTMLElement): HTMLButtonElement {
  const el = Array.from(container.querySelectorAll('button')).find((button) =>
    button.textContent === 'Launch' || button.textContent === 'Launching...',
  );
  if (!el) throw new Error('Launch button not rendered');
  return el as HTMLButtonElement;
}

function liveTask(overrides: Partial<AgentState> & Pick<AgentState, 'agentId' | 'taskId' | 'description'>): AgentState {
  return {
    events: [],
    anomaly: null,
    cwd: '/tmp/work',
    agentType: 'claude-code',
    taskStatus: 'inProgress',
    ...overrides,
  };
}

function renderDialog(container: HTMLElement): { root: Root; sent: ClientMessage[]; closed: number } {
  const sent: ClientMessage[] = [];
  let closed = 0;
  const root = createRoot(container);
  act(() => {
    root.render(
      React.createElement(LaunchTaskDialog, {
        send: (msg: ClientMessage) => { sent.push(msg); return true; },
        onClose: () => { closed += 1; },
        defaultAgentType: 'claude-code',
      }),
    );
  });
  return { root, sent, get closed() { return closed; } };
}

describe('LaunchTaskDialog active-duplicate warning', () => {
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
      ],
      agents: [
        liveTask({
          agentId: 'sess-live',
          taskId: 'task-live',
          taskName: 'Auth fix',
          description: 'Fix the auth bug',
        }),
        liveTask({
          agentId: 'sess-other',
          taskId: 'task-other',
          description: 'Unrelated prompt',
        }),
      ],
    });
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
  });

  test('matching prompt shows the banner; Launch anyway still sends an intentional duplicate', async () => {
    const { root, sent } = renderDialog(container);
    await flush();
    await act(async () => { setInputValue(getPromptEl(container), 'Fix the auth bug'); });
    await flush();

    const banner = container.querySelector('[data-testid="launch-duplicate-banner"]');
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain('intentional duplicate');

    await act(async () => { getLaunchButton(container).click(); });
    expect(sent).toHaveLength(0);

    const anyway = container.querySelector('[data-testid="launch-duplicate-launch-anyway"]') as HTMLButtonElement;
    expect(anyway).toBeTruthy();
    await act(async () => { anyway.click(); });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: 'launch',
      prompt: 'Fix the auth bug',
      cwd: '/tmp/work',
      agentType: 'claude-code',
      disableDedup: true,
      metadataIntent: 'keep_as_duplicate',
    });
    act(() => root.unmount());
  });

  test('a non-matching prompt does not show the banner and Launch sends without disableDedup', async () => {
    const { root, sent } = renderDialog(container);
    await flush();
    await act(async () => { setInputValue(getPromptEl(container), 'A brand new prompt'); });
    await flush();

    expect(container.querySelector('[data-testid="launch-duplicate-banner"]')).toBeNull();
    await act(async () => { getLaunchButton(container).click(); });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: 'launch',
      prompt: 'A brand new prompt',
      cwd: '/tmp/work',
      agentType: 'claude-code',
    });
    expect(sent[0]).not.toHaveProperty('disableDedup');
    act(() => root.unmount());
  });

  test('Open existing selects the live task and closes without sending', async () => {
    const rendered = renderDialog(container);
    await flush();
    await act(async () => { setInputValue(getPromptEl(container), 'Fix the auth bug'); });
    await flush();

    const open = container.querySelector('[data-testid="launch-duplicate-open-existing"]') as HTMLButtonElement;
    await act(async () => { open.click(); });

    expect(rendered.sent).toHaveLength(0);
    expect(rendered.closed).toBe(1);
    expect(useKookrStore.getState().selectedTaskId).toBe('task-live');
    expect(useKookrStore.getState().selectedAgentId).toBe('sess-live');
    act(() => rendered.root.unmount());
  });
});
