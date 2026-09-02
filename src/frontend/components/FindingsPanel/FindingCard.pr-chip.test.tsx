// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { FindingsPanel } from '../FindingsPanel.js';
import { createKookrStore, useKookrStore } from '../../store/useStore.js';
import type { AgentState, GitHubPRState } from '../../../shared/protocol.js';
import type { TaskGitHub } from '../../store/store-types.js';

function syncGlobalStore() {
  const freshState = createKookrStore().getState();
  const nextData = Object.fromEntries(
    Object.entries(freshState).filter(([, value]) => typeof value !== 'function'),
  );
  useKookrStore.setState(nextData);
}

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
    title: 'Show PR status on finding cards',
    status: 'open',
    mergeable: 'UNKNOWN',
    author: 'jeanibarz',
    branch: 'feat-issue-2601-finding-pr-chip',
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

function stubTaskGitHub(overrides: Partial<TaskGitHub> = {}): TaskGitHub {
  return {
    taskId: 'task-1',
    prs: [makePr()],
    issues: [],
    changes: [],
    ...overrides,
  };
}

function makeAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    agentId: 'agent-1',
    taskId: 'task-1',
    taskName: 'Task 1',
    description: 'Working',
    events: [],
    anomaly: {
      agentId: 'agent-1',
      type: 'permission_blocked',
      severity: 'warning',
      explanation: 'Blocked on a Bash permission prompt',
      detectedAt: new Date('2026-06-11T08:00:00Z'),
    },
    taskStatus: 'inProgress',
    cwd: '/tmp/project',
    ...overrides,
  } as AgentState;
}

function renderPanel(container: HTMLElement, findings: AgentState[]): Root {
  const root = createRoot(container);
  act(() => {
    root.render(
      <FindingsPanel
        findings={findings}
        healthy={[]}
        pending={[]}
        snoozed={[]}
        completed={[]}
        selectedAgentId={null}
        selectedTaskId={null}
        send={vi.fn()}
        clearCompletedFinishedCount={0}
        clearCompletedTerminatedCount={0}
      />,
    );
  });
  return root;
}

describe('FindingCard GitHub PR chip', () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    syncGlobalStore();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ checks: {}, fires: {}, falsePositives: {} }),
        text: async () => '{}',
      })),
    );
    container = document.createElement('div');
    document.body.appendChild(container);
    root = null;
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  test('shows #number and status from a stub TaskGitHub', () => {
    useKookrStore.setState({
      githubState: { 'task-1': stubTaskGitHub() },
    });
    root = renderPanel(container, [makeAgent()]);
    const chip = container.querySelector('[data-testid="finding-pr-chip"]');
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toBe('#88 · open');
  });

  test('adds a CI-failed class when checks failed', () => {
    useKookrStore.setState({
      githubState: {
        'task-1': stubTaskGitHub({
          prs: [makePr({
            checks: [{ name: 'ci', status: 'completed', conclusion: 'failure' }],
          })],
        }),
      },
    });
    root = renderPanel(container, [makeAgent()]);
    const chip = container.querySelector('[data-testid="finding-pr-chip"]');
    expect(chip?.textContent).toBe('#88 · open · CI failed');
    expect(chip?.className).toContain('finding-pr-chip--failed');
    expect(chip?.className).not.toContain('finding-pr-chip--attention');
  });

  test('adds a conflict class and label when the PR is CONFLICTING', () => {
    useKookrStore.setState({
      githubState: {
        'task-1': stubTaskGitHub({
          prs: [makePr({ mergeable: 'CONFLICTING' })],
        }),
      },
    });
    root = renderPanel(container, [makeAgent()]);
    const chip = container.querySelector('[data-testid="finding-pr-chip"]');
    expect(chip?.textContent).toBe('#88 · open · conflict');
    expect(chip?.className).toContain('finding-pr-chip--conflict');
    expect(chip?.getAttribute('data-attention')).toBe('true');
  });

  test('leaves an UNKNOWN-mergeable PR chip quiet', () => {
    useKookrStore.setState({
      githubState: {
        'task-1': stubTaskGitHub({
          prs: [makePr({ mergeable: 'UNKNOWN' })],
        }),
      },
    });
    root = renderPanel(container, [makeAgent()]);
    const chip = container.querySelector('[data-testid="finding-pr-chip"]');
    expect(chip?.textContent).toBe('#88 · open');
    expect(chip?.className).not.toContain('finding-pr-chip--conflict');
    expect(chip?.getAttribute('data-attention')).toBe('false');
  });

  test('adds an attention class when a reviewer requested changes', () => {
    useKookrStore.setState({
      githubState: {
        'task-1': stubTaskGitHub({
          prs: [makePr({ reviewDecision: 'changes_requested' })],
        }),
      },
    });
    root = renderPanel(container, [makeAgent()]);
    const chip = container.querySelector('[data-testid="finding-pr-chip"]');
    expect(chip?.textContent).toBe('#88 · open · changes requested');
    expect(chip?.className).toContain('finding-pr-chip--attention');
    expect(chip?.className).not.toContain('finding-pr-chip--failed');
  });

  test('clicking the chip selects the task and keeps the GitHub pane after the card click timer', () => {
    vi.useFakeTimers();
    useKookrStore.setState({
      githubState: { 'task-1': stubTaskGitHub() },
      detailPaneMode: 'right',
    });
    root = renderPanel(container, [makeAgent()]);
    const chip = container.querySelector<HTMLButtonElement>('[data-testid="finding-pr-chip"]');
    expect(chip).not.toBeNull();
    act(() => {
      chip!.click();
    });
    act(() => {
      vi.advanceTimersByTime(250);
    });
    const state = useKookrStore.getState();
    expect(state.selectedAgentId).toBe('agent-1');
    expect(state.selectedTaskId).toBe('task-1');
    expect(state.leftPane).toBe('github');
    expect(state.narrowTab).toBe('github');
    expect(state.detailPaneMode).toBe('split');
    vi.useRealTimers();
  });

  test('only the finding whose task owns the PR gets a chip', () => {
    useKookrStore.setState({
      githubState: {
        'task-2': stubTaskGitHub({
          taskId: 'task-2',
          prs: [makePr({ ref: {
            type: 'pr',
            owner: 'kookr-ai',
            repo: 'kookr',
            number: 91,
            url: 'https://github.com/kookr-ai/kookr/pull/91',
            detectedAt: new Date('2026-08-17T10:00:00.000Z'),
            detectedFrom: 'test',
            taskId: 'task-2',
          } })],
        }),
      },
    });
    root = renderPanel(container, [
      makeAgent(),
      makeAgent({
        agentId: 'agent-2',
        taskId: 'task-2',
        taskName: 'Task 2',
        anomaly: {
          agentId: 'agent-2',
          type: 'stuck',
          severity: 'warning',
          explanation: 'No progress',
          detectedAt: new Date('2026-06-11T08:00:00Z'),
        },
      }),
    ]);
    const chips = Array.from(container.querySelectorAll('[data-testid="finding-pr-chip"]'));
    expect(chips).toHaveLength(1);
    expect(chips[0]?.textContent).toBe('#91 · open');
    const cards = Array.from(container.querySelectorAll('.finding-card'));
    expect(cards).toHaveLength(2);
    expect(cards[0]?.querySelector('[data-testid="finding-pr-chip"]')).toBeNull();
    expect(cards[1]?.querySelector('[data-testid="finding-pr-chip"]')).not.toBeNull();
  });

  test('cards with no GitHub refs stay unchanged', () => {
    root = renderPanel(container, [makeAgent()]);
    expect(container.querySelector('[data-testid="finding-pr-chip"]')).toBeNull();
    expect(container.querySelector('.finding-card')).not.toBeNull();
  });
});
