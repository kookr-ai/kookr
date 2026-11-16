// @vitest-environment happy-dom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { AgentState } from '../../shared/protocol.js';
import type { CoordinatorChainMember, CoordinatorSnapshotState } from '../../shared/contracts/coordinator.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import { CoordinatorChainStripView, summarizeChainMembers } from './CoordinatorSurfaces.js';

const PARENT_TASK_ID = 'coordinator';

function syncGlobalStore(): void {
  const freshState = createKookrStore().getState();
  const nextData = Object.fromEntries(
    Object.entries(freshState).filter(([, value]) => typeof value !== 'function'),
  );
  useKookrStore.setState(nextData);
}

function child(index: number, status: string): CoordinatorChainMember {
  return { taskId: `child-${index}`, label: `Child ${index}`, status, relation: 'child' };
}

/** 55 children: children 10, 20 and 30 running, 49 completed, 3 cancelled or terminated. */
function fiftyFiveChildren(): CoordinatorChainMember[] {
  return Array.from({ length: 55 }, (_, i) => {
    if (i === 10 || i === 20 || i === 30) return child(i, 'inProgress');
    if (i === 52) return child(i, 'cancelled');
    if (i === 53 || i === 54) return child(i, 'terminated');
    return child(i, 'completed');
  });
}

function setChain(taskId: string, members: CoordinatorChainMember[]): void {
  const coordinator: CoordinatorSnapshotState = {
    outputs: [],
    chips: [],
    findings: [],
    chains: { [taskId]: { members, priorTaskIds: [], concurrencyToken: 'token' } },
  };
  useKookrStore.setState({ coordinator });
}

function agentFor(taskId: string): AgentState {
  return { agentId: `agent-${taskId}`, taskId, taskName: taskId, events: [], anomaly: null } as unknown as AgentState;
}

describe('CoordinatorChainStripView (#3939)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    syncGlobalStore();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    localStorage.clear();
  });

  function render(taskId = PARENT_TASK_ID): void {
    act(() => root.render(React.createElement(CoordinatorChainStripView, { agent: agentFor(taskId) })));
  }

  function chipIds(): string[] {
    return [...container.querySelectorAll('[data-testid="coordinator-chain-member"]')]
      .map((chip) => chip.getAttribute('title') ?? '');
  }

  function toggle(): HTMLButtonElement {
    const button = container.querySelector<HTMLButtonElement>('[data-testid="coordinator-chain-toggle"]');
    expect(button, 'toggle button').not.toBeNull();
    return button!;
  }

  test('a long chain starts collapsed: summary line plus only the running chips', () => {
    setChain(PARENT_TASK_ID, fiftyFiveChildren());
    render();

    expect(container.querySelector('[data-testid="coordinator-chain-summary"]')?.textContent)
      .toBe('55 children · 3 in progress · 49 completed · 3 cancelled or terminated');
    expect(chipIds()).toEqual(['child-10', 'child-20', 'child-30']);
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(toggle().textContent).toBe('Show all 55');
    const list = container.querySelector('[data-testid="coordinator-chain-members"]');
    expect(toggle().getAttribute('aria-controls')).toBe(list?.id);
    expect(list?.classList.contains('coordinator-chain-members--active')).toBe(true);
  });

  test('expanded, all 55 chips sit in the bounded scroll container, active ones first', () => {
    setChain(PARENT_TASK_ID, fiftyFiveChildren());
    render();
    act(() => toggle().click());

    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    const list = container.querySelector('[data-testid="coordinator-chain-members"]');
    // The height bound itself is CSS (max-height on this class); the e2e
    // viewport-budget spec measures it in a real browser.
    expect(list?.classList.contains('coordinator-chain-members--expanded')).toBe(true);
    const ids = [...list!.querySelectorAll('[data-testid="coordinator-chain-member"]')]
      .map((chip) => chip.getAttribute('title'));
    expect(ids).toHaveLength(55);
    expect(ids.slice(0, 3)).toEqual(['child-10', 'child-20', 'child-30']);
    expect(new Set(ids).size).toBe(55);

    act(() => toggle().click());
    expect(chipIds()).toEqual(['child-10', 'child-20', 'child-30']);
  });

  test('the expanded choice is remembered per task across remounts', () => {
    setChain(PARENT_TASK_ID, fiftyFiveChildren());
    render();
    act(() => toggle().click());
    act(() => root.unmount());
    root = createRoot(container);
    render();
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    expect(chipIds()).toHaveLength(55);

    // Another task with a long chain is not affected by that choice.
    setChain('other', fiftyFiveChildren());
    render('other');
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
  });

  test('still renders when browser storage throws', () => {
    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = () => { throw new Error('blocked'); };
    try {
      setChain(PARENT_TASK_ID, fiftyFiveChildren());
      render();
      expect(toggle().getAttribute('aria-expanded')).toBe('false');
      expect(chipIds()).toHaveLength(3);
    } finally {
      Storage.prototype.getItem = original;
    }
  });

  test('a short chain shows every chip with no toggle, in server order', () => {
    const members = [child(1, 'completed'), child(2, 'inProgress'), child(3, 'cancelled')];
    setChain(PARENT_TASK_ID, members);
    render();
    expect(container.querySelector('[data-testid="coordinator-chain-toggle"]')).toBeNull();
    expect(container.querySelector('[data-testid="coordinator-chain-summary"]')).toBeNull();
    expect(chipIds()).toEqual(['child-1', 'child-2', 'child-3']);
  });

  test('summary counts each relation kind and keeps unknown statuses', () => {
    expect(summarizeChainMembers([
      { taskId: 'p', label: 'P', status: 'completed', relation: 'parent' },
      child(1, 'pending'),
      child(2, 'open'),
      { taskId: 'b', label: 'B', status: 'paused', relation: 'blocked_by' },
    ])).toBe('1 parent · 2 children · 1 blocker · 2 not started · 1 completed · 1 paused');
  });
});
