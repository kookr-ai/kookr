// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ProjectSummary } from '../../shared/protocol.js';
import { ProjectDetailDrawer } from './ProjectDetailDrawer.js';

function makeProject(): ProjectSummary {
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
  };
}

function renderDrawer(container: HTMLElement, compact: boolean): Root {
  const root = createRoot(container);
  act(() => {
    root.render(React.createElement(ProjectDetailDrawer, {
      project: makeProject(),
      compact,
      onClose: vi.fn(),
      send: vi.fn(),
      onRunPlaybook: vi.fn(),
      onOpenWorkspace: vi.fn(),
    }));
  });
  return root;
}

describe('ProjectDetailDrawer compact mode', () => {
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

  test('keeps only project identity, actions, and headline stats when focused on a task', () => {
    root = renderDrawer(container, true);

    expect(container.querySelector('.project-drawer')?.classList.contains('compact')).toBe(true);
    expect(container.querySelector('.project-drawer-compact-stats')?.textContent).toContain('5 agents');
    expect(container.querySelector('.contrib-timeline')).toBeNull();
    expect(container.querySelector('[data-testid="project-notes-input"]')).toBeNull();
    expect(container.querySelector('.project-drawer-tasks')).toBeNull();
  });
});
