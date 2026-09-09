// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { CompletedRow } from './CompletedRow.js';
import { createKookrStore, useKookrStore } from '../../store/useStore.js';
import type { AgentState } from '../../../shared/protocol.js';
import type { TaskCompletionFeedback } from '../../../shared/contracts/task.js';

function syncGlobalStore() {
  const freshState = createKookrStore().getState();
  const nextData = Object.fromEntries(
    Object.entries(freshState).filter(([, value]) => typeof value !== 'function'),
  );
  useKookrStore.setState(nextData);
}

function makeAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    agentId: 'agent-1',
    taskId: 'task-1',
    taskName: 'Completed task',
    description: 'Done',
    events: [],
    taskStatus: 'completed',
    cwd: '/tmp/project',
    finishedAt: '2026-08-17T10:00:00.000Z',
    ...overrides,
  } as AgentState;
}

function renderRow(container: HTMLElement, agent: AgentState): Root {
  const root = createRoot(container);
  act(() => {
    root.render(
      <CompletedRow
        agent={agent}
        selected={false}
        send={vi.fn()}
        pendingDeletion={false}
      />,
    );
  });
  return root;
}

describe('CompletedRow completion-rating pill', () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    syncGlobalStore();
    // Row selection funnels through track() telemetry, which buffers and may
    // flush over fetch — stub it so a click-through test stays hermetic.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({}), text: async () => '{}' })),
    );
    container = document.createElement('div');
    document.body.appendChild(container);
    root = null;
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  test('shows a 👍 pill for an up rating', () => {
    const feedback: TaskCompletionFeedback = { rating: 'up' };
    root = renderRow(container, makeAgent({ completionFeedback: feedback }));
    const pill = container.querySelector('[data-testid="completed-row-rating"]');
    expect(pill).not.toBeNull();
    expect(pill?.textContent).toBe('👍');
    expect(pill?.className).toContain('completed-row-rating--up');
    expect(pill?.getAttribute('title')).toBe('Rated good');
    expect(pill?.tagName).toBe('SPAN');
  });

  test('clicking the pill falls through to row selection, not a rating flow', () => {
    root = renderRow(container, makeAgent({ completionFeedback: { rating: 'up' } }));
    const pill = container.querySelector<HTMLElement>('[data-testid="completed-row-rating"]');
    expect(pill).not.toBeNull();
    expect(useKookrStore.getState().selectedAgentId).toBeNull();
    act(() => {
      pill!.click();
    });
    // Display-only: the pill has no handler of its own, so the click bubbles to
    // the row and selects it — it never opens a rating editor. The completion
    // dialog / rating capture lives elsewhere and leaves no trace here.
    expect(useKookrStore.getState().selectedAgentId).toBe('agent-1');
    expect(useKookrStore.getState().selectedTaskId).toBe('task-1');
    expect(container.querySelector('.complete-feedback-note')).toBeNull();
  });

  test('shows a 👎 pill with the note and down-reason in the tooltip', () => {
    const feedback: TaskCompletionFeedback = {
      rating: 'down',
      note: 'Missed the <edge> case',
      downReason: 'agent_behavior',
    };
    root = renderRow(container, makeAgent({ completionFeedback: feedback }));
    const pill = container.querySelector('[data-testid="completed-row-rating"]');
    expect(pill).not.toBeNull();
    expect(pill?.textContent).toBe('👎');
    expect(pill?.className).toContain('completed-row-rating--down');
    // The note rides in the title attribute (a tooltip text sink) verbatim...
    expect(pill?.getAttribute('title')).toBe('Rated bad: Missed the <edge> case — Agent behavior');
    // ...as inert data, never parsed as markup: the angle brackets spawn no
    // phantom element and the pill's only content is the emoji. This guards
    // against a future switch to dangerouslySetInnerHTML.
    expect(pill?.querySelector('edge')).toBeNull();
    expect(pill?.childElementCount).toBe(0);
    expect(pill?.textContent).toBe('👎');
  });

  test('maps the my_prompt down-reason to a readable tooltip label', () => {
    const feedback: TaskCompletionFeedback = { rating: 'down', downReason: 'my_prompt' };
    root = renderRow(container, makeAgent({ completionFeedback: feedback }));
    const pill = container.querySelector('[data-testid="completed-row-rating"]');
    expect(pill?.textContent).toBe('👎');
    // No free-text note, so only the mapped down-reason label rides in the tooltip.
    expect(pill?.getAttribute('title')).toBe('Rated bad: My prompt was unclear');
  });

  test('renders nothing new when there is no rating', () => {
    root = renderRow(container, makeAgent());
    expect(container.querySelector('[data-testid="completed-row-rating"]')).toBeNull();
    // The row itself still renders.
    expect(container.querySelector('.completed-row')).not.toBeNull();
  });
});
