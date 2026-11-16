// @vitest-environment happy-dom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { GitHubPanel } from './GitHubPanel.js';
import type { GitHubIssueState, GitHubPRState } from '../../shared/protocol.js';

function makePr(number: number, title: string): GitHubPRState {
  return {
    ref: {
      type: 'pr', owner: 'kookr-ai', repo: 'kookr', number,
      url: `https://github.com/kookr-ai/kookr/pull/${number}`,
      detectedAt: new Date('2026-11-16T10:00:00.000Z'), detectedFrom: 'agent-1', taskId: 'task-1',
    },
    title, status: 'open', mergeable: 'MERGEABLE', author: 'me', branch: `b-${number}`, baseBranch: 'main',
    reviewDecision: 'approved', reviewers: [], unresolvedThreads: [], totalComments: 0, checks: [],
    lastFetchedAt: new Date('2026-11-16T10:05:00.000Z'),
  };
}

const ISSUE: GitHubIssueState = {
  ref: {
    type: 'issue', owner: 'kookr-ai', repo: 'kookr', number: 4024,
    url: 'https://github.com/kookr-ai/kookr/issues/4024',
    detectedAt: new Date('2026-11-16T10:00:00.000Z'), detectedFrom: 'prompt', taskId: 'task-1',
  },
  title: 'Reading pane', status: 'open', author: 'me', labels: [], commentCount: 0,
  lastFetchedAt: new Date('2026-11-16T10:05:00.000Z'),
};

describe('GitHubPanel own pull request and Mentioned list (#4024)', () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = null;
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
  });

  function render(props: React.ComponentProps<typeof GitHubPanel>): void {
    root = createRoot(container);
    act(() => { root!.render(<GitHubPanel {...props} />); });
  }

  test('shows the own PR as a summary first, and the rest under Mentioned', () => {
    const own = makePr(4070, 'Pull request tab');
    const other = makePr(4063, 'Changes tab');
    render({ prs: [other, own], issues: [ISSUE], ownPrs: [own] });

    const cards = [...container.querySelectorAll('.gh-pr-card')];
    expect(cards.map((c) => c.querySelector('.gh-pr-title')?.textContent)).toEqual(['#4070 Pull request tab']);
    expect(cards[0].textContent).toContain('b-4070 → main');
    const mentioned = container.querySelector('[data-testid="gh-mentioned"]')!;
    expect(mentioned.querySelector('.gh-section-header')?.textContent).toBe('Mentioned');
    expect([...mentioned.querySelectorAll('[data-testid="gh-mentioned-pr"]')].map((r) => r.textContent)).toEqual(['#4063 Changes tabOPEN']);
    expect(mentioned.querySelector('.gh-issue-title')?.textContent).toBe('#4024 Reading pane');
    // The summary comes before the Mentioned list.
    expect(cards[0].compareDocumentPosition(mentioned) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test('with no own PR, every reference is under Mentioned', () => {
    render({ prs: [makePr(1, 'One')], issues: [], ownPrs: [] });
    expect(container.querySelectorAll('.gh-pr-card')).toHaveLength(0);
    expect(container.querySelectorAll('[data-testid="gh-mentioned-pr"]')).toHaveLength(1);
  });

  test('with only own PRs there is no Mentioned list', () => {
    const own = makePr(2, 'Two');
    render({ prs: [own], issues: [], ownPrs: [own] });
    expect(container.querySelectorAll('.gh-pr-card')).toHaveLength(1);
    expect(container.querySelector('[data-testid="gh-mentioned"]')).toBeNull();
  });
});
