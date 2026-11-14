// @vitest-environment happy-dom

/**
 * One list (#3561 slice 3): findings and every other state section share a
 * single scroll container, so the rail shows the full task list in every
 * state instead of reserving space for findings that are absent.
 */
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { FindingsPanel } from './FindingsPanel.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import type { AgentState } from '../../shared/protocol.js';

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

function makeFinding(id: string): AgentState {
  return makeAgent({
    agentId: `finding-${id}`,
    taskId: `finding-task-${id}`,
    taskName: `Finding ${id}`,
    anomaly: {
      type: 'permission_blocked',
      severity: 'warning',
      explanation: 'Wants to run a command',
      detectedAt: '2026-11-11T00:00:00.000Z',
    } as unknown as AgentState['anomaly'],
  });
}

function makeWorking(count: number): AgentState[] {
  return Array.from({ length: count }, (_, i) => makeAgent({
    agentId: `working-${i}`,
    taskId: `working-task-${i}`,
    taskName: `Working ${i}`,
  }));
}

function render(root: Root, lists: { findings?: AgentState[]; healthy?: AgentState[]; completed?: AgentState[] }) {
  act(() => {
    root.render(React.createElement(FindingsPanel, {
      findings: lists.findings ?? [],
      healthy: lists.healthy ?? [],
      pending: [],
      snoozed: [],
      completed: lists.completed ?? [],
      selectedAgentId: null,
      selectedTaskId: null,
      send: vi.fn(),
      clearCompletedFinishedCount: 0,
      clearCompletedTerminatedCount: 0,
    }));
  });
}

describe('FindingsPanel one list (#3561 slice 3)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    syncGlobalStore();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  test('working and finished sections live in the same scroll container as the findings', () => {
    render(root, {
      findings: [makeFinding('a')],
      healthy: makeWorking(3),
      completed: [makeAgent({ agentId: 'done-1', taskId: 'done-task-1', taskStatus: 'completed' })],
    });
    const scrollAreas = container.querySelectorAll('.findings-scroll-area');
    expect(scrollAreas).toHaveLength(1);
    const area = scrollAreas[0];
    expect(area.querySelector(':scope > .finding-card')).not.toBeNull();
    expect(area.querySelector(':scope > .healthy-section')).not.toBeNull();
    expect(area.querySelector(':scope > .completed-section')).not.toBeNull();
    // The separate fixed-height box and its drag handle are gone.
    expect(container.querySelector('.bottom-sections')).toBeNull();
    expect(container.querySelector('[data-testid="bottom-sections-resizer"]')).toBeNull();
  });

  test('sections appear in state order: needs you, working, finished', () => {
    render(root, {
      findings: [makeFinding('a')],
      healthy: makeWorking(1),
      completed: [makeAgent({ agentId: 'done-1', taskId: 'done-task-1', taskStatus: 'completed' })],
    });
    const area = container.querySelector('.findings-scroll-area')!;
    const order = Array.from(area.children)
      .map((child) => (child as HTMLElement).dataset.testid === 'findings-needs-you-header'
        ? 'needs-you'
        : child.classList.contains('finding-card') ? 'finding'
          : child.classList.contains('healthy-section') ? 'working'
            : child.classList.contains('completed-section') ? 'finished'
              : null)
      .filter(Boolean);
    expect(order).toEqual(['needs-you', 'finding', 'working', 'finished']);
  });

  test('section labels name the state: Working and Finished', () => {
    render(root, {
      healthy: makeWorking(2),
      completed: [makeAgent({ agentId: 'done-1', taskId: 'done-task-1', taskStatus: 'completed' })],
    });
    expect(container.querySelector('.healthy-label')?.textContent).toBe('Working (2)');
    expect(container.querySelector('.completed-label')?.textContent).toBe('Finished (1)');
  });

  test('with nothing waiting, "Needs you" takes one line and says so', () => {
    render(root, { healthy: makeWorking(8) });
    const header = container.querySelector('[data-testid="findings-needs-you-header"]');
    expect(header?.textContent).toBe('Needs you (0)nothing waiting');
    expect(header?.classList.contains('findings-needs-you-empty')).toBe(true);
    // All eight working rows are rendered in the list; none is held back.
    expect(container.querySelectorAll('.findings-scroll-area .healthy-row')).toHaveLength(8);
  });

  test('with findings, "Needs you" counts them and drops the empty hint', () => {
    render(root, { findings: [makeFinding('a'), makeFinding('b')], healthy: makeWorking(1) });
    const header = container.querySelector('[data-testid="findings-needs-you-header"]');
    expect(header?.textContent).toBe('Needs you (2)');
    expect(header?.classList.contains('findings-needs-you-empty')).toBe(false);
  });

  test('a cold, empty rail shows the launch prompt without a "Needs you" line', () => {
    render(root, {});
    expect(container.querySelector('[data-testid="findings-needs-you-header"]')).toBeNull();
    expect(container.querySelector('.findings-empty')).not.toBeNull();
  });

  test('the rail header is titled "Tasks"', () => {
    render(root, { healthy: makeWorking(1) });
    expect(container.querySelector('.findings-header-title')?.textContent).toBe('Tasks');
  });

  describe('scroll to top on a new finding', () => {
    function layout(area: HTMLElement, scrollTop: number, firstSectionTop: number) {
      // jsdom has no layout: place the scroll area at y=0 and the first state
      // section `firstSectionTop` px into the list, then scroll to `scrollTop`.
      area.getBoundingClientRect = () => ({ top: 0 } as DOMRect);
      const section = area.querySelector<HTMLElement>('.healthy-section')!;
      section.getBoundingClientRect = () => ({ top: firstSectionTop - scrollTop } as DOMRect);
      area.scrollTop = scrollTop;
      area.scrollTo = vi.fn() as unknown as HTMLElement['scrollTo'];
      return area.scrollTo as unknown as ReturnType<typeof vi.fn>;
    }

    function arriveNewFinding(findings: AgentState[]) {
      // The first click on the panel ends the initial-load grace period.
      act(() => {
        container.querySelector<HTMLElement>('.findings-panel')!
          .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      render(root, { findings, healthy: makeWorking(10) });
      act(() => { vi.advanceTimersByTime(200); });
    }

    test('jumps to the top while the reader is in the findings part', () => {
      vi.useFakeTimers();
      render(root, { findings: [makeFinding('a')], healthy: makeWorking(10) });
      const scrollTo = layout(container.querySelector<HTMLElement>('.findings-scroll-area')!, 40, 300);
      arriveNewFinding([makeFinding('a'), makeFinding('b')]);
      expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 0 }));
    });

    test('keeps the place of someone reading working rows further down', () => {
      vi.useFakeTimers();
      render(root, { findings: [makeFinding('a')], healthy: makeWorking(10) });
      const scrollTo = layout(container.querySelector<HTMLElement>('.findings-scroll-area')!, 500, 300);
      arriveNewFinding([makeFinding('a'), makeFinding('b')]);
      expect(scrollTo).not.toHaveBeenCalled();
    });
  });
});
