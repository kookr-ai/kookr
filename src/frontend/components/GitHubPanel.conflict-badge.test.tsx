// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { GitHubPanel } from './GitHubPanel.js';
import type { GitHubPRState } from '../../shared/protocol.js';

function makePr(overrides: Partial<GitHubPRState> = {}): GitHubPRState {
  const number = overrides.ref?.number ?? 88;
  return {
    ref: {
      type: 'pr',
      owner: 'kookr-ai',
      repo: 'kookr',
      number,
      url: `https://github.com/kookr-ai/kookr/pull/${number}`,
      detectedAt: new Date('2026-08-17T10:00:00.000Z'),
      detectedFrom: 'test',
      taskId: 'task-1',
    },
    title: 'Surface merge-conflict status',
    status: 'open',
    mergeable: 'UNKNOWN',
    author: 'jeanibarz',
    branch: 'feat-issue-2753-pr-conflict-badge',
    baseBranch: 'main',
    reviewDecision: null,
    reviewers: [],
    unresolvedThreads: [],
    totalComments: 0,
    checks: [],
    lastFetchedAt: new Date('2026-08-17T10:05:00.000Z'),
    ...overrides,
  };
}

describe('GitHubPanel PR conflict badge', () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = '';
    container = document.createElement('div');
    document.body.appendChild(container);
    root = null;
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    document.body.innerHTML = '';
  });

  function render(prs: GitHubPRState[]): void {
    root = createRoot(container);
    act(() => {
      root!.render(<GitHubPanel prs={prs} issues={[]} />);
    });
  }

  test('shows a conflict badge when mergeable is CONFLICTING', () => {
    render([makePr({ mergeable: 'CONFLICTING' })]);
    const badge = container.querySelector('[data-testid="gh-pr-conflict-badge"]');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe('Conflict');
  });

  test('shows no conflict badge when mergeable is MERGEABLE', () => {
    render([makePr({ mergeable: 'MERGEABLE' })]);
    expect(container.querySelector('[data-testid="gh-pr-conflict-badge"]')).toBeNull();
  });

  test('shows no conflict badge when mergeable is UNKNOWN', () => {
    render([makePr({ mergeable: 'UNKNOWN' })]);
    expect(container.querySelector('[data-testid="gh-pr-conflict-badge"]')).toBeNull();
  });

  test('keeps the neighboring status badge alongside a conflict badge', () => {
    render([makePr({ mergeable: 'CONFLICTING', status: 'open' })]);
    const statusBadge = container.querySelector('.gh-badge-open');
    expect(statusBadge?.textContent).toBe('OPEN');
    expect(container.querySelector('[data-testid="gh-pr-conflict-badge"]')).not.toBeNull();
  });
});
