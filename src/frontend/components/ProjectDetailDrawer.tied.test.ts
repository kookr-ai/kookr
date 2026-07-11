// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ClientMessage, ProjectSummary } from '../../shared/protocol.js';
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
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function renderDrawer(project: ProjectSummary, compact = false, send: (msg: ClientMessage) => void = () => {}) {
  act(() => {
    root.render(
      React.createElement(ProjectDetailDrawer, {
        project,
        onClose: () => {},
        send,
        compact,
      }),
    );
  });
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('ProjectDetailDrawer — active-task overlay', () => {
  test('renders the per-project cost warning threshold', () => {
    renderDrawer(baseProject({ budgetWarnUsd: 7.5 }));
    const input = container.querySelector('[data-testid="budget-warn-input"]') as HTMLInputElement;

    expect(input.value).toBe('7.5');
  });

  test('saves an edited threshold and sends null to restore the global default', () => {
    const send = vi.fn<(msg: ClientMessage) => void>();
    renderDrawer(baseProject({ budgetWarnUsd: 7.5 }), false, send);
    const input = container.querySelector('[data-testid="budget-warn-input"]') as HTMLInputElement;

    act(() => setInputValue(input, '12'));
    act(() => (container.querySelector('[data-testid="save-config"]') as HTMLButtonElement).click());
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({
      config: expect.objectContaining({ budgetWarnUsd: 12 }),
    }));

    act(() => setInputValue(input, ''));
    act(() => (container.querySelector('[data-testid="save-config"]') as HTMLButtonElement).click());
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({
      config: expect.objectContaining({ budgetWarnUsd: null }),
    }));
  });
  test('renders contribution-attempt count with the renamed label', () => {
    renderDrawer(baseProject({ openContributionAttempts: 2 }));

    expect(container.textContent).toContain('Open contribution attempts');
    expect(container.textContent).toContain('2');
  });

  test('renders contribution-attempt count in compact mode', () => {
    renderDrawer(baseProject({ openContributionAttempts: 1 }), true);

    expect(container.textContent).toContain('1 contribution attempt');
  });

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

  test('tooltip lists tied items in compact mode (issues only)', () => {
    renderDrawer(baseProject({
      openIssuesTiedToActiveTasks: 1,
      openPrsTiedToActiveTasks: 0,
      activeTaskGithubLinks: [
        { kind: 'issue', number: 42, taskId: 't-1', taskName: 'fix #42' },
      ],
    }), true);

    const issues = container.querySelector('[data-testid="compact-tied-issues"]');
    expect(issues).not.toBeNull();
    expect(issues?.textContent).toContain('1/4127');
    expect(issues?.getAttribute('title')).toContain('#42');
    expect(issues?.getAttribute('title')).toContain('fix #42');
    expect(container.querySelector('[data-testid="compact-tied-prs"]')).toBeNull();
  });

  test('renders both compact pills when issues and PRs are tied', () => {
    renderDrawer(baseProject({
      openIssuesTiedToActiveTasks: 2,
      openPrsTiedToActiveTasks: 3,
      activeTaskGithubLinks: [
        { kind: 'issue', number: 1, taskId: 't-1', taskName: 'task A' },
        { kind: 'pr', number: 9, taskId: 't-2', taskName: 'task B' },
      ],
    }), true);

    expect(container.querySelector('[data-testid="compact-tied-issues"]')?.textContent).toContain('2/4127');
    expect(container.querySelector('[data-testid="compact-tied-prs"]')?.textContent).toContain('3/289');
  });

  test('hides the compact tied spans when nothing is tied', () => {
    renderDrawer(baseProject({ openIssuesTiedToActiveTasks: 0, openPrsTiedToActiveTasks: 0 }), true);
    expect(container.querySelector('[data-testid="compact-tied-issues"]')).toBeNull();
    expect(container.querySelector('[data-testid="compact-tied-prs"]')).toBeNull();
  });

  test('omits the fraction when repoHealth is absent', () => {
    renderDrawer(baseProject({
      repoHealth: undefined,
      openIssuesTiedToActiveTasks: 2,
      openPrsTiedToActiveTasks: 1,
    }));
    expect(container.querySelector('[data-testid="repo-open-issues"]')).toBeNull();
    expect(container.querySelector('[data-testid="repo-open-prs"]')).toBeNull();
    expect(container.querySelector('[data-testid="open-issues-tied"]')).toBeNull();
    expect(container.querySelector('[data-testid="open-prs-tied"]')).toBeNull();
  });

  test('compact mode suppresses tied pills when repoHealth denominators are absent', () => {
    renderDrawer(baseProject({
      repoHealth: undefined,
      openIssuesTiedToActiveTasks: 2,
      openPrsTiedToActiveTasks: 1,
    }), true);
    expect(container.querySelector('[data-testid="compact-tied-issues"]')).toBeNull();
    expect(container.querySelector('[data-testid="compact-tied-prs"]')).toBeNull();
  });
});
