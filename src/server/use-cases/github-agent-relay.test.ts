import { describe, expect, it, vi } from 'vitest';
import { GitHubStateStore } from '../../core/github-state-store.js';
import type { GitHubPRState, GitHubReference, GitHubStateChange } from '../../core/github-types.js';
import { TaskStore, type SessionInfo } from '../../core/tasks.js';
import { GitHubChangeAgentRelay, type GitHubAgentRelayMode } from './github-agent-relay.js';

function makeRef(number = 42, taskId = 'task-1'): GitHubReference {
  return {
    type: 'pr',
    owner: 'kookr-ai',
    repo: 'kookr',
    number,
    url: `https://github.com/kookr-ai/kookr/pull/${number}`,
    detectedAt: new Date('2026-06-10T10:00:00.000Z'),
    detectedFrom: 'prompt',
    taskId,
  };
}

function makePRState(ref: GitHubReference, overrides: Partial<GitHubPRState> = {}): GitHubPRState {
  return {
    ref,
    title: 'Fix relay',
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
    lastFetchedAt: new Date('2026-06-10T10:00:00.000Z'),
    ...overrides,
  };
}

function makeSession(tmuxSession: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    tmuxSession,
    agentType: 'claude-code',
    cwd: '/repo',
    createdAt: new Date('2026-06-10T10:00:00.000Z'),
    lastStatus: 'running',
    ...overrides,
  };
}

function setup(opts: { mode?: GitHubAgentRelayMode; idle?: boolean } = {}) {
  const taskStore = new TaskStore();
  const githubStateStore = new GitHubStateStore();
  const task = taskStore.createTask({ prompt: 'work', cwd: '/repo' });
  const ref = makeRef(42, task.id);
  taskStore.addSession(task.id, makeSession('kookr-primary', { gitBranch: 'feat/relay' }));
  githubStateStore.addReference(ref);
  githubStateStore.updatePRState(makePRState(ref));

  let mode = opts.mode ?? 'active';
  let idle = opts.idle ?? true;
  const submitMessage = vi.fn(async () => ({ deliveryId: 'd1' }) as never);
  const logger = { log: vi.fn(), warn: vi.fn() };
  const relay = new GitHubChangeAgentRelay({
    taskStore,
    githubStateStore,
    userInputDelivery: { submitMessage },
    isIdleForInput: () => idle,
    getMode: () => mode,
    logger,
    now: () => new Date('2026-06-10T10:00:00.000Z'),
  });

  return {
    relay,
    taskStore,
    githubStateStore,
    taskId: task.id,
    ref,
    submitMessage,
    logger,
    setMode: (next: GitHubAgentRelayMode) => { mode = next; },
    setIdle: (next: boolean) => { idle = next; },
  };
}

function change(ref: GitHubReference, type: 'pr_merged' | 'pr_conflicting' = 'pr_merged'): GitHubStateChange {
  return { type, ref };
}

describe('GitHubChangeAgentRelay', () => {
  it('delivers a merged PR template through user input delivery when idle', async () => {
    const ctx = setup();

    ctx.relay.onChanges(ctx.taskId, [change(ctx.ref, 'pr_merged')]);
    await ctx.relay.tick();

    expect(ctx.submitMessage).toHaveBeenCalledWith(
      'kookr-primary',
      'Kookr GitHub watcher: PR #42 (head feat/relay) was merged. If your task is complete, signal completion-ready; otherwise continue with any remaining post-merge steps.',
      'github_watcher',
    );
    expect(ctx.relay.getPendingCount()).toBe(0);
  });

  it('queues while the owning agent is mid-turn and delivers on a later idle tick', async () => {
    const ctx = setup({ idle: false });

    ctx.relay.onChanges(ctx.taskId, [change(ctx.ref, 'pr_conflicting')]);
    await ctx.relay.tick();
    expect(ctx.submitMessage).not.toHaveBeenCalled();
    expect(ctx.relay.getPendingCount()).toBe(1);

    ctx.setIdle(true);
    await ctx.relay.tick();

    expect(ctx.submitMessage).toHaveBeenCalledWith(
      'kookr-primary',
      'Kookr GitHub watcher: PR #42 (head feat/relay, base main) is now CONFLICTING with its base. Rebase your worktree branch onto the base branch, resolve conflicts, and force-push with --force-with-lease.',
      'github_watcher',
    );
  });

  it('runs shadow mode without writing to the PTY', async () => {
    const ctx = setup({ mode: 'shadow' });

    ctx.relay.onChanges(ctx.taskId, [change(ctx.ref, 'pr_merged')]);
    await ctx.relay.tick();

    expect(ctx.submitMessage).not.toHaveBeenCalled();
    expect(ctx.logger.log).toHaveBeenCalledWith(expect.stringContaining('"event":"github_agent_relay.would_deliver"'));
    expect(ctx.relay.getPendingCount()).toBe(0);
  });

  it('clears pending deliveries when mode is turned off', async () => {
    const ctx = setup({ idle: false });
    ctx.relay.onChanges(ctx.taskId, [change(ctx.ref, 'pr_merged')]);
    expect(ctx.relay.getPendingCount()).toBe(1);

    ctx.setMode('off');
    await ctx.relay.tick();

    expect(ctx.relay.getPendingCount()).toBe(0);
    expect(ctx.submitMessage).not.toHaveBeenCalled();
  });

  it('prefers the live session whose branch matches the PR head', async () => {
    const ctx = setup();
    ctx.taskStore.addSession(ctx.taskId, makeSession('kookr-newer', {
      createdAt: new Date('2026-06-10T10:05:00.000Z'),
      gitBranch: 'other',
    }));

    ctx.relay.onChanges(ctx.taskId, [change(ctx.ref, 'pr_merged')]);
    await ctx.relay.tick();

    expect(ctx.submitMessage.mock.calls[0][0]).toBe('kookr-primary');
  });

  it('falls back to the most recently created live session', async () => {
    const ctx = setup();
    ctx.taskStore.updateSession(ctx.taskId, 'kookr-primary', { gitBranch: 'old' });
    ctx.taskStore.addSession(ctx.taskId, makeSession('kookr-newer', {
      createdAt: new Date('2026-06-10T10:05:00.000Z'),
      gitBranch: 'other',
    }));

    ctx.relay.onChanges(ctx.taskId, [change(ctx.ref, 'pr_merged')]);
    await ctx.relay.tick();

    expect(ctx.submitMessage.mock.calls[0][0]).toBe('kookr-newer');
  });

  it('dedups repeat occurrences after PTY accept', async () => {
    const ctx = setup();

    ctx.relay.onChanges(ctx.taskId, [change(ctx.ref, 'pr_merged')]);
    await ctx.relay.tick();
    ctx.relay.onChanges(ctx.taskId, [change(ctx.ref, 'pr_merged')]);
    await ctx.relay.tick();

    expect(ctx.submitMessage).toHaveBeenCalledTimes(1);
    expect(ctx.logger.log).toHaveBeenCalledWith(expect.stringContaining('"dropReason":"dedup"'));
  });

  it('rate caps after four accepted deliveries per task hour', async () => {
    const ctx = setup();
    for (const number of [1, 2, 3, 4, 5]) {
      const ref = makeRef(number, ctx.taskId);
      ctx.githubStateStore.addReference(ref);
      ctx.githubStateStore.updatePRState(makePRState(ref));
      ctx.relay.onChanges(ctx.taskId, [change(ref, 'pr_merged')]);
      await ctx.relay.tick();
    }

    expect(ctx.submitMessage).toHaveBeenCalledTimes(4);
    expect(ctx.logger.log).toHaveBeenCalledWith(expect.stringContaining('"dropReason":"rate_cap"'));
  });

  it('drops after three PTY write throws', async () => {
    const ctx = setup();
    ctx.submitMessage.mockRejectedValue(new Error('closed'));

    ctx.relay.onChanges(ctx.taskId, [change(ctx.ref, 'pr_merged')]);
    await ctx.relay.tick();
    await ctx.relay.tick();
    await ctx.relay.tick();

    expect(ctx.submitMessage).toHaveBeenCalledTimes(3);
    expect(ctx.logger.log).toHaveBeenCalledWith(expect.stringContaining('"dropReason":"delivery_failed"'));
    expect(ctx.relay.getPendingCount()).toBe(0);
  });

  it('drops when the task is not in progress or has no live session', () => {
    const ctx = setup();
    ctx.taskStore.completeTask(ctx.taskId);

    ctx.relay.onChanges(ctx.taskId, [change(ctx.ref, 'pr_merged')]);
    expect(ctx.logger.log).toHaveBeenCalledWith(expect.stringContaining('"dropReason":"ownership_miss"'));

    const noLive = setup();
    noLive.taskStore.updateSession(noLive.taskId, 'kookr-primary', { lastStatus: 'completed' });
    noLive.relay.onChanges(noLive.taskId, [change(noLive.ref, 'pr_merged')]);
    expect(noLive.logger.log).toHaveBeenCalledWith(expect.stringContaining('"dropReason":"no_live_session"'));
  });
});
