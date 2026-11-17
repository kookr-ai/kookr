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

  test('re-tracks a finished task\'s PR after a restart and broadcasts its delivery state (issue #3915)', async () => {
    const messages: ServerMessage[] = [];
    const finishedAt = new Date('2026-11-16T09:05:00.000Z');
    const commit = 'c'.repeat(40);
    const mergedState = (ref: GitHubReference): GitHubPRState => ({
      ref, title: 'feat: delivery state', status: 'merged', mergeable: 'UNKNOWN', author: 'dev', branch: 'b',
      baseBranch: 'staging', reviewDecision: null, reviewers: [], unresolvedThreads: [], totalComments: 0, checks: [],
      mergedAt: new Date('2026-11-16T09:00:00.000Z'), mergeCommit: commit, lastFetchedAt: finishedAt,
    });
    const fetcher: GitHubFetcher = {
      isAvailable: async () => true,
      inferOwnerRepo: async () => ({ owner: 'kookr-ai', repo: 'kookr' }),
      fetchPRState: async () => null,
      fetchIssueState: async () => null,
      fetchStates: async (refs) => ({ prs: refs.filter((r) => r.type === 'pr').map(mergedState), issues: [] }),
    };
    // Only what the runtime reads from the task store in this path.
    const taskStore = {
      viewTasks: () => [{
        id: 'task-done', status: 'completed', finishedAt,
        completionDigest: { bullets: [], filesChanged: [], prUrls: ['https://github.com/kookr-ai/kookr/pull/3920'] },
      }],
      getTask: () => undefined,
    } as unknown as TaskStore;
    // Local git as the tracker sees it: staging is configured, main does not have the commit yet.
    const git = vi.fn(async (args: string[]) => {
      if (args[0] === 'rev-parse') return { code: 0, stdout: 'x\n' };
      if (args[0] === 'show') return { code: 0, stdout: '{"integrationBranch":"staging"}' };
      if (args[0] === 'merge-base') return { code: 1, stdout: '' };
      return { code: 0, stdout: '' };
    });

    const { githubScanner, prDeliveryTracker } = createGitHubRuntime({
      taskStore,
      githubBreaker: new CircuitBreaker({ name: 'github-test' }),
      githubPollingIntervalSec: 30,
      broadcastToAll: (msg) => messages.push(msg),
      onRepoHealthChanged: () => {},
      fetcher,
      repoHealthFetcher: async () => new Map(),
      ghUserLoginResolver: async () => 'dev',
      prDelivery: {
        kookrDir: '/nonexistent', resolveRepoPath: () => '/repo', git, trainStateDir: () => '',
        now: () => new Date('2026-11-16T10:00:00.000Z'),
      },
    });
    scanners.push(githubScanner, { stop: () => prDeliveryTracker?.stop() });

    await githubScanner.start();

    await vi.waitFor(() => {
      const withDelivery = messages.find((m) => m.type === 'githubUpdate' && m.prs[0]?.delivery);
      expect(withDelivery).toMatchObject({
        type: 'githubUpdate',
        taskId: 'task-done',
        prs: [{ ref: { number: 3920, detectedFrom: 'completion-digest' }, delivery: { stage: 'in-staging', integrationBranch: 'staging' } }],
      });
    });
  });

  // Issue #4077: the runtime must hand the store the task records as its
  // authorship persistence, or the evidence is lost on every restart.
  test('restores authorship from the task records and saves new evidence back to them', () => {
    const taskStore = new TaskStore();
    const author = taskStore.createTask({ prompt: 'author', cwd: '/tmp' });
    const later = taskStore.createTask({ prompt: 'later pusher', cwd: '/tmp' });
    taskStore.addGithubAuthorship(author.id, { pushedBranches: ['kookr-ai/kookr:fix/x'], createdPrs: [] });

    const { githubStateStore, githubScanner } = createGitHubRuntime({
      taskStore,
      githubBreaker: new CircuitBreaker({ name: 'github-test' }),
      githubPollingIntervalSec: 30,
      broadcastToAll: () => {},
      onRepoHealthChanged: () => {},
      repoHealthFetcher: async () => new Map(),
      ghUserLoginResolver: async () => null,
    });
    scanners.push(githubScanner);

    const pr = { owner: 'kookr-ai', repo: 'kookr', number: 7, branch: 'fix/x' };
    githubStateStore.recordAuthorship(later.id, {
      pushedBranches: [{ owner: 'kookr-ai', repo: 'kookr', branch: 'fix/x' }],
      createdPrs: [],
    });
    expect(githubStateStore.authorshipOf(author.id, pr)).toBe('self');
    expect(taskStore.getTask(later.id)?.githubAuthorship).toEqual({
      pushedBranches: ['kookr-ai/kookr:fix/x'],
      createdPrs: [],
    });
  });

});
