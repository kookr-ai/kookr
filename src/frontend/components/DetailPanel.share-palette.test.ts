// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { AgentState } from '../../shared/protocol.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import { DetailPanel } from './DetailPanel.js';

vi.mock('../telemetry.js', () => ({ track: vi.fn(), trackClick: vi.fn() }));
vi.mock('./ActivityPanel.js', () => ({ ActivityPanel: () => React.createElement('div', { 'data-testid': 'activity-panel' }) }));
vi.mock('./GitHubPanel.js', () => ({ GitHubPanel: () => React.createElement('div', { 'data-testid': 'github-panel' }) }));
vi.mock('./TerminalPanel.js', () => ({ TerminalPanel: () => React.createElement('div', { 'data-testid': 'terminal-panel' }) }));
vi.mock('./DiffPane.js', () => ({ DiffPane: () => React.createElement('div', { 'data-testid': 'diff-pane' }) }));
vi.mock('./SnoozeDialog.js', () => ({ SnoozeDialog: () => null }));
vi.mock('./EffectiveHookSettingsModal.js', () => ({ EffectiveHookSettingsModal: () => null }));

function syncGlobalStore() {
  const freshState = createKookrStore().getState();
  const nextData = Object.fromEntries(
    Object.entries(freshState).filter(([, value]) => typeof value !== 'function'),
  );
  useKookrStore.setState(nextData);
}

function makeAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    agentId: 'agent-1',
    taskId: 'task-1',
    taskName: 'Shared task',
    events: [],
    anomaly: null,
    agentType: 'codex-cli',
    cwd: '/tmp/kookr',
    startedAt: '2026-05-17T12:00:00.000Z',
    taskStatus: 'inProgress',
    ...overrides,
  };
}

function renderPanel(root: Root, agent: AgentState, shareRequestNonce: number) {
  act(() => {
    root.render(
      React.createElement(DetailPanel, {
        agent,
        send: vi.fn(() => true),
        onLaunch: vi.fn(),
        onRequestComplete: vi.fn(),
        shareRequestNonce,
      }),
    );
  });
}

async function flush() {
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
}

function shareDialog(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>('.task-share-dialog[role="dialog"]');
}

describe('DetailPanel command-palette share request (#2754)', () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    syncGlobalStore();
    // The per-task share modal fetches its share list on open; return empty.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ shares: [] }), {
      headers: { 'content-type': 'application/json' },
    })));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  test('mounting keeps the share modal closed until a bump', async () => {
    // App always mounts DetailPanel with the current (initially 0) nonce; the
    // mount itself must never open the modal.
    renderPanel(root!, makeAgent(), 0);
    await flush();
    expect(shareDialog(container)).toBeNull();
  });

  test('bumping the nonce opens the per-task share modal', async () => {
    renderPanel(root!, makeAgent(), 0);
    await flush();
    expect(shareDialog(container)).toBeNull();

    renderPanel(root!, makeAgent(), 1);
    await flush();
    const dialog = shareDialog(container);
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain('Share this task');
  });

  test('switching tasks with an unchanged nonce does not reopen a closed modal', async () => {
    renderPanel(root!, makeAgent(), 0);
    await flush();
    renderPanel(root!, makeAgent(), 1);
    await flush();
    expect(shareDialog(container)).not.toBeNull();

    // Close via the dialog's close button.
    const close = container.querySelector<HTMLButtonElement>('.dialog-close');
    act(() => { close?.click(); });
    await flush();
    expect(shareDialog(container)).toBeNull();

    // Select a different task; the nonce is unchanged, so the modal stays shut.
    renderPanel(root!, makeAgent({ agentId: 'agent-2', taskId: 'task-2', taskName: 'Other task' }), 1);
    await flush();
    expect(shareDialog(container)).toBeNull();
  });

  test('a later bump reopens the modal for the same task', async () => {
    renderPanel(root!, makeAgent(), 0);
    await flush();
    renderPanel(root!, makeAgent(), 1);
    await flush();
    const close = container.querySelector<HTMLButtonElement>('.dialog-close');
    act(() => { close?.click(); });
    await flush();
    expect(shareDialog(container)).toBeNull();

    renderPanel(root!, makeAgent(), 2);
    await flush();
    expect(shareDialog(container)).not.toBeNull();
  });

  test('a remount with an already-elevated nonce does not auto-open the modal', async () => {
    // Regression guard: App's nonce only ever increments and is never reset,
    // while DetailPanel remounts across layout/tab boundaries. A fresh mount
    // that inherits an elevated nonce must NOT spring the modal open on its own.
    renderPanel(root!, makeAgent(), 0);
    await flush();
    renderPanel(root!, makeAgent(), 1);
    await flush();
    expect(shareDialog(container)).not.toBeNull();
    const close = container.querySelector<HTMLButtonElement>('.dialog-close');
    act(() => { close?.click(); });
    await flush();
    expect(shareDialog(container)).toBeNull();

    // Simulate the remount: a brand-new component instance in the same
    // container, inheriting the still-elevated nonce (1).
    act(() => root?.unmount());
    root = createRoot(container);
    renderPanel(root, makeAgent(), 1);
    await flush();
    expect(shareDialog(container)).toBeNull();

    // A genuine later bump on the remounted panel still opens it.
    renderPanel(root, makeAgent(), 2);
    await flush();
    expect(shareDialog(container)).not.toBeNull();
  });

  test('a bump with no selected task never opens the modal', async () => {
    // Defensive backstop: the effect opens only when agent?.taskId is set.
    const taskless = makeAgent({ taskId: undefined });
    renderPanel(root!, taskless, 0);
    await flush();
    renderPanel(root!, taskless, 1);
    await flush();
    expect(shareDialog(container)).toBeNull();
  });
});
