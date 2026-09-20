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

function renderRow(
  container: HTMLElement,
  agent: AgentState,
  opts: {
    send?: ReturnType<typeof vi.fn>;
    pendingDeletion?: boolean;
    live?: boolean;
  } = {},
): { root: Root; send: ReturnType<typeof vi.fn> } {
  const send = opts.send ?? vi.fn();
  useKookrStore.setState({ agents: opts.live === false ? [] : [agent] });
  const root = createRoot(container);
  act(() => {
    root.render(
      <CompletedRow
        agent={agent}
        selected={false}
        send={send}
        pendingDeletion={opts.pendingDeletion === true}
      />,
    );
  });
  return { root, send };
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
    root = renderRow(container, makeAgent({ completionFeedback: feedback })).root;
    const pill = container.querySelector('[data-testid="completed-row-rating"]');
    expect(pill).not.toBeNull();
    expect(pill?.textContent).toBe('👍');
    expect(pill?.className).toContain('completed-row-rating--up');
    expect(pill?.getAttribute('title')).toContain('Rated good');
    // Live completed rows can reopen the rating control (issue #3330).
    expect(pill?.tagName).toBe('BUTTON');
  });

  test('skip-then-rate: an unrated completed row sends setTaskFeedback without relaunching complete', () => {
    const { root: rendered, send } = renderRow(container, makeAgent());
    root = rendered;
    expect(container.querySelector('[data-testid="completed-row-rating"]')).toBeNull();
    const up = container.querySelector<HTMLButtonElement>('[aria-label="Thumbs up"]');
    expect(up).not.toBeNull();
    expect(container.querySelector('.confirm-dialog')).toBeNull();
    act(() => {
      up!.click();
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      type: 'setTaskFeedback',
      taskId: 'task-1',
      feedback: { rating: 'up' },
    });
  });

  test('already-rated edit: the pill re-opens thumbs so the operator can change the rating', () => {
    const { root: rendered, send } = renderRow(
      container,
      makeAgent({ completionFeedback: { rating: 'up' } }),
    );
    root = rendered;
    const pill = container.querySelector<HTMLButtonElement>('[data-testid="completed-row-rating"]');
    expect(pill).not.toBeNull();
    expect(useKookrStore.getState().selectedAgentId).toBeNull();
    act(() => {
      pill!.click();
    });
    // Opening the editor is a rating action, not row selection.
    expect(useKookrStore.getState().selectedAgentId).toBeNull();
    const down = container.querySelector<HTMLButtonElement>('[aria-label="Thumbs down"]');
    expect(down).not.toBeNull();
    act(() => {
      down!.click();
    });
    expect(send).toHaveBeenCalledWith({
      type: 'setTaskFeedback',
      taskId: 'task-1',
      feedback: { rating: 'down' },
    });
  });

  test('thumbs-down offers the same my_prompt reason as the complete dialog', () => {
    const { root: rendered, send } = renderRow(container, makeAgent());
    root = rendered;
    act(() => {
      container.querySelector<HTMLButtonElement>('[aria-label="Thumbs down"]')!.click();
    });
    expect(send).toHaveBeenCalledWith({
      type: 'setTaskFeedback',
      taskId: 'task-1',
      feedback: { rating: 'down' },
    });
    const checkbox = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
      .find((input) => input.closest('label')?.textContent?.includes('My prompt was unclear'));
    expect(checkbox).toBeDefined();
    act(() => {
      checkbox!.click();
    });
    expect(send).toHaveBeenLastCalledWith({
      type: 'setTaskFeedback',
      taskId: 'task-1',
      feedback: { rating: 'down', downReason: 'my_prompt' },
    });
  });

  test('shows a 👎 pill with the note and down-reason in the tooltip', () => {
    const feedback: TaskCompletionFeedback = {
      rating: 'down',
      note: 'Missed the <edge> case',
      downReason: 'agent_behavior',
    };
    root = renderRow(container, makeAgent({ completionFeedback: feedback })).root;
    const pill = container.querySelector('[data-testid="completed-row-rating"]');
    expect(pill).not.toBeNull();
    expect(pill?.textContent).toBe('👎');
    expect(pill?.className).toContain('completed-row-rating--down');
    // The note rides in the title attribute (a tooltip text sink) verbatim...
    expect(pill?.getAttribute('title')).toContain('Rated bad: Missed the <edge> case — Agent behavior');
    // ...as inert data, never parsed as markup: the angle brackets spawn no
    // phantom element and the pill's only content is the emoji. This guards
    // against a future switch to dangerouslySetInnerHTML.
    expect(pill?.querySelector('edge')).toBeNull();
    expect(pill?.childElementCount).toBe(0);
    expect(pill?.textContent).toBe('👎');
  });

  test('maps the my_prompt down-reason to a readable tooltip label', () => {
    const feedback: TaskCompletionFeedback = { rating: 'down', downReason: 'my_prompt' };
    root = renderRow(container, makeAgent({ completionFeedback: feedback })).root;
    const pill = container.querySelector('[data-testid="completed-row-rating"]');
    expect(pill?.textContent).toBe('👎');
    // No free-text note, so only the mapped down-reason label rides in the tooltip.
    expect(pill?.getAttribute('title')).toContain('Rated bad: My prompt was unclear');
  });

  test('cancelled rows stay display-only and do not grow a late-rate control', () => {
    const { root: rendered, send } = renderRow(
      container,
      makeAgent({ taskStatus: 'cancelled' }),
    );
    root = rendered;
    expect(container.querySelector('[aria-label="Thumbs up"]')).toBeNull();
    expect(container.querySelector('[data-testid="completed-row-rate-editor"]')).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  test('a cancelled row that already has feedback keeps a display-only pill', () => {
    const { root: rendered, send } = renderRow(
      container,
      makeAgent({ taskStatus: 'cancelled', completionFeedback: { rating: 'up' } }),
    );
    root = rendered;
    const pill = container.querySelector('[data-testid="completed-row-rating"]');
    expect(pill?.tagName).toBe('SPAN');
    act(() => {
      (pill as HTMLElement).click();
    });
    expect(container.querySelector('[aria-label="Thumbs down"]')).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  test('terminated rows do not offer late rating', () => {
    root = renderRow(container, makeAgent({ taskStatus: 'terminated' })).root;
    expect(container.querySelector('[aria-label="Thumbs up"]')).toBeNull();
    expect(container.querySelector('[data-testid="completed-row-rate-editor"]')).toBeNull();
  });

  test('archive-only completed rows cannot send a late rating', () => {
    const { root: rendered, send } = renderRow(container, makeAgent(), { live: false });
    root = rendered;
    expect(container.querySelector('[aria-label="Thumbs up"]')).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });
});
