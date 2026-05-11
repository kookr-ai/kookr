// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ProjectSummary } from '../../shared/protocol.js';
import { ProjectDetailDrawer } from './ProjectDetailDrawer.js';

function makeProject(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    project: 'kookr-ai/kookr',
    displayName: 'kookr-ai/kookr',
    color: 0,
    todayPrCount: 0,
    weekPrCount: 2,
    openPrs: 3,
    activeAgents: 5,
    findingCount: 1,
    dailyLimit: 100,
    notes: 'ship carefully',
    recentTasks: [
      { taskId: 'task-1', name: 'Investigate dashboard density', status: 'inProgress' },
    ],
    ...overrides,
  };
}

function renderDrawer(container: HTMLElement, project: ProjectSummary): Root {
  const root = createRoot(container);
  act(() => {
    root.render(React.createElement(ProjectDetailDrawer, {
      project,
      onClose: vi.fn(),
      send: vi.fn(),
      onRunPlaybook: vi.fn(),
      onOpenWorkspace: vi.fn(),
    }));
  });
  return root;
}

describe('ProjectDetailDrawer minimalist layout', () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = null;
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    document.body.innerHTML = '';
  });

  test('drops the always-empty Contribution History list', () => {
    root = renderDrawer(container, makeProject());
    expect(container.querySelector('.contrib-timeline')).toBeNull();
    expect(container.querySelector('.contrib-day')).toBeNull();
  });

  test('suppresses zero-value stat rows on inactive projects', () => {
    root = renderDrawer(container, makeProject({
      todayPrCount: 0,
      weekPrCount: 0,
      openPrs: 0,
      dailyLimit: undefined,
      prLessonsProcessed: undefined,
    }));
    const stats = container.querySelector('.project-drawer-stats');
    // No stats section at all when every row would be zero
    expect(stats).toBeNull();
  });

  test('shows progress meter and "today/limit" text when a daily limit is set', () => {
    root = renderDrawer(container, makeProject({ todayPrCount: 2, dailyLimit: 4 }));
    expect(container.querySelector('.project-drawer-meter-fill')).not.toBeNull();
    expect(container.querySelector('.project-drawer-meter-text')?.textContent).toBe('2/4');
  });

  test('marks the today row as at-limit when the cap is reached', () => {
    root = renderDrawer(container, makeProject({ todayPrCount: 4, dailyLimit: 4 }));
    expect(container.querySelector('.project-drawer-stat-row.at-limit')).not.toBeNull();
  });

  test('keeps existing testids stable for downstream tests', () => {
    root = renderDrawer(container, makeProject());
    expect(container.querySelector('[data-testid="project-detail-drawer"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="run-playbook-btn"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="daily-limit-input"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="project-notes-input"]')).not.toBeNull();
    expect(container.querySelector('.btn-workspace')).not.toBeNull();
  });

  test('hides the Save button until a setting is edited', () => {
    root = renderDrawer(container, makeProject());
    expect(container.querySelector('[data-testid="save-config"]')).toBeNull();
  });

  test('renders relative-time subheader when lastContribution is present', () => {
    const isoDaysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
    root = renderDrawer(container, makeProject({ lastContribution: isoDaysAgo(0) }));
    expect(container.querySelector('.project-drawer-sub')?.textContent).toContain('today');
  });

  test('collapses recent tasks beyond the first three', () => {
    root = renderDrawer(container, makeProject({
      recentTasks: [
        { taskId: 't1', name: 'A', status: 'completed' },
        { taskId: 't2', name: 'B', status: 'completed' },
        { taskId: 't3', name: 'C', status: 'completed' },
        { taskId: 't4', name: 'D', status: 'completed' },
        { taskId: 't5', name: 'E', status: 'completed' },
      ],
    }));
    expect(container.querySelectorAll('.project-drawer-task').length).toBe(3);
    const showMore = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.startsWith('Show'));
    expect(showMore?.textContent).toContain('2 more');
  });
});
