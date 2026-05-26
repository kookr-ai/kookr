// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { AgentState, TaskRelation } from '../../shared/protocol.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import { ChildRollupPill, RelatedTasksSection } from './RelatedTasksSection.js';

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

function rel(input: Partial<TaskRelation> & { sourceTaskId: string; targetTaskId: string }): TaskRelation {
  return {
    id: input.id ?? `rel-${input.sourceTaskId}-${input.targetTaskId}-${input.type ?? 'spawned_by'}`,
    sourceTaskId: input.sourceTaskId,
    targetTaskId: input.targetTaskId,
    type: input.type ?? 'spawned_by',
    confidence: input.confidence ?? 1,
    source: input.source ?? 'api',
    evidence: input.evidence ?? [],
    createdAt: '2026-05-26T00:00:00.000Z',
    updatedAt: '2026-05-26T00:00:00.000Z',
    lifecycle: input.lifecycle ?? 'active',
  };
}

describe('RelatedTasksSection (#601)', () => {
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
  });

  test('renders children and parent groups with an inferred badge for low-confidence edges', () => {
    const agent = makeAgent({ agentId: 'parent-agent', taskId: 'p1', taskName: 'Parent task' });
    useKookrStore.setState({
      agents: [
        agent,
        makeAgent({ agentId: 'child-agent', taskId: 'c1', taskName: 'Child task' }),
        makeAgent({ agentId: 'gp-agent', taskId: 'gp', taskName: 'Grandparent' }),
      ],
      taskRelations: [
        rel({ sourceTaskId: 'c1', targetTaskId: 'p1', type: 'spawned_by', source: 'api', confidence: 1 }),
        rel({ sourceTaskId: 'p1', targetTaskId: 'gp', type: 'spawned_by', source: 'llm-inference', confidence: 0.4 }),
      ],
    });

    act(() => {
      root.render(React.createElement(RelatedTasksSection, { agent }));
    });

    const section = container.querySelector('[data-testid="related-tasks-section"]');
    expect(section).not.toBeNull();

    const children = container.querySelector('[data-testid="related-tasks-group-children"]');
    expect(children?.textContent).toContain('Child task');

    const parent = container.querySelector('[data-testid="related-tasks-group-parent"]');
    expect(parent?.textContent).toContain('Grandparent');

    const inferred = parent?.querySelector('[data-testid="related-task-badge-inferred"]');
    expect(inferred?.textContent).toContain('inferred');

    const inferredEntry = parent?.querySelector('[data-inferred="true"]');
    expect(inferredEntry).not.toBeNull();
    expect(inferredEntry?.classList.contains('related-task-entry--inferred')).toBe(true);
  });

  test('hides completed descendants when the filter checkbox is toggled on', () => {
    const focus = makeAgent({ agentId: 'parent-agent', taskId: 'p1', taskName: 'Parent task' });
    useKookrStore.setState({
      agents: [
        focus,
        makeAgent({ agentId: 'a-running', taskId: 'running-child', taskName: 'Running child', taskStatus: 'inProgress' }),
        makeAgent({ agentId: 'a-done', taskId: 'done-child', taskName: 'Done child', taskStatus: 'completed' }),
      ],
      taskRelations: [
        rel({ sourceTaskId: 'running-child', targetTaskId: 'p1' }),
        rel({ sourceTaskId: 'done-child', targetTaskId: 'p1', id: 'rel-done' }),
      ],
    });

    act(() => {
      root.render(React.createElement(RelatedTasksSection, { agent: focus }));
    });

    const childrenBefore = container.querySelector('[data-testid="related-tasks-group-children"]');
    expect(childrenBefore?.textContent).toContain('Running child');
    expect(childrenBefore?.textContent).toContain('Done child');

    const checkbox = container.querySelector(
      '[data-testid="related-tasks-hide-completed"]',
    ) as HTMLInputElement;
    act(() => {
      checkbox.click();
    });

    const childrenAfter = container.querySelector('[data-testid="related-tasks-group-children"]');
    expect(childrenAfter?.textContent).toContain('Running child');
    expect(childrenAfter?.textContent ?? '').not.toContain('Done child');
  });

  test('expands the evidence panel when the toggle is clicked', () => {
    const focus = makeAgent({ agentId: 'parent-agent', taskId: 'p1', taskName: 'Parent task' });
    useKookrStore.setState({
      agents: [
        focus,
        makeAgent({ agentId: 'child-agent', taskId: 'c1', taskName: 'Child task' }),
      ],
      taskRelations: [
        rel({
          sourceTaskId: 'c1',
          targetTaskId: 'p1',
          evidence: [
            { snippet: 'KOOKR_PARENT_TASK_ID matched p1', observedAt: '2026-05-26T11:00:00.000Z' },
          ],
        }),
      ],
    });

    act(() => {
      root.render(React.createElement(RelatedTasksSection, { agent: focus }));
    });

    expect(container.querySelector('[data-testid="related-task-evidence"]')).toBeNull();

    const toggle = container.querySelector(
      '[data-testid="related-task-evidence-toggle"]',
    ) as HTMLButtonElement;
    act(() => {
      toggle.click();
    });

    const evidence = container.querySelector('[data-testid="related-task-evidence"]');
    expect(evidence?.textContent).toContain('KOOKR_PARENT_TASK_ID matched p1');
  });

  test('renders nothing when the focused agent has no relations', () => {
    const focus = makeAgent({ agentId: 'a1', taskId: 'lonely-task', taskName: 'Lonely' });
    useKookrStore.setState({
      agents: [focus],
      taskRelations: [],
    });
    act(() => {
      root.render(React.createElement(RelatedTasksSection, { agent: focus }));
    });
    expect(container.querySelector('[data-testid="related-tasks-section"]')).toBeNull();
  });
});

describe('ChildRollupPill (#601)', () => {
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
  });

  test('shows count + breakdown and tags severity when a child finding is present', () => {
    const agent = makeAgent({
      agentId: 'parent',
      taskId: 'p1',
      childRollup: {
        childCount: 3,
        running: 1,
        completed: 1,
        blocked: 1,
        mostUrgentChildFinding: {
          childTaskId: 'c1',
          severity: 'critical',
          anomalyType: 'permission_blocked',
          explanation: 'awaiting allow',
        },
      },
    });

    act(() => {
      root.render(React.createElement(ChildRollupPill, { agent }));
    });

    const pill = container.querySelector('[data-testid="child-rollup-pill"]');
    expect(pill).not.toBeNull();
    expect(pill?.textContent).toContain('3c');
    expect(pill?.textContent).toContain('1/1/1');
    expect(pill?.classList.contains('child-rollup-pill--critical')).toBe(true);
  });

  test('renders nothing when there is no rollup', () => {
    const agent = makeAgent({ agentId: 'p', taskId: 'p1' });
    act(() => {
      root.render(React.createElement(ChildRollupPill, { agent }));
    });
    expect(container.querySelector('[data-testid="child-rollup-pill"]')).toBeNull();
  });
});
