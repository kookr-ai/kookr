import { afterEach, describe, expect, test, vi } from 'vitest';

import { CircuitBreaker } from '../../core/circuit-breaker.js';
import type { GitHubFetcher, GitHubPRState, GitHubReference } from '../../core/github-types.js';
import { TaskStore } from '../../core/tasks.js';
import type { ServerMessage } from '../../shared/contracts/messages.js';
import { createGitHubRuntime } from './create-github-runtime.js';

describe('createGitHubRuntime', () => {
  const scanners: Array<{ stop(): void }> = [];

  afterEach(() => {
    for (const scanner of scanners.splice(0)) scanner.stop();
  });

  test('wires initial GitHub state broadcasts through the server broadcaster', async () => {
    const messages: ServerMessage[] = [];
    const fetchedAt = new Date('2026-06-05T20:10:00.000Z');
    const ref: GitHubReference = {
      type: 'issue',
      owner: 'kookr-ai',
      repo: 'kookr',
      number: 755,
      url: 'https://github.com/kookr-ai/kookr/issues/755',
      detectedAt: fetchedAt,
      detectedFrom: 'prompt',
      taskId: 'task-755',
    };
    const fetcher: GitHubFetcher = {
      isAvailable: async () => true,
      inferOwnerRepo: async () => ({ owner: 'kookr-ai', repo: 'kookr' }),
      fetchPRState: async () => null,
      fetchIssueState: async () => null,
      fetchStates: async (refs) => ({
        prs: [],
        issues: refs.filter((item) => item.type === 'issue').map((item) => ({
          ref: item,
          title: 'arch: split server composition root into focused bootstrap modules',
          status: 'open',
          author: 'jeanibarz',
          labels: ['architecture'],
          commentCount: 0,
          lastFetchedAt: fetchedAt,
        })),
      }),
    };

    const { githubStateStore, githubScanner } = createGitHubRuntime({
      taskStore: new TaskStore(),
      githubBreaker: new CircuitBreaker({ name: 'github-test' }),
      githubPollingIntervalSec: 30,
      broadcastToAll: (msg) => messages.push(msg),
      onRepoHealthChanged: () => {},
      fetcher,
      repoHealthFetcher: async () => new Map(),
      ghUserLoginResolver: async () => 'jeanibarz',
    });
    scanners.push(githubScanner);
    githubStateStore.addReference(ref);

    await githubScanner.start();
    await githubScanner.refreshTaskState('task-755');

    expect(messages).toEqual([
      {
        type: 'githubUpdate',
        taskId: 'task-755',
        prs: [],
        issues: [
          expect.objectContaining({
            ref,
            title: 'arch: split server composition root into focused bootstrap modules',
            status: 'open',
          }),
        ],
        changes: [],
      },
    ]);
  });

  test('wires changed GitHub state broadcasts and alerts through the server broadcaster', async () => {
    const messages: ServerMessage[] = [];
    const fetchedAt = new Date('2026-06-05T20:15:00.000Z');
    const ref: GitHubReference = {
      type: 'pr',
      owner: 'kookr-ai',
      repo: 'kookr',
      number: 763,
      url: 'https://github.com/kookr-ai/kookr/pull/763',
      detectedAt: fetchedAt,
      detectedFrom: 'prompt',
      taskId: 'task-763',
    };
    const openState: GitHubPRState = {
      ref,
      title: 'refactor: extract github server bootstrap',
      status: 'open',
      mergeable: 'MERGEABLE',
      author: 'jeanibarz',
      branch: 'refactor/issue-755-server-bootstrap',
      baseBranch: 'main',
      reviewDecision: null,
      reviewers: [],
      unresolvedThreads: [],
      totalComments: 0,
      checks: [],
      lastFetchedAt: fetchedAt,
    };
    const mergedState: GitHubPRState = {
      ...openState,
      status: 'merged',
      lastFetchedAt: new Date('2026-06-05T20:16:00.000Z'),
    };
    const fetcher: GitHubFetcher = {
      isAvailable: async () => true,
      inferOwnerRepo: async () => ({ owner: 'kookr-ai', repo: 'kookr' }),
      fetchPRState: async () => null,
      fetchIssueState: async () => null,
      fetchStates: async () => ({ prs: [mergedState], issues: [] }),
    };

    const { githubStateStore, githubScanner } = createGitHubRuntime({
      taskStore: new TaskStore(),
      githubBreaker: new CircuitBreaker({ name: 'github-test' }),
      githubPollingIntervalSec: 30,
      broadcastToAll: (msg) => messages.push(msg),
      onRepoHealthChanged: () => {},
      fetcher,
      repoHealthFetcher: async () => new Map(),
      ghUserLoginResolver: async () => 'jeanibarz',
    });
    scanners.push(githubScanner);
    githubStateStore.addReference(ref);
    githubStateStore.updatePRState(openState);

    await githubScanner.start();
    await githubScanner.refreshTaskState('task-763');

    expect(messages).toEqual([
      {
        type: 'githubUpdate',
        taskId: 'task-763',
        prs: [
          expect.objectContaining({
            ref,
            status: 'merged',
          }),
        ],
        issues: [],
        changes: [
          {
            type: 'pr_merged',
            ref,
          },
        ],
      },
      {
        type: 'alert',
        agentId: 'prompt',
        summary: 'PR kookr-ai/kookr#763: merged',
        details: '',
        severity: 'info',
      },
    ]);
  });

  test('wires changed GitHub state into the agent relay', async () => {
    const fetchedAt = new Date('2026-06-05T20:15:00.000Z');
    const taskStore = new TaskStore();
    const task = taskStore.createTask({ prompt: 'work', cwd: '/repo' });
    taskStore.addSession(task.id, {
      tmuxSession: 'kookr-relay',
      agentType: 'claude-code',
      cwd: '/repo',
      createdAt: fetchedAt,
      lastStatus: 'running',
      gitBranch: 'feat/relay',
    });
    const ref: GitHubReference = {
      type: 'pr',
      owner: 'kookr-ai',
      repo: 'kookr',
      number: 764,
      url: 'https://github.com/kookr-ai/kookr/pull/764',
      detectedAt: fetchedAt,
      detectedFrom: 'prompt',
      taskId: task.id,
    };
    const openState: GitHubPRState = {
      ref,
      title: 'relay',
      status: 'open',
      mergeable: 'MERGEABLE',
      author: 'jeanibarz',
      branch: 'feat/relay',
      baseBranch: 'main',
      reviewDecision: null,
      reviewers: [],
      unresolvedThreads: [],
      totalComments: 0,
      checks: [],
      lastFetchedAt: fetchedAt,
    };
    const mergedState: GitHubPRState = {
      ...openState,
      status: 'merged',
      lastFetchedAt: new Date('2026-06-05T20:16:00.000Z'),
    };
    const fetcher: GitHubFetcher = {
      isAvailable: async () => true,
      inferOwnerRepo: async () => ({ owner: 'kookr-ai', repo: 'kookr' }),
      fetchPRState: async () => null,
      fetchIssueState: async () => null,
      fetchStates: async () => ({ prs: [mergedState], issues: [] }),
    };
    const submitMessage = vi.fn(async () => ({ deliveryId: 'd1' }) as never);

    const { githubStateStore, githubScanner, githubAgentRelay } = createGitHubRuntime({
      taskStore,
      githubBreaker: new CircuitBreaker({ name: 'github-test' }),
      githubPollingIntervalSec: 30,
      broadcastToAll: () => {},
      onRepoHealthChanged: () => {},
      fetcher,
      repoHealthFetcher: async () => new Map(),
      ghUserLoginResolver: async () => 'jeanibarz',
      userInputDelivery: { submitMessage },
      isIdleForInput: () => true,
      getGitHubAgentRelayMode: () => 'active',
    });
    scanners.push(githubScanner);
    githubStateStore.addReference(ref);
    githubStateStore.updatePRState(openState);

    await githubScanner.start();
    await githubScanner.refreshTaskState(task.id);
    await githubAgentRelay!.tick();

    expect(submitMessage).toHaveBeenCalledWith(
      'kookr-relay',
      'Kookr GitHub watcher: PR #764 (head feat/relay) was merged. If your task is complete, signal completion-ready; otherwise continue with any remaining post-merge steps.',
      'github_watcher',
    );
  });
});
