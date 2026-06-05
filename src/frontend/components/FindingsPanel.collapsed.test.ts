// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  FindingsPanel,
  HEALTHY_SECTION_COLLAPSED_KEY,
  SNOOZED_SECTION_COLLAPSED_KEY,
  COMPLETED_SECTION_COLLAPSED_KEY,
  PENDING_SECTION_COLLAPSED_KEY,
} from './FindingsPanel.js';
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

function renderPanel(container: HTMLElement, lists: {
  healthy?: AgentState[];
  pending?: AgentState[];
  snoozed?: AgentState[];
  completed?: AgentState[];
  send?: (msg: ClientMessage) => void;
  clearCompletedFinishedCount?: number;
  clearCompletedTerminatedCount?: number;
  clearCompletedProjectId?: string;
}): Root {
  const root = createRoot(container);
  act(() => {
    root.render(React.createElement(FindingsPanel, {
      findings: [],
      healthy: lists.healthy ?? [],
      pending: lists.pending ?? [],
      snoozed: lists.snoozed ?? [],
      completed: lists.completed ?? [],
      selectedAgentId: null,
      send: lists.send ?? vi.fn(),
      clearCompletedFinishedCount: lists.clearCompletedFinishedCount ?? 0,
      clearCompletedTerminatedCount: lists.clearCompletedTerminatedCount ?? 0,
      clearCompletedProjectId: lists.clearCompletedProjectId,
    }));
  });
  return root;
}

describe('FindingsPanel collapsed-state persistence', () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    syncGlobalStore();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ checks: {}, fires: {}, falsePositives: {} }),
      text: async () => '{}',
    })));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = null;
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  test('Healthy and Pending default to expanded; Snoozed and Completed default to collapsed', () => {
    root = renderPanel(container, {
      healthy: [makeAgent({ agentId: 'h1' })],
      pending: [makeAgent({ agentId: 'p1' })],
      snoozed: [makeAgent({ agentId: 's1', snoozedUntil: Date.now() + 60_000 })],
      completed: [makeAgent({ agentId: 'c1', taskStatus: 'completed' })],
    });

    expect(container.querySelector('.healthy-section .section-header')?.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('.pending-section .section-header')?.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('.snoozed-section .section-header')?.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('.completed-section .section-header')?.getAttribute('aria-expanded')).toBe('false');

    expect(container.querySelectorAll('.snoozed-row').length).toBe(0);
    expect(container.querySelectorAll('.completed-row').length).toBe(0);
    expect(container.querySelectorAll('.pending-row').length).toBe(1);
  });

  test('stored localStorage value overrides the default for each section', () => {
    localStorage.setItem(HEALTHY_SECTION_COLLAPSED_KEY, '1');
    localStorage.setItem(SNOOZED_SECTION_COLLAPSED_KEY, '0');
    localStorage.setItem(COMPLETED_SECTION_COLLAPSED_KEY, '0');
    localStorage.setItem(PENDING_SECTION_COLLAPSED_KEY, '1');

    root = renderPanel(container, {
      healthy: [makeAgent({ agentId: 'h1' })],
      pending: [makeAgent({ agentId: 'p1' })],
      snoozed: [makeAgent({ agentId: 's1', snoozedUntil: Date.now() + 60_000 })],
      completed: [makeAgent({ agentId: 'c1', taskStatus: 'completed' })],
    });

    expect(container.querySelector('.healthy-section .section-header')?.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('.pending-section .section-header')?.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('.snoozed-section .section-header')?.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('.completed-section .section-header')?.getAttribute('aria-expanded')).toBe('true');

    expect(container.querySelectorAll('.snoozed-row').length).toBe(1);
    expect(container.querySelectorAll('.completed-row').length).toBe(1);
    expect(container.querySelectorAll('.pending-row').length).toBe(0);
  });

  test('clicking a section header toggles state and writes "1" / "0" to localStorage', () => {
    root = renderPanel(container, {
      snoozed: [makeAgent({ agentId: 's1', snoozedUntil: Date.now() + 60_000 })],
    });

    const header = container.querySelector('.snoozed-section .section-header') as HTMLElement;
    expect(header.getAttribute('aria-expanded')).toBe('false');

    act(() => header.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(localStorage.getItem(SNOOZED_SECTION_COLLAPSED_KEY)).toBe('0');
    expect(header.getAttribute('aria-expanded')).toBe('true');

    act(() => header.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(localStorage.getItem(SNOOZED_SECTION_COLLAPSED_KEY)).toBe('1');
    expect(header.getAttribute('aria-expanded')).toBe('false');
  });

  test('each section uses its own localStorage key (Healthy / Pending / Completed wiring)', () => {
    root = renderPanel(container, {
      healthy: [makeAgent({ agentId: 'h1' })],
      pending: [makeAgent({ agentId: 'p1' })],
      completed: [makeAgent({ agentId: 'c1', taskStatus: 'completed' })],
    });

    const wired: Array<[string, string]> = [
      ['.healthy-section .section-header', HEALTHY_SECTION_COLLAPSED_KEY],
      ['.pending-section .section-header', PENDING_SECTION_COLLAPSED_KEY],
      ['.completed-section .section-header', COMPLETED_SECTION_COLLAPSED_KEY],
    ];

    for (const [selector, expectedKey] of wired) {
      const header = container.querySelector(selector) as HTMLElement;
      expect(header, `header missing for ${selector}`).toBeTruthy();
      const before = localStorage.getItem(expectedKey);
      act(() => header.dispatchEvent(new MouseEvent('click', { bubbles: true })));
      const after = localStorage.getItem(expectedKey);
      expect(after, `${selector} did not write to ${expectedKey}`).not.toBe(before);
      expect(after === '1' || after === '0').toBe(true);
    }
  });

  test('clear completed sends the selected project scope when provided', async () => {
    const send = vi.fn();
    root = renderPanel(container, {
      completed: [makeAgent({ agentId: 'c1', taskStatus: 'completed' })],
      send,
      clearCompletedFinishedCount: 1,
      clearCompletedProjectId: 'github.com/acme/project',
    });

    const clearButton = container.querySelector<HTMLButtonElement>('button.btn-clear-completed')!;
    await act(async () => {
      clearButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const deleteButton = Array.from(document.querySelectorAll<HTMLButtonElement>('.confirm-dialog button'))
      .find((button) => button.textContent === 'Delete')!;
    await act(async () => {
      deleteButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(send).toHaveBeenCalledWith({
      type: 'clearCompleted',
      includeTerminated: false,
      projectId: 'github.com/acme/project',
    });
  });

  test('clear completed omits project scope for the all-projects panel', async () => {
    const send = vi.fn();
    root = renderPanel(container, {
      completed: [makeAgent({ agentId: 'c1', taskStatus: 'completed' })],
      send,
      clearCompletedFinishedCount: 1,
    });

    const clearButton = container.querySelector<HTMLButtonElement>('button.btn-clear-completed')!;
    await act(async () => {
      clearButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const deleteButton = Array.from(document.querySelectorAll<HTMLButtonElement>('.confirm-dialog button'))
      .find((button) => button.textContent === 'Delete')!;
    await act(async () => {
      deleteButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(send).toHaveBeenCalledWith({
      type: 'clearCompleted',
      includeTerminated: false,
    });
  });
});
