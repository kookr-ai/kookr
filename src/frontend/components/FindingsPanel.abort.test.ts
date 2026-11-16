// @vitest-environment happy-dom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { FindingsPanel } from './FindingsPanel.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import type { AgentState, ClientMessage } from '../../shared/protocol.js';

function syncGlobalStore() {
  const freshState = createKookrStore().getState();
  const nextData = Object.fromEntries(
    Object.entries(freshState).filter(([, value]) => typeof value !== 'function'),
  );
  useKookrStore.setState(nextData);
}

function makeAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    agentId: overrides.agentId ?? 'agent-1',
    taskId: overrides.taskId ?? 'task-1',
    taskName: overrides.taskName ?? 'Some task',
    description: 'Working',
    events: [],
    anomaly: null,
    taskStatus: 'inProgress',
    cwd: '/tmp/project',
    ...overrides,
  } as AgentState;
}

function renderPanel(
  container: HTMLElement,
  abortActiveTaskIds: string[],
  findings: AgentState[],
  send: (msg: ClientMessage) => void,
  healthy: AgentState[] = [],
): Root {
  const root = createRoot(container);
  act(() => {
    root.render(React.createElement(FindingsPanel, {
      findings,
      healthy,
      pending: [],
      snoozed: [],
      completed: [],
      selectedAgentId: null,
      selectedTaskId: null,
      send,
      clearCompletedFinishedCount: 0,
      clearCompletedTerminatedCount: 0,
      abortActiveTaskIds,
    }));
  });
  return root;
}

function openMoreActions(): void {
  const trigger = document.querySelector<HTMLButtonElement>('[data-testid="rail-actions-trigger"]');
  expect(trigger).not.toBeNull();
  act(() => trigger!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
}

function queryButtonByText(text: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === text,
  ) as HTMLButtonElement | undefined;
}

describe('FindingsPanel — control-room batch abort (issue #1325)', () => {
  let container: HTMLDivElement;
  let root: Root | null;
  let send: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    syncGlobalStore();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({}),
      text: async () => '{}',
    })));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = null;
    send = vi.fn();
  });

  afterEach(() => {
    if (root) act(() => root!.unmount());
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  test('hides the actions menu when there is nothing active to abort', () => {
    root = renderPanel(container, [], [], send);
    expect(document.querySelector('[data-testid="rail-actions-trigger"]')).toBeNull();
    expect(queryButtonByText('Abort all active tasks…')).toBeUndefined();
  });

  test('Abort all is not on screen at rest; it sits in the More actions menu (#3561 slice 2)', () => {
    root = renderPanel(container, ['task-1'], [makeAgent({ taskId: 'task-1' })], send);

    // At rest: no destructive button, only the neutral menu trigger.
    expect(queryButtonByText('Abort all')).toBeUndefined();
    expect(queryButtonByText('Abort all active tasks…')).toBeUndefined();
    const trigger = document.querySelector<HTMLButtonElement>('[data-testid="rail-actions-trigger"]');
    expect(trigger?.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger?.getAttribute('aria-expanded')).toBe('false');

    openMoreActions();
    expect(trigger?.getAttribute('aria-expanded')).toBe('true');
    const item = queryButtonByText('Abort all active tasks…');
    expect(item?.getAttribute('role')).toBe('menuitem');

    // Escape closes the menu without sending anything.
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(queryButtonByText('Abort all active tasks…')).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });

  test('confirming Abort all sends one batchAbortTasks with the active task IDs', () => {
    const findings = [
      makeAgent({ agentId: 'a1', taskId: 'task-1' }),
      makeAgent({ agentId: 'a2', taskId: 'task-2' }),
    ];
    root = renderPanel(container, ['task-1', 'task-2'], findings, send);

    openMoreActions();
    const abortButton = queryButtonByText('Abort all active tasks…');
    expect(abortButton).toBeDefined();
    act(() => abortButton!.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    // A confirmation dialog is required for this destructive bulk action.
    expect(document.querySelector('.confirm-dialog')).not.toBeNull();
    expect(send).not.toHaveBeenCalled();

    const confirm = queryButtonByText('Abort');
    expect(confirm).toBeDefined();
    act(() => confirm!.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      type: 'batchAbortTasks',
      taskIds: ['task-1', 'task-2'],
    });
  });

  test('cancelling the confirmation sends nothing', () => {
    root = renderPanel(container, ['task-1'], [makeAgent({ taskId: 'task-1' })], send);

    openMoreActions();
    act(() => queryButtonByText('Abort all active tasks…')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    act(() => queryButtonByText('Cancel')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    expect(send).not.toHaveBeenCalled();
    expect(document.querySelector('.confirm-dialog')).toBeNull();
  });

  test('one menu holds Collapse all, Migrate interrupted… and Abort all; arrow keys move between them (#3617)', () => {
    useKookrStore.setState({
      availableAgentTypes: [
        { type: 'claude-code', label: 'Claude Code' },
        { type: 'codex-cli', label: 'Codex CLI' },
      ],
    } as never);
    root = renderPanel(container, ['task-1'], [], send, [makeAgent({ taskId: 'task-1' })]);

    // None of the three sits in the header at rest.
    for (const label of ['Collapse all', 'Migrate interrupted…', 'Abort all active tasks…']) {
      expect(queryButtonByText(label)).toBeUndefined();
    }

    openMoreActions();
    const items = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menu"] [role="menuitem"]'));
    // The destructive item comes last.
    expect(items.map((b) => b.textContent?.trim())).toEqual(['Collapse all', 'Migrate interrupted…', 'Abort all active tasks…']);
    expect(document.activeElement).toBe(items[0]);

    const press = (key: string) => act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })));
    press('ArrowDown');
    expect(document.activeElement).toBe(items[1]);
    press('ArrowDown');
    expect(document.activeElement).toBe(items[2]);
    press('ArrowDown');
    expect(document.activeElement).toBe(items[0]);
    press('ArrowUp');
    expect(document.activeElement).toBe(items[2]);
    expect(send).not.toHaveBeenCalled();
  });

  test('a pending Abort confirmation is dropped when nothing is active, and never comes back for new tasks (#3617)', () => {
    root = renderPanel(container, ['task-1'], [makeAgent({ taskId: 'task-1' })], send);
    openMoreActions();
    act(() => queryButtonByText('Abort all active tasks…')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(document.querySelector('.confirm-dialog')).not.toBeNull();

    // Every active task finished while the dialog was open.
    act(() => root!.render(React.createElement(FindingsPanel, {
      findings: [], healthy: [], pending: [], snoozed: [], completed: [],
      selectedAgentId: null, selectedTaskId: null, send,
      clearCompletedFinishedCount: 0, clearCompletedTerminatedCount: 0, abortActiveTaskIds: [],
    })));
    expect(document.querySelector('.confirm-dialog')).toBeNull();

    // A new task starts: the old confirmation must not reappear.
    act(() => root!.render(React.createElement(FindingsPanel, {
      findings: [makeAgent({ agentId: 'a2', taskId: 'task-2' })], healthy: [], pending: [], snoozed: [], completed: [],
      selectedAgentId: null, selectedTaskId: null, send,
      clearCompletedFinishedCount: 0, clearCompletedTerminatedCount: 0, abortActiveTaskIds: ['task-2'],
    })));
    expect(document.querySelector('.confirm-dialog')).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  test('choosing a menu item leaves focus on the More actions trigger, and Escape returns it there (#3617)', () => {
    root = renderPanel(container, ['task-1'], [], send, [makeAgent({ taskId: 'task-1' })]);
    const trigger = document.querySelector<HTMLButtonElement>('[data-testid="rail-actions-trigger"]');

    openMoreActions();
    act(() => queryButtonByText('Collapse all')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    openMoreActions();
    expect(document.activeElement).not.toBe(trigger);
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(document.activeElement).toBe(trigger);
  });
});
