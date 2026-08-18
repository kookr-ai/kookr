// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { FindingsPanel } from './FindingsPanel.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import type { AgentState } from '../../shared/protocol.js';
import type { AnomalyType } from '../../shared/contracts/anomalies.js';

function syncGlobalStore() {
  const freshState = createKookrStore().getState();
  const nextData = Object.fromEntries(
    Object.entries(freshState).filter(([, value]) => typeof value !== 'function'),
  );
  useKookrStore.setState(nextData);
}

function makeFinding(agentId: string, type: AnomalyType): AgentState {
  return {
    agentId,
    taskId: `task-${agentId}`,
    taskName: `${agentId} task`,
    description: 'Working',
    events: [],
    anomaly: {
      type,
      severity: 'warning',
      explanation: `${type} finding`,
      detectedAt: '2026-07-19T00:00:00.000Z',
    },
    taskStatus: 'inProgress',
    cwd: '/tmp/project',
  } as AgentState;
}

function renderPanel(root: Root, findings: AgentState[]) {
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
}

describe('FindingsPanel type-filter chip counts', () => {
  let container: HTMLDivElement;
  let root: Root;

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
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  test('each chip shows the live count for its type', () => {
    renderPanel(root, [
      makeFinding('perm-1', 'permission_blocked'),
      makeFinding('perm-2', 'permission_blocked'),
      makeFinding('perm-3', 'permission_blocked'),
      makeFinding('input-1', 'needs_input'),
    ]);

    const permChip = container.querySelector<HTMLElement>('[data-testid="finding-type-chip-permission_blocked"]');
    const inputChip = container.querySelector<HTMLElement>('[data-testid="finding-type-chip-needs_input"]');
    expect(permChip).not.toBeNull();
    expect(inputChip).not.toBeNull();

    expect(permChip?.querySelector('.findings-type-chip-count')?.textContent).toBe('3');
    expect(inputChip?.querySelector('.findings-type-chip-count')?.textContent).toBe('1');

    // Accessible name qualifies the count and pluralizes correctly.
    expect(permChip?.getAttribute('aria-label')).toBe('Permission, 3 findings');
    expect(inputChip?.getAttribute('aria-label')).toBe('Needs Input, 1 finding');
  });

  const permCount = () =>
    container.querySelector('[data-testid="finding-type-chip-permission_blocked"] .findings-type-chip-count')?.textContent;

  test('counts rise when a finding of that type appears', () => {
    renderPanel(root, [makeFinding('perm-1', 'permission_blocked')]);
    expect(permCount()).toBe('1');

    renderPanel(root, [
      makeFinding('perm-1', 'permission_blocked'),
      makeFinding('perm-2', 'permission_blocked'),
    ]);
    expect(permCount()).toBe('2');
  });

  test('counts fall when a finding resolves, and the chip disappears when its last finding clears', () => {
    renderPanel(root, [
      makeFinding('perm-1', 'permission_blocked'),
      makeFinding('perm-2', 'permission_blocked'),
    ]);
    expect(permCount()).toBe('2');

    // One permission finding resolves — count decrements.
    renderPanel(root, [makeFinding('perm-1', 'permission_blocked')]);
    expect(permCount()).toBe('1');

    // The last permission finding resolves — the chip drops from the row.
    renderPanel(root, [makeFinding('input-1', 'needs_input')]);
    expect(container.querySelector('[data-testid="finding-type-chip-permission_blocked"]')).toBeNull();
    expect(
      container.querySelector('[data-testid="finding-type-chip-needs_input"] .findings-type-chip-count')?.textContent,
    ).toBe('1');
  });

  test('counts track a finding changing type', () => {
    renderPanel(root, [
      makeFinding('a', 'permission_blocked'),
      makeFinding('b', 'permission_blocked'),
    ]);
    expect(permCount()).toBe('2');

    // Agent "b" flips from permission_blocked to needs_input.
    renderPanel(root, [
      makeFinding('a', 'permission_blocked'),
      makeFinding('b', 'needs_input'),
    ]);
    expect(permCount()).toBe('1');
    expect(
      container.querySelector('[data-testid="finding-type-chip-needs_input"] .findings-type-chip-count')?.textContent,
    ).toBe('1');
  });

  test('chip row is hidden when there are no findings', () => {
    renderPanel(root, []);
    expect(container.querySelector('.findings-type-filters')).toBeNull();
  });
});
