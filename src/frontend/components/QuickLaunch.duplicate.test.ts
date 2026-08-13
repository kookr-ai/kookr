// @vitest-environment jsdom

import React from 'react';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QuickLaunch } from './QuickLaunch.js';
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

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
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

function renderQuickLaunch(
  container: HTMLElement,
): { root: Root; sent: ClientMessage[] } {
  const sent: ClientMessage[] = [];
  const root = createRoot(container);
  act(() => {
    root.render(React.createElement(QuickLaunch, {
      send: (msg: ClientMessage) => { sent.push(msg); return true; },
      onClose: () => {},
    }));
  });
  return { root, sent };
}

describe('QuickLaunch active-duplicate warning', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    syncGlobalStore();
    useKookrStore.setState({
      serverCwd: '/tmp/work',
      sttUrl: '',
      selectedAgentId: null,
      defaultAgentType: 'claude-code',
      availableAgentTypes: [
        { type: 'claude-code', label: 'Claude Code' },
        { type: 'codex-cli', label: 'Codex CLI' },
      ],
      agents: [
        liveTask({
          agentId: 'sess-live',
          taskId: 'task-live',
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

  test('matching prompt shows the banner; Launch anyway still sends', async () => {
    const { root, sent } = renderQuickLaunch(container);
    await flush();

    const input = container.querySelector('input.quick-launch-input') as HTMLInputElement;
    await act(async () => { setInputValue(input, 'Fix the auth bug'); });
    await flush();

    expect(container.querySelector('[data-testid="launch-duplicate-banner"]')).not.toBeNull();

    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(sent).toHaveLength(0);

    const anyway = container.querySelector('[data-testid="launch-duplicate-launch-anyway"]') as HTMLButtonElement;
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
});
