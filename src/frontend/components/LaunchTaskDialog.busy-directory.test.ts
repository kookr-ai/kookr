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

function getCwdEl(container: HTMLElement): HTMLInputElement {
  const el = container.querySelector('input[placeholder="/home/user/my-project"]');
  if (!el) throw new Error('cwd input not rendered');
  return el as HTMLInputElement;
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
    cwd: '/tmp/demo',
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

describe('LaunchTaskDialog busy-directory warning', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    syncGlobalStore();
    useKookrStore.setState({
      serverCwd: '/tmp/demo',
      sttUrl: '',
      availableAgentTypes: [
        { type: 'claude-code', label: 'Claude Code' },
        { type: 'codex-cli', label: 'Codex CLI' },
      ],
      agents: [
        liveTask({
          agentId: 'sess-older',
          taskId: 'task-older',
          taskName: 'Auth fix',
          description: 'Fix the auth bug',
          startedAt: '2026-08-01T10:00:00.000Z',
        }),
        liveTask({
          agentId: 'sess-newer',
          taskId: 'task-newer',
          taskName: 'Review tests',
          description: 'Review the test suite',
          startedAt: '2026-08-01T11:00:00.000Z',
        }),
        liveTask({
          agentId: 'sess-other',
          taskId: 'task-other',
          cwd: '/tmp/other',
          taskName: 'Elsewhere',
          description: 'Work in another repo',
          startedAt: '2026-08-01T09:00:00.000Z',
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

  test('two in-progress tasks in /tmp/demo with different prompts show the busy-directory banner; /tmp/other does not', async () => {
    const { root } = renderDialog(container);
    await flush();
    await act(async () => { setInputValue(getPromptEl(container), 'A brand new prompt'); });
    await flush();

    const banner = container.querySelector('[data-testid="launch-busy-directory-banner"]');
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain('2');
    expect(banner?.textContent).toContain('Auth fix');
    expect(banner?.textContent).toContain('Review tests');
    expect(banner?.textContent).not.toContain('Elsewhere');

    await act(async () => { setInputValue(getCwdEl(container), '/tmp/other'); });
    await flush();

    const otherBanner = container.querySelector('[data-testid="launch-busy-directory-banner"]');
    expect(otherBanner).not.toBeNull();
    expect(otherBanner?.textContent).toContain('1');
    expect(otherBanner?.textContent).toContain('Elsewhere');
    expect(otherBanner?.textContent).not.toContain('Auth fix');

    await act(async () => { setInputValue(getCwdEl(container), '/tmp/empty'); });
    await flush();
    expect(container.querySelector('[data-testid="launch-busy-directory-banner"]')).toBeNull();

    act(() => root.unmount());
  });

  test('Launch anyway still sends the launch message', async () => {
    const { root, sent } = renderDialog(container);
    await flush();
    await act(async () => { setInputValue(getPromptEl(container), 'A brand new prompt'); });
    await flush();

    const anyway = container.querySelector('[data-testid="launch-busy-directory-launch-anyway"]') as HTMLButtonElement;
    expect(anyway).toBeTruthy();
    await act(async () => { anyway.click(); });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: 'launch',
      prompt: 'A brand new prompt',
      cwd: '/tmp/demo',
      agentType: 'claude-code',
    });
    expect(sent[0]).not.toHaveProperty('disableDedup');
    act(() => root.unmount());
  });

  test('the main Launch button stays enabled and still sends', async () => {
    const { root, sent } = renderDialog(container);
    await flush();
    await act(async () => { setInputValue(getPromptEl(container), 'A brand new prompt'); });
    await flush();

    const launch = getLaunchButton(container);
    expect(launch.disabled).toBe(false);
    await act(async () => { launch.click(); });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: 'launch',
      prompt: 'A brand new prompt',
      cwd: '/tmp/demo',
    });
    act(() => root.unmount());
  });

  test('Open existing selects the oldest live task and does not launch', async () => {
    const rendered = renderDialog(container);
    await flush();
    await act(async () => { setInputValue(getPromptEl(container), 'A brand new prompt'); });
    await flush();

    const open = container.querySelector('[data-testid="launch-busy-directory-open-existing"]') as HTMLButtonElement;
    await act(async () => { open.click(); });

    expect(rendered.sent).toHaveLength(0);
    expect(rendered.closed).toBe(1);
    expect(useKookrStore.getState().selectedTaskId).toBe('task-older');
    expect(useKookrStore.getState().selectedAgentId).toBe('sess-older');
    act(() => rendered.root.unmount());
  });

  test('the prompt-duplicate banner still appears when prompt and directory also match', async () => {
    const { root, sent } = renderDialog(container);
    await flush();
    await act(async () => { setInputValue(getPromptEl(container), 'Fix the auth bug'); });
    await flush();

    expect(container.querySelector('[data-testid="launch-duplicate-banner"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="launch-busy-directory-banner"]')).toBeNull();

    await act(async () => { getLaunchButton(container).click(); });
    expect(sent).toHaveLength(0);

    const anyway = container.querySelector('[data-testid="launch-duplicate-launch-anyway"]') as HTMLButtonElement;
    await act(async () => { anyway.click(); });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: 'launch',
      prompt: 'Fix the auth bug',
      disableDedup: true,
      metadataIntent: 'keep_as_duplicate',
    });
    act(() => root.unmount());
  });
});
