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

function setInputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = input instanceof window.HTMLTextAreaElement
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')!.set!;
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

  test('renders and saves the repository zero-drain issue limit without a built-in maximum', () => {
    const send = vi.fn<(msg: ClientMessage) => void>();
    renderDrawer(baseProject({ zeroDrainIssueLimit: 1000 }), false, send);
    const input = container.querySelector('[data-testid="zero-drain-issue-limit-input"]') as HTMLInputElement;

    expect(input.value).toBe('1000');
    expect(input.getAttribute('max')).toBeNull();
    act(() => setInputValue(input, '2500'));
    act(() => (container.querySelector('[data-testid="save-config"]') as HTMLButtonElement).click());
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({
      config: expect.objectContaining({ zeroDrainIssueLimit: 2500 }),
    }));
  });

  test('TS-EMISSION-004: renders and saves -1 as the unlimited zero-drain sentinel', () => {
    const send = vi.fn<(msg: ClientMessage) => void>();
    renderDrawer(baseProject({ zeroDrainIssueLimit: -1 }), false, send);
    const input = container.querySelector('[data-testid="zero-drain-issue-limit-input"]') as HTMLInputElement;

    expect(input.value).toBe('-1');
    expect(input.min).toBe('-1');
    expect(container.textContent).toContain('inherit -1 (unlimited)');
    act(() => setInputValue(input, '0'));
    act(() => setInputValue(input, '-1'));
    act(() => (container.querySelector('[data-testid="save-config"]') as HTMLButtonElement).click());
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({
      config: expect.objectContaining({ zeroDrainIssueLimit: -1 }),
    }));
  });

  test('TS-EMISSION-004: saves zero as an explicit refusal', () => {
    const send = vi.fn<(msg: ClientMessage) => void>();
    renderDrawer(baseProject({ effectiveZeroDrainIssueLimit: -1 }), false, send);
    const input = container.querySelector('[data-testid="zero-drain-issue-limit-input"]') as HTMLInputElement;

    act(() => setInputValue(input, '0'));
    act(() => (container.querySelector('[data-testid="save-config"]') as HTMLButtonElement).click());
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({
      config: expect.objectContaining({ zeroDrainIssueLimit: 0 }),
    }));
  });

  test('keeps an unlimited sentinel dirty when the installation has a ceiling', () => {
    const send = vi.fn<(msg: ClientMessage) => void>();
    renderDrawer(baseProject({ zeroDrainIssueLimitMax: 1000 }), false, send);
    const input = container.querySelector('[data-testid="zero-drain-issue-limit-input"]') as HTMLInputElement;

    act(() => setInputValue(input, '-1'));
    act(() => (container.querySelector('[data-testid="save-config"]') as HTMLButtonElement).click());
    expect(send).not.toHaveBeenCalled();
    expect(container.textContent).toContain('allows at most 1000');
  });

  test('leaves an inherited default unset when another setting is saved', () => {
    const send = vi.fn<(msg: ClientMessage) => void>();
    renderDrawer(baseProject({ effectiveZeroDrainIssueLimit: -1 }), false, send);
    const notes = container.querySelector('[data-testid="project-notes-input"]') as HTMLTextAreaElement;

    act(() => setInputValue(notes, 'Updated note'));
    act(() => (container.querySelector('[data-testid="save-config"]') as HTMLButtonElement).click());
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({
      config: expect.objectContaining({ zeroDrainIssueLimit: null }),
    }));
  });

  test('shows the inherited default after clearing a project override', () => {
    renderDrawer(baseProject({ zeroDrainIssueLimit: 5, effectiveZeroDrainIssueLimit: 5 }));
    const input = container.querySelector('[data-testid="zero-drain-issue-limit-input"]') as HTMLInputElement;

    act(() => setInputValue(input, ''));
    expect(input.placeholder).toBe('-1 (unlimited)');
    expect(container.textContent).toContain('Leave blank to inherit -1 (unlimited)');
  });

  test('keeps an over-cap value dirty and explains the deployment ceiling', () => {
    const send = vi.fn<(msg: ClientMessage) => void>();
    renderDrawer(baseProject({ zeroDrainIssueLimitMax: 1000 }), false, send);
    const input = container.querySelector('[data-testid="zero-drain-issue-limit-input"]') as HTMLInputElement;

    act(() => setInputValue(input, '1001'));
    act(() => (container.querySelector('[data-testid="save-config"]') as HTMLButtonElement).click());
    expect(send).not.toHaveBeenCalled();
    expect(container.textContent).toContain('allows at most 1000');
    expect(container.querySelector('[data-testid="save-config"]')).not.toBeNull();
  });
  test('shows accumulated spend against the cost-warning threshold', () => {
    renderDrawer(baseProject({ costUsd: 3.2, budgetWarnUsd: 7.5 }));
    const row = container.querySelector('[data-testid="project-spend-row"]') as HTMLElement;

    expect(row).not.toBeNull();
    expect(row.textContent).toContain('$3.20');
    expect(row.textContent).toContain('$7.50');
    expect(row.classList.contains('at-limit')).toBe(false);
  });

  test('highlights spend that exceeds the cost-warning threshold', () => {
    renderDrawer(baseProject({ costUsd: 9.1, budgetWarnUsd: 7.5 }));
    const row = container.querySelector('[data-testid="project-spend-row"]') as HTMLElement;

    expect(row.classList.contains('at-limit')).toBe(true);
  });

  test('does not highlight spend that exactly equals the threshold', () => {
    renderDrawer(baseProject({ costUsd: 7.5, budgetWarnUsd: 7.5 }));
    const row = container.querySelector('[data-testid="project-spend-row"]') as HTMLElement;

    expect(row.classList.contains('at-limit')).toBe(false);
  });

  test('treats a zero threshold as disabled — spend shown without a comparison', () => {
    renderDrawer(baseProject({ costUsd: 3.2, budgetWarnUsd: 0 }));
    const row = container.querySelector('[data-testid="project-spend-row"]') as HTMLElement;

    expect(row).not.toBeNull();
    expect(row.textContent).toContain('$3.20');
    expect(row.textContent).not.toContain('/');
    expect(row.classList.contains('at-limit')).toBe(false);
  });

  test('shows spend with no threshold hint when only spend is present', () => {
    renderDrawer(baseProject({ costUsd: 3.2 }));
    const row = container.querySelector('[data-testid="project-spend-row"]') as HTMLElement;

    expect(row.textContent).toContain('$3.20');
    expect(row.textContent).not.toContain('/');
  });

  test('shows a zero spend against a set threshold before any agent cost lands', () => {
    renderDrawer(baseProject({ budgetWarnUsd: 7.5 }));
    const row = container.querySelector('[data-testid="project-spend-row"]') as HTMLElement;

    expect(row).not.toBeNull();
    expect(row.textContent).toContain('$0.00');
    expect(row.textContent).toContain('$7.50');
    expect(row.classList.contains('at-limit')).toBe(false);
  });

  test('omits the spend row when there is neither spend nor a threshold', () => {
    renderDrawer(baseProject());

    expect(container.querySelector('[data-testid="project-spend-row"]')).toBeNull();
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
