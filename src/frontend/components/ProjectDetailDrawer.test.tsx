// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { ProjectSummary } from '../../shared/protocol.js';
import { ProjectDetailDrawer } from './ProjectDetailDrawer.js';

function baseProject(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    project: 'github.com/octo/cat',
    displayName: 'octo/cat',
    color: 0,
    activeAgents: 1,
    findingCount: 0,
    todayPrCount: 0,
    weekPrCount: 0,
    openContributionAttempts: 0,
    recentTasks: [],
    tracked: false,
    ...overrides,
  };
}

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function renderDrawer(project: ProjectSummary) {
  act(() => {
    root.render(
      React.createElement(ProjectDetailDrawer, {
        project,
        onClose: () => {},
        send: () => true,
      }),
    );
  });
}

describe('ProjectDetailDrawer — last shipped recency', () => {
  test('renders a relative "Last shipped" hint when lastContribution is present', () => {
    const iso = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    renderDrawer(baseProject({ lastContribution: iso }));

    expect(container.textContent).toContain('Last shipped');
    const value = container.querySelector('[data-testid="last-shipped-value"]');
    expect(value).not.toBeNull();
    expect(value?.textContent).toBe('3d ago');
  });

  test('exposes the absolute date on hover', () => {
    const iso = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    renderDrawer(baseProject({ lastContribution: iso }));

    const value = container.querySelector('[data-testid="last-shipped-value"]');
    expect(value?.getAttribute('title')).toBe(new Date(iso).toLocaleString());
  });

  test('omits the hint entirely when lastContribution is undefined', () => {
    renderDrawer(baseProject({ lastContribution: undefined }));

    expect(container.querySelector('[data-testid="last-shipped-value"]')).toBeNull();
    expect(container.textContent).not.toContain('Last shipped');
  });

  test('omits the hint (rather than leaking "Invalid Date") for an unparseable value', () => {
    // relativeAgo returns '' for a date it cannot parse, so the guard must drop
    // the whole row instead of rendering an empty relative time with an
    // "Invalid Date" tooltip.
    renderDrawer(baseProject({ lastContribution: 'not-a-date' }));

    expect(container.querySelector('[data-testid="last-shipped-value"]')).toBeNull();
    expect(container.textContent).not.toContain('Last shipped');
    expect(container.textContent).not.toContain('Invalid Date');
  });
});

describe('ProjectDetailDrawer — stalled agents', () => {
  test('shows the stalled count when stalledAgents > 0', () => {
    renderDrawer(baseProject({ activeAgents: 5, stalledAgents: 2 }));

    expect(container.textContent).toContain('Stalled agents');
    const value = container.querySelector('[data-testid="stalled-agents-value"]');
    expect(value).not.toBeNull();
    expect(value?.textContent).toBe('2');
  });

  test('omits the stalled row when stalledAgents is 0', () => {
    renderDrawer(baseProject({ activeAgents: 5, stalledAgents: 0 }));

    expect(container.querySelector('[data-testid="stalled-agents-value"]')).toBeNull();
    expect(container.textContent).not.toContain('Stalled agents');
  });

  test('omits the stalled row when stalledAgents is undefined', () => {
    renderDrawer(baseProject({ activeAgents: 5, stalledAgents: undefined }));

    expect(container.querySelector('[data-testid="stalled-agents-value"]')).toBeNull();
    expect(container.textContent).not.toContain('Stalled agents');
  });
});

describe('ProjectDetailDrawer — selectable recent tasks', () => {
  function renderWithSelection(
    project: ProjectSummary,
    opts: { onSelectTask?: (taskId: string) => void; selectableTaskIds?: ReadonlySet<string> } = {},
  ) {
    act(() => {
      root.render(
        React.createElement(ProjectDetailDrawer, {
          project,
          onClose: () => {},
          send: () => true,
          onSelectTask: opts.onSelectTask,
          selectableTaskIds: opts.selectableTaskIds,
        }),
      );
    });
  }

  const liveTask = { taskId: 'task-live', name: 'Live task', status: 'inProgress' };
  const historicalTask = { taskId: 'task-gone', name: 'Old task', status: 'completed' };

  test('renders a live recent task as an accessible button and selects it on click', () => {
    const selected: string[] = [];
    renderWithSelection(
      baseProject({ recentTasks: [liveTask] }),
      { onSelectTask: (id) => selected.push(id), selectableTaskIds: new Set(['task-live']) },
    );

    const button = container.querySelector('button[data-testid="project-drawer-task-select"]');
    expect(button).not.toBeNull();
    expect(button?.tagName).toBe('BUTTON');
    // Accessible name conveys the task and its (humanized) status.
    expect(button?.getAttribute('aria-label')).toBe('Open task Live task (running)');

    act(() => {
      (button as HTMLButtonElement).click();
    });
    expect(selected).toEqual(['task-live']);
  });

  test('leaves a historical-only task non-selectable, and clicking it never selects', () => {
    const selected: string[] = [];
    renderWithSelection(
      baseProject({ recentTasks: [historicalTask] }),
      { onSelectTask: (id) => selected.push(id), selectableTaskIds: new Set(['task-live']) },
    );

    // No selectable button rendered for a task absent from the live projection.
    expect(container.querySelector('button[data-testid="project-drawer-task-select"]')).toBeNull();
    const row = container.querySelector('.project-drawer-task');
    expect(row).not.toBeNull();
    expect(row?.tagName).toBe('DIV');
    expect(container.textContent).toContain('Old task');

    // The whole point of the feature: a stale/historical row can never open a
    // task. Clicking the div must not fire the callback.
    act(() => {
      (row as HTMLElement).click();
    });
    expect(selected).toEqual([]);
  });

  test('renders both a selectable live row and a non-selectable historical row', () => {
    renderWithSelection(
      baseProject({ recentTasks: [liveTask, historicalTask] }),
      { onSelectTask: () => {}, selectableTaskIds: new Set(['task-live']) },
    );

    const buttons = container.querySelectorAll('button[data-testid="project-drawer-task-select"]');
    expect(buttons.length).toBe(1);
    expect(buttons[0]?.getAttribute('aria-label')).toBe('Open task Live task (running)');
    // Two rows total, one interactive and one plain.
    expect(container.querySelectorAll('.project-drawer-task').length).toBe(2);
  });

  test('with several live rows, each button selects its own task id', () => {
    const selected: string[] = [];
    const second = { taskId: 'task-live-2', name: 'Second live', status: 'inProgress' };
    renderWithSelection(
      baseProject({ recentTasks: [liveTask, second] }),
      { onSelectTask: (id) => selected.push(id), selectableTaskIds: new Set(['task-live', 'task-live-2']) },
    );

    const buttons = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button[data-testid="project-drawer-task-select"]'),
    );
    expect(buttons.length).toBe(2);
    act(() => buttons[1].click());
    act(() => buttons[0].click());
    // Each row targets its own id, in click order — no shared-closure bleed.
    expect(selected).toEqual(['task-live-2', 'task-live']);
  });

  test('falls back to the truncated taskId in the button label when the task has no name', () => {
    renderWithSelection(
      baseProject({ recentTasks: [{ taskId: 'abcdef1234567890', status: 'inProgress' }] }),
      { onSelectTask: () => {}, selectableTaskIds: new Set(['abcdef1234567890']) },
    );

    const button = container.querySelector('button[data-testid="project-drawer-task-select"]');
    expect(button?.getAttribute('aria-label')).toBe('Open task abcdef12 (running)');
  });

  test('does not make a task selectable when selectableTaskIds is undefined', () => {
    renderWithSelection(
      baseProject({ recentTasks: [liveTask] }),
      { onSelectTask: () => {} },
    );

    expect(container.querySelector('button[data-testid="project-drawer-task-select"]')).toBeNull();
    expect(container.querySelector('.project-drawer-task')?.tagName).toBe('DIV');
  });

  test('renders all rows as plain divs when no selection callback is supplied', () => {
    renderWithSelection(baseProject({ recentTasks: [liveTask, historicalTask] }));

    expect(container.querySelector('button[data-testid="project-drawer-task-select"]')).toBeNull();
    const rows = container.querySelectorAll('.project-drawer-task');
    expect(rows.length).toBe(2);
    rows.forEach((row) => expect(row.tagName).toBe('DIV'));
  });

  test('does not make a live task selectable when the callback is absent', () => {
    renderWithSelection(
      baseProject({ recentTasks: [liveTask] }),
      { selectableTaskIds: new Set(['task-live']) },
    );

    expect(container.querySelector('button[data-testid="project-drawer-task-select"]')).toBeNull();
    expect(container.querySelector('.project-drawer-task')?.tagName).toBe('DIV');
  });
});

describe('ProjectDetailDrawer — project automation toggle', () => {
  test('saves immediately when the operator turns automation off', () => {
    const sent: unknown[] = [];
    act(() => {
      root.render(
        React.createElement(ProjectDetailDrawer, {
          project: baseProject({ automationEnabled: true }),
          onClose: () => {},
          send: (msg) => {
            sent.push(msg);
            return true;
          },
        }),
      );
    });
    const toggle = container.querySelector('[data-testid="project-automation-toggle"]');
    expect(toggle).not.toBeNull();
    act(() => {
      toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(sent).toEqual([{
      type: 'setProjectConfig',
      project: 'github.com/octo/cat',
      config: { project: 'github.com/octo/cat', automationEnabled: false },
    }]);
  });

  test('shows paused since when automation is off', () => {
    renderDrawer(baseProject({
      automationEnabled: false,
      automationPausedSince: '2026-09-03T00:00:00.000Z',
    }));
    expect(container.textContent).toContain('Paused since 2026-09-03T00:00:00.000Z');
  });
});
