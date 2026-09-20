// @vitest-environment jsdom

/**
 * FindingsPanel Completed-rail expand + scroll (issue #3333). App bumps
 * `expandCompletedNonce` when the status-bar 24h chip is clicked; the panel
 * reuses `expandCompleted` and scrolls the section into view. Count refreshes
 * must not expand the section.
 */

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  FindingsPanel,
  COMPLETED_SECTION_COLLAPSED_KEY,
  __resetExpandCompletedNonceForTests,
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
    taskStatus: 'completed',
    cwd: '/tmp/project',
    finishedAt: '2026-09-20T12:00:00.000Z',
    ...overrides,
  } as AgentState;
}

function renderPanel(root: Root, props: {
  completed?: AgentState[];
  expandCompletedNonce?: number;
  send?: (msg: ClientMessage) => void;
}): void {
  act(() => {
    root.render(React.createElement(FindingsPanel, {
      findings: [],
      healthy: [],
      pending: [],
      snoozed: [],
      completed: props.completed ?? [makeAgent()],
      selectedAgentId: null,
      send: props.send ?? vi.fn(),
      clearCompletedFinishedCount: 1,
      clearCompletedTerminatedCount: 0,
      expandCompletedNonce: props.expandCompletedNonce,
    }));
  });
}

describe('FindingsPanel completed-24h chip expand request (issue #3333)', () => {
  let container: HTMLDivElement;
  let root: Root | null;
  let originalScrollIntoView: typeof Element.prototype.scrollIntoView | undefined;
  let scrolledElements: Element[];
  let scrollOptions: unknown[];

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    localStorage.clear();
    __resetExpandCompletedNonceForTests();
    syncGlobalStore();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ checks: {}, fires: {}, falsePositives: {} }),
      text: async () => '{}',
    })));
    originalScrollIntoView = Element.prototype.scrollIntoView;
    scrolledElements = [];
    scrollOptions = [];
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value(this: Element, options?: ScrollIntoViewOptions | boolean) {
        scrolledElements.push(this);
        scrollOptions.push(options);
      },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    if (originalScrollIntoView) {
      Object.defineProperty(Element.prototype, 'scrollIntoView', {
        configurable: true,
        value: originalScrollIntoView,
      });
    } else {
      delete (Element.prototype as Element & { scrollIntoView?: unknown }).scrollIntoView;
    }
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  test('a nonce bump expands a collapsed Completed section and scrolls it into view', () => {
    renderPanel(root!, { expandCompletedNonce: 0 });
    expect(container.querySelector('.completed-section .section-header')?.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelectorAll('.completed-row').length).toBe(0);
    expect(scrolledElements).toHaveLength(0);

    renderPanel(root!, { expandCompletedNonce: 1 });
    act(() => vi.runOnlyPendingTimers());

    expect(container.querySelector('.completed-section .section-header')?.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelectorAll('.completed-row').length).toBe(1);
    expect(localStorage.getItem(COMPLETED_SECTION_COLLAPSED_KEY)).toBe('0');
    expect(scrolledElements).toHaveLength(1);
    expect(scrolledElements[0]).toBe(container.querySelector('.completed-section'));
    expect(scrollOptions[0]).toEqual({ block: 'nearest' });
  });

  test('an already-expanded Completed section still scrolls into view without collapsing', () => {
    localStorage.setItem(COMPLETED_SECTION_COLLAPSED_KEY, '0');
    renderPanel(root!, { expandCompletedNonce: 0 });
    expect(container.querySelector('.completed-section .section-header')?.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelectorAll('.completed-row').length).toBe(1);

    renderPanel(root!, { expandCompletedNonce: 1 });
    act(() => vi.runOnlyPendingTimers());

    expect(container.querySelector('.completed-section .section-header')?.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelectorAll('.completed-row').length).toBe(1);
    expect(scrolledElements).toHaveLength(1);
    expect(scrolledElements[0]).toBe(container.querySelector('.completed-section'));
  });

  test('a consumed click does not re-expand after remount if the operator collapsed Completed', () => {
    renderPanel(root!, { expandCompletedNonce: 0 });
    renderPanel(root!, { expandCompletedNonce: 1 });
    act(() => vi.runOnlyPendingTimers());
    expect(container.querySelector('.completed-section .section-header')?.getAttribute('aria-expanded')).toBe('true');

    const header = container.querySelector<HTMLButtonElement>('.completed-section .section-header');
    act(() => header!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(container.querySelector('.completed-section .section-header')?.getAttribute('aria-expanded')).toBe('false');
    expect(localStorage.getItem(COMPLETED_SECTION_COLLAPSED_KEY)).toBe('1');

    act(() => root!.unmount());
    root = createRoot(container);
    scrolledElements.length = 0;
    renderPanel(root, { expandCompletedNonce: 1 });
    act(() => vi.runOnlyPendingTimers());

    expect(container.querySelector('.completed-section .section-header')?.getAttribute('aria-expanded')).toBe('false');
    expect(scrolledElements).toHaveLength(0);
  });

  test('a chip click that mounts the panel under StrictMode still scrolls', () => {
    act(() => root!.unmount());
    root = createRoot(container);
    act(() => {
      root!.render(React.createElement(React.StrictMode, null, React.createElement(FindingsPanel, {
        findings: [],
        healthy: [],
        pending: [],
        snoozed: [],
        completed: [makeAgent()],
        selectedAgentId: null,
        send: vi.fn(),
        clearCompletedFinishedCount: 1,
        clearCompletedTerminatedCount: 0,
        expandCompletedNonce: 1,
      })));
    });
    act(() => vi.runOnlyPendingTimers());

    expect(container.querySelector('.completed-section .section-header')?.getAttribute('aria-expanded')).toBe('true');
    expect(scrolledElements).toHaveLength(1);
    expect(scrolledElements[0]).toBe(container.querySelector('.completed-section'));
  });

  test('refreshing the completed list without a nonce bump does not expand or scroll', () => {
    renderPanel(root!, {
      completed: [makeAgent({ agentId: 'c1', taskId: 't1' })],
      expandCompletedNonce: 0,
    });
    expect(container.querySelector('.completed-section .section-header')?.getAttribute('aria-expanded')).toBe('false');

    renderPanel(root!, {
      completed: [
        makeAgent({ agentId: 'c1', taskId: 't1' }),
        makeAgent({ agentId: 'c2', taskId: 't2' }),
      ],
      expandCompletedNonce: 0,
    });
    act(() => vi.runOnlyPendingTimers());

    expect(container.querySelector('.completed-section .section-header')?.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelectorAll('.completed-row').length).toBe(0);
    expect(scrolledElements).toHaveLength(0);
  });
});
