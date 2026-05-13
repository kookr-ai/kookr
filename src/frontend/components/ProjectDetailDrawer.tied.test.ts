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
    openPrs: 0,
    recentTasks: [],
    repoHealth: {
      openIssues: 4127,
      openPullRequests: 289,
      pendingReviewPrs: [],
      repoUrl: 'https://github.com/octo/cat',
      lastFetchedAt: new Date().toISOString(),
    },
    ...overrides,
  };
}

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function renderDrawer(project: ProjectSummary, compact = false) {
  act(() => {
    root.render(
      React.createElement(ProjectDetailDrawer, {
        project,
        onClose: () => {},
        send: () => {},
        compact,
      }),
    );
  });
}

describe('ProjectDetailDrawer — active-task overlay', () => {
  test('renders plain denominator when no active tasks are tied', () => {
    renderDrawer(baseProject({ openIssuesTiedToActiveTasks: 0, openPrsTiedToActiveTasks: 0 }));

    const issues = container.querySelector('[data-testid="repo-open-issues"]');
    const prs = container.querySelector('[data-testid="repo-open-prs"]');
    expect(issues?.textContent).toContain('4127');
    expect(issues?.textContent).not.toContain('/4127');
    expect(prs?.textContent).toContain('289');
    expect(prs?.textContent).not.toContain('/289');
    expect(container.querySelector('[data-testid="open-issues-tied"]')).toBeNull();
    expect(container.querySelector('[data-testid="open-prs-tied"]')).toBeNull();
  });

  test('renders tied/total when at least one active task is tied', () => {
    renderDrawer(baseProject({
      openIssuesTiedToActiveTasks: 5,
      openPrsTiedToActiveTasks: 3,
      activeTaskGithubLinks: [
        { kind: 'issue', number: 42, taskId: 't-1', taskName: 'fix #42' },
        { kind: 'pr', number: 9, taskId: 't-2', taskName: 'open PR #9' },
      ],
    }));

    const issuesTied = container.querySelector('[data-testid="open-issues-tied"]');
    const prsTied = container.querySelector('[data-testid="open-prs-tied"]');
    expect(issuesTied).not.toBeNull();
    expect(prsTied).not.toBeNull();
    expect(issuesTied?.textContent).toContain('5');
    expect(issuesTied?.textContent).toContain('/');
    expect(issuesTied?.textContent).toContain('4127');
    expect(prsTied?.textContent).toContain('3');
    expect(prsTied?.textContent).toContain('289');
  });

  test('tooltip lists tied items in compact mode', () => {
    renderDrawer(baseProject({
      openIssuesTiedToActiveTasks: 1,
      openPrsTiedToActiveTasks: 0,
      activeTaskGithubLinks: [
        { kind: 'issue', number: 42, taskId: 't-1', taskName: 'fix #42' },
      ],
    }), true);

    const compact = container.querySelector('[data-testid="compact-tied"]');
    expect(compact).not.toBeNull();
    expect(compact?.textContent).toContain('1/4127');
    expect(compact?.getAttribute('title')).toContain('#42');
    expect(compact?.getAttribute('title')).toContain('fix #42');
  });

  test('hides the compact tied span when nothing is tied', () => {
    renderDrawer(baseProject({ openIssuesTiedToActiveTasks: 0, openPrsTiedToActiveTasks: 0 }), true);
    expect(container.querySelector('[data-testid="compact-tied"]')).toBeNull();
  });

  test('omits the fraction when repoHealth is absent', () => {
    renderDrawer(baseProject({
      repoHealth: undefined,
      openIssuesTiedToActiveTasks: 2,
      openPrsTiedToActiveTasks: 1,
    }));
    expect(container.querySelector('[data-testid="repo-open-issues"]')).toBeNull();
    expect(container.querySelector('[data-testid="repo-open-prs"]')).toBeNull();
  });
});
