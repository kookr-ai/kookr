// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { FindingsPanel } from './FindingsPanel.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import type { AgentState } from '../../shared/protocol.js';

function syncGlobalStore() {
  const freshState = createKookrStore().getState();
  const nextData = Object.fromEntries(
    Object.entries(freshState).filter(([, value]) => typeof value !== 'function'),
  );
  useKookrStore.setState(nextData);
}

function makeFinding(agentId: string, taskName: string): AgentState {
  return {
    agentId,
    taskId: `task-${agentId}`,
    taskName,
    description: 'Working',
    events: [],
    anomaly: {
      agentId,
      type: 'needs_input',
      severity: 'warning',
      explanation: `${taskName} needs input`,
      detectedAt: new Date('2026-06-26T12:00:00Z'),
    },
    taskStatus: 'inProgress',
    cwd: '/tmp/project',
  } as AgentState;
}

function makeRootCauseFinding(agentId: string, taskName: string, relatedFindingIds: string[]): AgentState {
  return {
    ...makeFinding(agentId, taskName),
    anomaly: {
      agentId,
      type: 'needs_input',
      severity: 'warning',
      explanation: `${taskName} needs input`,
      detectedAt: new Date('2026-06-26T12:00:00Z'),
      likelyRootCause: true,
      relatedFindingIds,
    },
  } as AgentState;
}

function renderPanel(root: Root, findings: AgentState[], selectedAgentId: string | null): void {
  act(() => {
    root.render(React.createElement(FindingsPanel, {
      findings,
      healthy: [],
      pending: [],
      snoozed: [],
      completed: [],
      selectedAgentId,
      send: vi.fn(),
      clearCompletedFinishedCount: 0,
      clearCompletedTerminatedCount: 0,
    }));
  });
}

describe('FindingsPanel selected finding scroll', () => {
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

  test('scrolls the newly selected finding into view with nearest block positioning', () => {
    const findings = [
      makeFinding('agent-1', 'First task'),
      makeFinding('agent-2', 'Second task'),
    ];

    renderPanel(root!, findings, null);
    act(() => vi.runOnlyPendingTimers());
    expect(scrolledElements).toHaveLength(0);

    renderPanel(root!, findings, 'agent-2');
    act(() => vi.runOnlyPendingTimers());

    expect(scrolledElements).toHaveLength(1);
    expect(scrollOptions[0]).toEqual({ block: 'nearest' });
    expect(scrolledElements[0]).toBe(container.querySelector('[aria-current="true"]'));
    expect(scrolledElements[0]?.textContent).toContain('Second task');

    renderPanel(root!, findings, 'agent-1');
    act(() => vi.runOnlyPendingTimers());

    expect(scrolledElements).toHaveLength(2);
    expect(scrollOptions[1]).toEqual({ block: 'nearest' });
    expect(scrolledElements[1]).toBe(container.querySelector('[aria-current="true"]'));
    expect(scrolledElements[1]?.textContent).toContain('First task');
  });

  test('expands a root-cause group before scrolling a selected related finding', () => {
    const findings = [
      makeRootCauseFinding('root-agent', 'Root task', ['child-agent']),
      makeFinding('child-agent', 'Child task'),
    ];

    renderPanel(root!, findings, null);
    const toggle = container.querySelector<HTMLButtonElement>('.root-cause-toggle');
    expect(toggle).toBeInstanceOf(HTMLButtonElement);
    act(() => toggle!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(container.textContent).not.toContain('Child task');

    renderPanel(root!, findings, 'child-agent');
    act(() => vi.runOnlyPendingTimers());

    expect(container.querySelector('.root-cause-toggle')?.getAttribute('aria-expanded')).toBe('true');
    expect(scrolledElements).toHaveLength(1);
    expect(scrollOptions[0]).toEqual({ block: 'nearest' });
    expect(scrolledElements[0]).toBe(container.querySelector('[aria-current="true"]'));
    expect(scrolledElements[0]?.textContent).toContain('Child task');
  });
});
