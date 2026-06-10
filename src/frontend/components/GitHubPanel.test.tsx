// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { GitHubPRState } from '../../shared/protocol.js';
import { GitHubPanel } from './GitHubPanel.js';

function makePR(overrides: Partial<GitHubPRState> = {}): GitHubPRState {
  return {
    ref: {
      type: 'pr',
      owner: 'kookr-ai',
      repo: 'kookr',
      number: 1,
      url: 'https://github.com/kookr-ai/kookr/pull/1',
      detectedAt: new Date('2026-06-10T10:00:00.000Z'),
      detectedFrom: 'prompt',
      taskId: 'task-1',
    },
    title: 'Fix relay',
    status: 'open',
    mergeable: 'UNKNOWN',
    author: 'jeanibarz',
    branch: 'feat/relay',
    baseBranch: 'main',
    reviewDecision: null,
    reviewers: [],
    unresolvedThreads: [],
    totalComments: 0,
    checks: [],
    lastFetchedAt: new Date('2026-06-10T10:00:00.000Z'),
    ...overrides,
  };
}

describe('GitHubPanel mergeability', () => {
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

  test('renders UNKNOWN as pending for open PRs and N/A for merged PRs', () => {
    root = createRoot(container);
    act(() => {
      root!.render(React.createElement(GitHubPanel, {
        prs: [
          makePR({ ref: { ...makePR().ref, number: 1 }, status: 'open', mergeable: 'UNKNOWN' }),
          makePR({ ref: { ...makePR().ref, number: 2 }, status: 'merged', mergeable: 'UNKNOWN' }),
        ],
        issues: [],
      }));
    });

    expect(container.textContent).toContain('mergeable: pending');
    expect(container.textContent).toContain('mergeable: N/A');
  });
});
