// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { FindingsPanel } from './FindingsPanel.js';
import { FINDING_NAME_FILTER_KEY } from '../finding-name-filter.js';
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

function input(container: HTMLElement): HTMLInputElement {
  return container.querySelector<HTMLInputElement>('[data-testid="findings-name-filter-input"]')!;
}

function typeQuery(container: HTMLElement, value: string) {
  const el = input(container);
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function chip(container: HTMLElement, type: string): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>(`[data-testid="finding-type-chip-${type}"]`)!;
}

describe('FindingsPanel name-filter search box (issue #3125)', () => {
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

  test('renders the search box when findings exist and hides it on an empty rail', () => {
    root = renderPanel(container, findings);
    expect(input(container)).not.toBeNull();

    act(() => root?.unmount());
    root = renderPanel(container, []);
    expect(container.querySelector('[data-testid="findings-name-filter-input"]')).toBeNull();
  });

  test('empty query shows every card; a substring filters case-insensitively', () => {
    root = renderPanel(container, findings);
    expect(cardNames(container)).toEqual(['Needs sudo', 'Out of tokens', 'Waiting on you']);

    typeQuery(container, 'OUT');
    expect(cardNames(container)).toEqual(['Out of tokens']);
  });

  test('a whitespace-only query shows every card and hides the clear button', () => {
    root = renderPanel(container, findings);
    typeQuery(container, '   ');
    expect(cardNames(container)).toEqual(['Needs sudo', 'Out of tokens', 'Waiting on you']);
    expect(container.querySelector('[data-testid="findings-name-filter-clear"]')).toBeNull();
    expect(container.querySelector('[data-testid="findings-name-filter-empty"]')).toBeNull();
  });

  test('a no-match query shows a clear empty state', () => {
    root = renderPanel(container, findings);
    typeQuery(container, 'nonexistent');
    expect(cardNames(container)).toEqual([]);
    const empty = container.querySelector('[data-testid="findings-name-filter-empty"]');
    expect(empty).not.toBeNull();
    expect(empty?.textContent).toContain('nonexistent');
  });

  test('the name filter composes with a type chip', () => {
    root = renderPanel(container, findings);
    // Type filter to permission_blocked only → "Needs sudo".
    act(() => chip(container, 'permission_blocked').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(cardNames(container)).toEqual(['Needs sudo']);
    // Name query that matches a different type yields no cards (AND composition)
    // and shows the no-match empty state attributed to the name query.
    typeQuery(container, 'tokens');
    expect(cardNames(container)).toEqual([]);
    expect(container.querySelector('[data-testid="findings-name-filter-empty"]')).not.toBeNull();
    // A name query matching the chip-selected card keeps it.
    typeQuery(container, 'sudo');
    expect(cardNames(container)).toEqual(['Needs sudo']);
  });

  test('the query persists across remount via localStorage', () => {
    root = renderPanel(container, findings);
    typeQuery(container, 'waiting');
    expect(localStorage.getItem(FINDING_NAME_FILTER_KEY)).toBe('waiting');

    act(() => root?.unmount());
    root = renderPanel(container, findings);
    expect(input(container).value).toBe('waiting');
    expect(cardNames(container)).toEqual(['Waiting on you']);
  });

  test('clearing the query via the clear button restores the full list', () => {
    root = renderPanel(container, findings);
    typeQuery(container, 'sudo');
    expect(cardNames(container)).toEqual(['Needs sudo']);

    const clear = container.querySelector<HTMLButtonElement>('[data-testid="findings-name-filter-clear"]')!;
    act(() => clear.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(cardNames(container)).toEqual(['Needs sudo', 'Out of tokens', 'Waiting on you']);
    expect(localStorage.getItem(FINDING_NAME_FILTER_KEY)).toBeNull();
  });
});
