// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { AgentState, ClientMessage } from '../../shared/protocol.js';
import { detailReplyDraftKey } from '../store/detail-reply-draft.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import { DetailPanel } from './DetailPanel.js';

vi.mock('../telemetry.js', () => ({ track: vi.fn(), trackClick: vi.fn() }));
vi.mock('./ActivityPanel.js', () => ({ ActivityPanel: () => React.createElement('div', { 'data-testid': 'activity-panel' }) }));
vi.mock('./GitHubPanel.js', () => ({ GitHubPanel: () => React.createElement('div', { 'data-testid': 'github-panel' }) }));
vi.mock('./TerminalPanel.js', () => ({ TerminalPanel: () => React.createElement('div', { 'data-testid': 'terminal-panel' }) }));
vi.mock('./VoiceInputButton.js', () => ({
  VoiceInputButton: ({ onTranscript }: { onTranscript: (text: string) => void }) => React.createElement(
    'button',
    {
      'data-testid': 'voice-input',
      onClick: () => onTranscript('voice reply'),
    },
    'voice',
  ),
}));
vi.mock('./DiffPane.js', () => ({ DiffPane: () => React.createElement('div', { 'data-testid': 'diff-pane' }) }));
vi.mock('./SnoozeDialog.js', () => ({ SnoozeDialog: () => null }));
vi.mock('./EffectiveHookSettingsModal.js', () => ({ EffectiveHookSettingsModal: () => null }));
vi.mock('./TaskShareModal.js', () => ({ TaskShareModal: () => null }));

function syncGlobalStore() {
  const freshState = createKookrStore().getState();
  const nextData = Object.fromEntries(
    Object.entries(freshState).filter(([, value]) => typeof value !== 'function'),
  );
  useKookrStore.setState(nextData);
}

function makeAgent(agentId: string): AgentState {
  return {
    agentId,
    taskId: `task-${agentId}`,
    taskName: `Task ${agentId}`,
    events: [],
    anomaly: null,
    cwd: '/tmp/kookr',
    startedAt: '2026-06-05T10:00:00.000Z',
    taskStatus: 'inProgress',
  };
}

function renderDetailPanel(root: Root, agent: AgentState, send: (msg: ClientMessage) => boolean = () => true): void {
  act(() => {
    root.render(React.createElement(DetailPanel, {
      agent,
      send,
      onLaunch: vi.fn(),
      onRequestComplete: vi.fn(),
    }));
  });
}

function responseInput(container: HTMLElement): HTMLTextAreaElement {
  const input = container.querySelector<HTMLTextAreaElement>('.response-row textarea');
  expect(input).toBeInstanceOf(HTMLTextAreaElement);
  return input!;
}

function setInputValue(input: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('DetailPanel reply draft persistence', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    syncGlobalStore();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
    container.remove();
    document.body.innerHTML = '';
    localStorage.clear();
  });

  test('restores each task draft when switching away and back', () => {
    const first = makeAgent('agent-1');
    const second = makeAgent('agent-2');

    renderDetailPanel(root, first);
    act(() => setInputValue(responseInput(container), 'check logs before replying'));
    expect(localStorage.getItem(detailReplyDraftKey({ taskId: first.taskId, agentId: first.agentId })!)).toBe(
      JSON.stringify({ input: 'check logs before replying' }),
    );

    renderDetailPanel(root, second);
    expect(responseInput(container).value).toBe('');
    act(() => setInputValue(responseInput(container), 'second task reply'));

    renderDetailPanel(root, first);
    expect(responseInput(container).value).toBe('check logs before replying');

    renderDetailPanel(root, second);
    expect(responseInput(container).value).toBe('second task reply');
  });

  test('clears the scoped draft after a successful send', () => {
    const agent = makeAgent('agent-1');
    const sent: ClientMessage[] = [];
    renderDetailPanel(root, agent, (msg) => {
      sent.push(msg);
      return true;
    });

    act(() => setInputValue(responseInput(container), 'ship it'));
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="send-button"]')!.click();
    });

    expect(sent).toEqual([{ type: 'directReply', agentId: agent.agentId, input: 'ship it' }]);
    expect(responseInput(container).value).toBe('');
    expect(localStorage.getItem(detailReplyDraftKey({ taskId: agent.taskId, agentId: agent.agentId })!)).toBeNull();
  });

  test('preserves the draft when send fails', () => {
    const agent = makeAgent('agent-1');
    renderDetailPanel(root, agent, () => false);

    act(() => setInputValue(responseInput(container), 'retry after reconnect'));
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="send-button"]')!.click();
    });

    expect(responseInput(container).value).toBe('retry after reconnect');
    expect(localStorage.getItem(detailReplyDraftKey({ taskId: agent.taskId, agentId: agent.agentId })!)).toBe(
      JSON.stringify({ input: 'retry after reconnect' }),
    );
  });

  test('persists voice transcript drafts', async () => {
    const agent = makeAgent('agent-1');
    useKookrStore.setState({ sttUrl: 'http://127.0.0.1:8010' });
    renderDetailPanel(root, agent);
    await act(async () => {});

    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="voice-input"]')!.click();
    });

    expect(responseInput(container).value).toBe('voice reply');
    expect(localStorage.getItem(detailReplyDraftKey({ taskId: agent.taskId, agentId: agent.agentId })!)).toBe(
      JSON.stringify({ input: 'voice reply' }),
    );
  });

  function stubSettingsSnippets(replySnippets: Array<{ label: string; text: string }>) {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const path = typeof url === 'string' ? url : url instanceof URL ? url.pathname : url.url;
      if (path === '/api/settings') {
        return {
          ok: true,
          json: async () => ({ replySnippets }),
        } as Response;
      }
      if (path === '/api/share/task') {
        return { ok: true, json: async () => ({ shares: [] }) } as Response;
      }
      throw new Error(`unexpected fetch ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    });
    return fetchMock;
  }

  function snippetChips(): HTMLButtonElement[] {
    return Array.from(container.querySelectorAll<HTMLButtonElement>('.reply-snippet-picker .sample-prompt-chip'));
  }

  test('inserts a saved reply snippet without sending it', async () => {
    const fetchMock = stubSettingsSnippets([
      { label: 'Run tests', text: 'pnpm test -- settings-store settings-routes' },
    ]);
    const agent = makeAgent('agent-1');
    const sent: ClientMessage[] = [];

    renderDetailPanel(root, agent, (msg) => {
      sent.push(msg);
      return true;
    });
    await act(async () => {});

    const chips = snippetChips();
    expect(chips).toHaveLength(1);
    expect(chips[0].textContent).toBe('Run tests');
    expect(container.querySelector('#reply-snippet-picker')).toBeNull();

    act(() => {
      chips[0].click();
    });

    expect(responseInput(container).value).toBe('pnpm test -- settings-store settings-routes');
    expect(fetchMock).toHaveBeenCalledWith('/api/settings');
    expect(localStorage.getItem(detailReplyDraftKey({ taskId: agent.taskId, agentId: agent.agentId })!)).toBe(
      JSON.stringify({ input: 'pnpm test -- settings-store settings-routes' }),
    );
    expect(sent).toEqual([]);
  });

  test('shows eight chips and no overflow dropdown at the chip cap', async () => {
    const snippets = Array.from({ length: 8 }, (_, index) => ({
      label: `Snippet ${index + 1}`,
      text: `text-${index + 1}`,
    }));
    stubSettingsSnippets(snippets);
    renderDetailPanel(root, makeAgent('agent-1'));
    await act(async () => {});

    expect(snippetChips().map((chip) => chip.textContent)).toEqual(
      snippets.map((snippet) => snippet.label),
    );
    expect(container.querySelector('#reply-snippet-picker')).toBeNull();
  });

  test('caps snippet chips at eight and keeps the dropdown as overflow', async () => {
    const snippets = Array.from({ length: 10 }, (_, index) => ({
      label: `Snippet ${index + 1}`,
      text: `text-${index + 1}`,
    }));
    stubSettingsSnippets(snippets);
    const agent = makeAgent('agent-1');
    const sent: ClientMessage[] = [];

    renderDetailPanel(root, agent, (msg) => {
      sent.push(msg);
      return true;
    });
    await act(async () => {});

    const chips = snippetChips();
    expect(chips).toHaveLength(8);
    expect(chips.map((chip) => chip.textContent)).toEqual(
      snippets.slice(0, 8).map((snippet) => snippet.label),
    );

    const picker = container.querySelector<HTMLSelectElement>('#reply-snippet-picker');
    expect(picker).toBeInstanceOf(HTMLSelectElement);
    const overflowOptions = Array.from(picker!.options).slice(1);
    expect(overflowOptions.map((option) => option.textContent)).toEqual(['Snippet 9', 'Snippet 10']);
    expect(overflowOptions.map((option) => option.value)).toEqual(['8', '9']);

    const ninth = overflowOptions.find((option) => option.textContent === 'Snippet 9');
    expect(ninth).toBeDefined();
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(picker, ninth!.value);
      picker!.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(responseInput(container).value).toBe('text-9');
    expect(sent).toEqual([]);
  });
});
