// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { AgentState } from '../../shared/protocol.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import { TaskDependencyEditor } from './TaskDependencyEditor.js';

function syncGlobalStore() {
  const freshState = createKookrStore().getState();
  const nextData = Object.fromEntries(
    Object.entries(freshState).filter(([, value]) => typeof value !== 'function'),
  );
  useKookrStore.setState(nextData);
}

function makeAgent(partial: Partial<AgentState> & { agentId: string }): AgentState {
  return {
    agentId: partial.agentId,
    events: [],
    anomaly: null,
    ...partial,
  } as AgentState;
}

describe('TaskDependencyEditor', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    syncGlobalStore();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  test('renders a compact add affordance when the task has no explicit dependencies', () => {
    const agent = makeAgent({ agentId: 'agent-1', taskId: 'task-1', taskName: 'No dependencies' });
    useKookrStore.setState({ agents: [agent] });

    act(() => {
      root.render(React.createElement(TaskDependencyEditor, { agent }));
    });

    const section = container.querySelector('[data-testid="task-dependencies"]');
    expect(section).not.toBeNull();
    expect(section?.classList.contains('task-dependencies--empty')).toBe(true);
    expect(section?.textContent).toContain('Relationships');
    expect(section?.textContent).toContain('No dependencies');
    expect(container.textContent).not.toContain('None');
  });

  test('renders a blocking alert and compact relationships menu for blockers', () => {
    const blocker = makeAgent({ agentId: 'blocker-agent', taskId: 'task-blocker', taskName: 'CI smoke verification' });
    const agent = makeAgent({
      agentId: 'agent-1',
      taskId: 'task-1',
      taskName: 'Deploy production restart fix',
      blocked_by: ['task:task-blocker', 'milestone:manual approval'],
      blocks: ['task:task-downstream'],
    });
    const downstream = makeAgent({ agentId: 'downstream-agent', taskId: 'task-downstream', taskName: 'Production update' });
    useKookrStore.setState({ agents: [agent, blocker, downstream] });

    act(() => {
      root.render(React.createElement(TaskDependencyEditor, { agent }));
    });

    const section = container.querySelector('[data-testid="task-dependencies"]');
    expect(section).not.toBeNull();
    expect(section?.classList.contains('task-dependencies--blocking')).toBe(true);
    expect(section?.textContent).toContain('Blocked by CI smoke verification');
    expect(section?.textContent).toContain('1 more blocker');

    const trigger = container.querySelector('.dependency-menu-trigger') as HTMLButtonElement;
    expect(trigger?.textContent).toBe('3');

    act(() => {
      trigger.click();
    });

    const menu = container.querySelector('#task-dependency-menu');
    expect(menu).not.toBeNull();
    expect(menu?.textContent).toContain('Blocked by');
    expect(menu?.textContent).toContain('manual approval');
    expect(menu?.textContent).toContain('Blocks');
    expect(menu?.textContent).toContain('Production update');
    expect(menu?.textContent).toContain('Add blocker');
    expect(menu?.textContent).toContain('Add downstream');

    const addDownstream = Array.from(menu!.querySelectorAll('button'))
      .find((button) => button.textContent === 'Add downstream') as HTMLButtonElement;
    act(() => {
      addDownstream.click();
    });

    expect(container.querySelector('#task-dependency-menu')).toBeNull();
    const modal = container.querySelector('[data-testid="dependency-modal"]');
    expect(modal).not.toBeNull();
    const activeToggle = modal?.querySelector('.dependency-field-toggle button.active');
    expect(activeToggle?.textContent).toContain('Blocks');
  });

  test('focuses and dismisses the relationships menu with Escape', async () => {
    const agent = makeAgent({
      agentId: 'agent-1',
      taskId: 'task-1',
      blocks: ['milestone:release notes'],
    });
    useKookrStore.setState({ agents: [agent] });

    act(() => {
      root.render(React.createElement(TaskDependencyEditor, { agent }));
    });

    const trigger = container.querySelector('.dependency-menu-trigger') as HTMLButtonElement;
    act(() => {
      trigger.focus();
      trigger.click();
    });

    const menu = container.querySelector('#task-dependency-menu') as HTMLDivElement;
    expect(document.activeElement).toBe(menu);

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await act(async () => {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    });

    expect(container.querySelector('#task-dependency-menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  test('opens the blocker task from the alert action', () => {
    const blocker = makeAgent({ agentId: 'blocker-agent', taskId: 'task-blocker', taskName: 'CI smoke verification' });
    const agent = makeAgent({
      agentId: 'agent-1',
      taskId: 'task-1',
      blocked_by: ['task:task-blocker'],
    });
    useKookrStore.setState({ agents: [agent, blocker], selectedAgentId: agent.agentId });

    act(() => {
      root.render(React.createElement(TaskDependencyEditor, { agent }));
    });

    const openBlocker = container.querySelector('.dependency-open-related') as HTMLButtonElement;
    act(() => {
      openBlocker.click();
    });

    expect(useKookrStore.getState().selectedAgentId).toBe('blocker-agent');
  });

  test('shows a muted compact menu row for downstream-only relationships', () => {
    const agent = makeAgent({
      agentId: 'agent-1',
      taskId: 'task-1',
      blocks: ['milestone:release notes'],
    });
    useKookrStore.setState({ agents: [agent] });

    act(() => {
      root.render(React.createElement(TaskDependencyEditor, { agent }));
    });

    const section = container.querySelector('[data-testid="task-dependencies"]');
    expect(section).not.toBeNull();
    expect(section?.classList.contains('task-dependencies--blocking')).toBe(false);
    expect(section?.textContent).toContain('Relationships');
    expect(section?.textContent).toContain('1 downstream task');
  });

  test('adds a downstream dependency from the compact relationships menu', async () => {
    const agent = makeAgent({
      agentId: 'agent-1',
      taskId: 'task-1',
      taskName: 'Deploy production restart fix',
    });
    const downstream = makeAgent({
      agentId: 'downstream-agent',
      taskId: 'task-downstream',
      taskName: 'Production update',
    });
    useKookrStore.setState({ agents: [agent, downstream] });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, task: { blocks: ['task:task-downstream'], blocked_by: [] } }),
    } as Response);

    act(() => {
      root.render(React.createElement(TaskDependencyEditor, { agent }));
    });

    const trigger = container.querySelector('.dependency-menu-trigger') as HTMLButtonElement;
    act(() => {
      trigger.click();
    });

    const menu = container.querySelector('#task-dependency-menu') as HTMLDivElement;
    const addDownstream = Array.from(menu.querySelectorAll('button'))
      .find((button) => button.textContent === 'Add downstream') as HTMLButtonElement;
    act(() => {
      addDownstream.click();
    });

    const result = Array.from(container.querySelectorAll('.dependency-result'))
      .find((button) => button.textContent?.includes('Production update')) as HTMLButtonElement;
    await act(async () => {
      result.click();
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/tasks/task-1/edges', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blocks: ['task:task-downstream'] }),
    });
  });

  test('removes an existing dependency from the compact relationships menu', async () => {
    const blocker = makeAgent({
      agentId: 'blocker-agent',
      taskId: 'task-blocker',
      taskName: 'CI smoke verification',
    });
    const agent = makeAgent({
      agentId: 'agent-1',
      taskId: 'task-1',
      taskName: 'Deploy production restart fix',
      blocked_by: ['task:task-blocker'],
    });
    useKookrStore.setState({ agents: [agent, blocker] });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, task: { blocks: [], blocked_by: [] } }),
    } as Response);

    act(() => {
      root.render(React.createElement(TaskDependencyEditor, { agent }));
    });

    const trigger = container.querySelector('.dependency-menu-trigger') as HTMLButtonElement;
    act(() => {
      trigger.click();
    });

    const removeButton = container.querySelector(
      'button[aria-label="Remove CI smoke verification (task-blo)"]',
    ) as HTMLButtonElement;
    await act(async () => {
      removeButton.click();
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/tasks/task-1/edges', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blocked_by: [] }),
    });
  });
});
