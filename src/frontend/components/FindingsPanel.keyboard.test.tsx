// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  COMPLETED_SECTION_COLLAPSED_KEY,
  FindingsPanel,
  SNOOZED_SECTION_COLLAPSED_KEY,
} from './FindingsPanel.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import type { AgentState } from '../../shared/protocol.js';

function syncGlobalStore() {
  const freshState = createKookrStore().getState();
  const nextData = Object.fromEntries(
    Object.entries(freshState).filter(([, value]) => typeof value !== 'function'),
  );
  useKookrStore.setState(nextData);
}

function makeAgent(agentId: string, overrides: Partial<AgentState> = {}): AgentState {
  return {
    agentId,
    taskId: `task-${agentId}`,
    taskName: `${agentId} task`,
    description: 'Working',
    events: [],
    anomaly: null,
    taskStatus: 'inProgress',
    cwd: '/tmp/project',
    ...overrides,
  } as AgentState;
}

function pressKey(element: HTMLElement, key: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key });
  act(() => element.dispatchEvent(event));
  return event;
}

describe('FindingsPanel rail row keyboard activation', () => {
  let container: HTMLDivElement;
  let root: Root;
  let selectAgentSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    localStorage.setItem(SNOOZED_SECTION_COLLAPSED_KEY, '0');
    localStorage.setItem(COMPLETED_SECTION_COLLAPSED_KEY, '0');
    syncGlobalStore();
    selectAgentSpy = vi.fn(useKookrStore.getState().selectAgent);
    useKookrStore.setState({ selectAgent: selectAgentSpy });
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ checks: {}, fires: {}, falsePositives: {} }),
      text: async () => '{}',
    })));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root.render(React.createElement(FindingsPanel, {
        findings: [makeAgent('finding', {
          anomaly: {
            type: 'needs_input',
            severity: 'warning',
            explanation: 'Waiting for input',
            detectedAt: '2026-07-19T00:00:00.000Z',
          },
        })],
        healthy: [makeAgent('healthy')],
        pending: [makeAgent('pending')],
        snoozed: [makeAgent('snoozed', { snoozedUntil: Date.now() + 60_000 })],
        completed: [makeAgent('completed', { taskStatus: 'completed' })],
        selectedAgentId: null,
        send: vi.fn(),
        clearCompletedFinishedCount: 0,
        clearCompletedTerminatedCount: 0,
      }));
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  test('all rail rows are focusable buttons that select on Enter or Space', () => {
    const cases = [
      { selector: '.finding-card > .rail-row-selection-target', agentId: 'finding' },
      { selector: '.healthy-row > .rail-row-selection-target', agentId: 'healthy' },
      { selector: '.pending-row > .rail-row-selection-target', agentId: 'pending' },
      { selector: '.snoozed-row > .rail-row-selection-target', agentId: 'snoozed' },
      { selector: '.completed-row > .rail-row-selection-target', agentId: 'completed' },
    ];

    for (const { selector, agentId } of cases) {
      const row = container.querySelector<HTMLElement>(selector);
      expect(row, `missing ${selector}`).not.toBeNull();
      expect(row?.getAttribute('role')).toBe('button');
      expect(row?.tabIndex).toBe(0);

      row!.focus();
      expect(document.activeElement).toBe(row);
      for (const key of ['Enter', ' ']) {
        selectAgentSpy.mockClear();
        useKookrStore.setState({ selectedAgentId: null, selectedTaskId: null });
        const event = pressKey(row!, key);

        expect(event.defaultPrevented).toBe(true);
        expect(useKookrStore.getState().selectedAgentId).toBe(agentId);
        expect(selectAgentSpy).toHaveBeenCalledTimes(1);
      }
    }
  });

  test('focused row selection targets leave j/k navigation events untouched', () => {
    const row = container.querySelector<HTMLElement>('.healthy-row > .rail-row-selection-target');
    const propagatedKeys: string[] = [];
    const recordPropagatedKey = (event: KeyboardEvent) => propagatedKeys.push(event.key);
    expect(row).not.toBeNull();
    row!.focus();
    window.addEventListener('keydown', recordPropagatedKey);

    try {
      for (const key of ['j', 'k']) {
        selectAgentSpy.mockClear();
        useKookrStore.setState({ selectedAgentId: null, selectedTaskId: null });
        const event = pressKey(row!, key);

        expect(event.defaultPrevented).toBe(false);
        expect(useKookrStore.getState().selectedAgentId).toBeNull();
        expect(selectAgentSpy).not.toHaveBeenCalled();
      }
    } finally {
      window.removeEventListener('keydown', recordPropagatedKey);
    }

    expect(propagatedKeys).toEqual(['j', 'k']);
  });

  test('keyboard activation cancels a finding card click that is pending selection', () => {
    vi.useFakeTimers();
    const card = container.querySelector<HTMLElement>('.finding-card');
    const selectionTarget = card?.querySelector<HTMLElement>(':scope > .rail-row-selection-target');
    expect(card).not.toBeNull();
    expect(selectionTarget).not.toBeNull();

    act(() => card!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    pressKey(selectionTarget!, 'Enter');
    act(() => vi.advanceTimersByTime(250));

    expect(selectAgentSpy).toHaveBeenCalledTimes(1);
    expect(useKookrStore.getState().selectedAgentId).toBe('finding');
  });

  test('row handlers ignore key events from nested action buttons', () => {
    const replyButton = container.querySelector<HTMLElement>('.healthy-row .btn-reply');
    expect(replyButton).not.toBeNull();

    const event = pressKey(replyButton!, 'Enter');

    expect(event.defaultPrevented).toBe(false);
    expect(useKookrStore.getState().selectedAgentId).toBeNull();
  });
});
