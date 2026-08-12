// @vitest-environment jsdom

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
  props: Partial<React.ComponentProps<typeof FindingsPanel>> = {},
): void {
  act(() => {
    root.render(React.createElement(FindingsPanel, {
      findings: [],
      healthy: [],
      pending: [],
      snoozed: [],
      completed: [],
      selectedAgentId: null,
      selectedTaskId: null,
      send: (() => {}) as (msg: ClientMessage) => void,
      clearCompletedFinishedCount: 0,
      clearCompletedTerminatedCount: 0,
      ...props,
    }));
  });
}

function launchButton(): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === 'Launch New Task',
  ) as HTMLButtonElement | undefined;
}

let container: HTMLDivElement;
let root: Root;

describe('FindingsPanel — cold-start Launch CTA (issue #2394)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    syncGlobalStore();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  test('cold empty rail shows a primary Launch CTA and quick-launch hint', () => {
    renderPanel({ onLaunch: vi.fn() });

    expect(container.querySelector('.findings-empty')?.textContent).toContain('No agents running yet');
    const button = launchButton();
    expect(button).toBeDefined();
    expect(button?.className).toContain('btn-primary');
    expect(container.querySelector('.findings-empty-hint')?.textContent).toContain('quick launch');
  });

  test('clicking the CTA calls onLaunch', () => {
    const onLaunch = vi.fn();
    renderPanel({ onLaunch });

    act(() => launchButton()?.click());
    expect(onLaunch).toHaveBeenCalledTimes(1);
  });

  test('empty rail without onLaunch keeps the muted copy and shows no CTA', () => {
    renderPanel();

    expect(container.querySelector('.findings-empty')?.textContent).toContain('No agents running yet');
    expect(launchButton()).toBeUndefined();
  });

  test('CTA is absent when any agent exists in the rail buckets', () => {
    renderPanel({ findings: [makeAgent()], onLaunch: vi.fn() });

    expect(container.querySelector('.findings-empty')).toBeNull();
    expect(launchButton()).toBeUndefined();
  });

  test('CTA is absent when a non-findings bucket (completed) has agents', () => {
    renderPanel({ completed: [makeAgent()], onLaunch: vi.fn() });

    expect(container.querySelector('.findings-empty')).toBeNull();
    expect(launchButton()).toBeUndefined();
  });
});
