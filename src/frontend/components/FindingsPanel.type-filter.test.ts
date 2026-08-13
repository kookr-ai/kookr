// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { FindingsPanel } from './FindingsPanel.js';
import { FINDING_TYPE_FILTER_KEY } from '../finding-type-filter.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import type { AgentState } from '../../shared/protocol.js';

function syncGlobalStore() {
  const freshState = createKookrStore().getState();
  const nextData = Object.fromEntries(
    Object.entries(freshState).filter(([, value]) => typeof value !== 'function'),
  );
  useKookrStore.setState(nextData);
}

function makeFinding(id: string, type: NonNullable<AgentState['anomaly']>['type'], taskName: string): AgentState {
  return {
    agentId: id,
    taskId: `task-${id}`,
    taskName,
    description: 'Working',
    events: [],
    taskStatus: 'inProgress',
    cwd: '/tmp/project',
    anomaly: {
      agentId: id,
      type,
      severity: 'warning',
      explanation: `${type} on ${taskName}`,
      detectedAt: new Date('2026-08-13T00:00:00.000Z'),
    },
  } as AgentState;
}

function renderPanel(container: HTMLElement, findings: AgentState[]): Root {
  const root = createRoot(container);
  act(() => {
    root.render(React.createElement(FindingsPanel, {
      findings,
      healthy: [],
      pending: [],
      snoozed: [],
      completed: [],
      selectedAgentId: null,
      send: vi.fn(),
      clearCompletedFinishedCount: 0,
      clearCompletedTerminatedCount: 0,
    }));
  });
  return root;
}

function cardNames(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('.finding-card .finding-task'))
    .map((node) => node.textContent ?? '');
}

function chip(container: HTMLElement, type: string): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>(`[data-testid="finding-type-chip-${type}"]`)!;
}

describe('FindingsPanel type-filter chips (issue #2445)', () => {
  let container: HTMLDivElement;
  let root: Root | null;

  const findings = [
    makeFinding('perm', 'permission_blocked', 'Needs sudo'),
    makeFinding('budget', 'budget_exceeded', 'Out of tokens'),
    makeFinding('idle', 'needs_input', 'Waiting on you'),
  ];

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
    container = document.body.appendChild(document.createElement('div'));
    root = null;
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  test('renders one chip per present type and shows every card until a chip is clicked', () => {
    root = renderPanel(container, findings);

    expect(container.querySelectorAll('[data-testid^="finding-type-chip-"]').length).toBe(3);
    expect(chip(container, 'permission_blocked').textContent).toContain('Permission');
    expect(chip(container, 'budget_exceeded').textContent).toContain('Budget Exceeded');
    expect(chip(container, 'needs_input').textContent).toContain('Needs Input');
    expect(cardNames(container)).toEqual(['Needs sudo', 'Out of tokens', 'Waiting on you']);
    expect(container.querySelector('.findings-count')?.textContent).toBe('3 active');
  });

  test('clicking a chip hides other types; clicking again restores', () => {
    root = renderPanel(container, findings);

    act(() => chip(container, 'permission_blocked').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(cardNames(container)).toEqual(['Needs sudo']);
    expect(chip(container, 'permission_blocked').getAttribute('aria-pressed')).toBe('true');
    expect(chip(container, 'budget_exceeded').getAttribute('aria-pressed')).toBe('false');

    act(() => chip(container, 'permission_blocked').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(cardNames(container)).toEqual(['Needs sudo', 'Out of tokens', 'Waiting on you']);
    expect(chip(container, 'permission_blocked').getAttribute('aria-pressed')).toBe('false');
  });

  test('multi-select is OR and persists across remount via localStorage', () => {
    root = renderPanel(container, findings);

    act(() => chip(container, 'permission_blocked').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    act(() => chip(container, 'needs_input').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(cardNames(container)).toEqual(['Needs sudo', 'Waiting on you']);
    expect(JSON.parse(localStorage.getItem(FINDING_TYPE_FILTER_KEY) ?? '[]')).toEqual([
      'permission_blocked',
      'needs_input',
    ]);

    act(() => root?.unmount());
    root = null;
    root = renderPanel(container, findings);
    expect(cardNames(container)).toEqual(['Needs sudo', 'Waiting on you']);
    expect(chip(container, 'permission_blocked').getAttribute('aria-pressed')).toBe('true');
    expect(chip(container, 'needs_input').getAttribute('aria-pressed')).toBe('true');
  });

  test('does not render chips when the rail has no findings', () => {
    root = renderPanel(container, []);
    expect(container.querySelector('[data-testid^="finding-type-chip-"]')).toBeNull();
  });
});
