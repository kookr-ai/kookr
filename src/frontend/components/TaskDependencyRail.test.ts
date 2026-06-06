// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { AgentState, TaskRelation } from '../../shared/protocol.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import { TaskDependencyRail } from './TaskDependencyRail.js';

function syncGlobalStore(): void {
  const freshState = createKookrStore().getState();
  const nextData = Object.fromEntries(
    Object.entries(freshState).filter(([, value]) => typeof value !== 'function'),
  );
  useKookrStore.setState(nextData);
}

function makeAgent(partial: Partial<AgentState> & { agentId: string }): AgentState {
  return { agentId: partial.agentId, events: [], anomaly: null, ...partial } as AgentState;
}

function rel(input: Partial<TaskRelation> & { sourceTaskId: string; targetTaskId: string; type: TaskRelation['type'] }): TaskRelation {
  return {
    id: input.id ?? `rel-${input.sourceTaskId}-${input.targetTaskId}-${input.type}`,
    sourceTaskId: input.sourceTaskId,
    targetTaskId: input.targetTaskId,
    type: input.type,
    confidence: input.confidence ?? 1,
    source: input.source ?? 'api',
    evidence: input.evidence ?? [],
    createdAt: '2026-06-06T00:00:00.000Z',
    updatedAt: '2026-06-06T00:00:00.000Z',
    lifecycle: input.lifecycle ?? 'active',
  };
}

describe('TaskDependencyRail', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    syncGlobalStore();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  test('renders nothing when the task has no dependency edges', () => {
    const agent = makeAgent({ agentId: 'a-me', taskId: 'me', taskName: 'This task' });
    useKookrStore.setState({ agents: [agent], taskRelations: [] });
    act(() => root.render(React.createElement(TaskDependencyRail, { agent })));
    expect(container.querySelector('[data-testid="task-dependency-rail"]')).toBeNull();
  });

  test('renders upstream and downstream nodes around the current task', () => {
    const agent = makeAgent({ agentId: 'a-me', taskId: 'me', taskName: 'This task' });
    useKookrStore.setState({
      agents: [
        agent,
        makeAgent({ agentId: 'a-blk', taskId: 'blocker', taskName: 'Blocker task', taskStatus: 'completed' }),
        makeAgent({ agentId: 'a-dep', taskId: 'dependent', taskName: 'Dependent task', taskStatus: 'inProgress' }),
      ],
      taskRelations: [
        rel({ sourceTaskId: 'me', targetTaskId: 'blocker', type: 'depends_on' }),
        rel({ sourceTaskId: 'me', targetTaskId: 'dependent', type: 'blocks' }),
      ],
    });
    act(() => root.render(React.createElement(TaskDependencyRail, { agent })));

    expect(container.querySelector('[data-testid="task-dependency-rail"]')).not.toBeNull();
    const nodes = Array.from(container.querySelectorAll('[data-testid="dep-rail-node"]'));
    expect(nodes.map((n) => n.getAttribute('data-task-id')).sort()).toEqual(['blocker', 'dependent']);
    expect(container.textContent).toContain('This task');
  });

  test('clicking a node selects the corresponding agent', () => {
    const agent = makeAgent({ agentId: 'a-me', taskId: 'me', taskName: 'This task' });
    useKookrStore.setState({
      selectedAgentId: 'a-me',
      agents: [
        agent,
        makeAgent({ agentId: 'a-blk', taskId: 'blocker', taskName: 'Blocker task' }),
      ],
      taskRelations: [rel({ sourceTaskId: 'me', targetTaskId: 'blocker', type: 'depends_on' })],
    });
    act(() => root.render(React.createElement(TaskDependencyRail, { agent })));

    const node = container.querySelector<HTMLButtonElement>('[data-task-id="blocker"]')!;
    act(() => node.click());
    expect(useKookrStore.getState().selectedAgentId).toBe('a-blk');
  });
});
