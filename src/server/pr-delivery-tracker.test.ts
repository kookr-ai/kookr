import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { GitHubStateStore } from '../core/github-state-store.js';
import type { GitHubPRState, GitHubReference } from '../core/github-types.js';
import {
  createRepoPathResolver,
  finishedTaskPrReferences,
  parsePullRequestUrl,
  PrDeliveryTracker,
  withSnapshotPrDelivery,
} from './pr-delivery-tracker.js';

/**
 * A real repository shaped like one the integration train runs on: `main`
 * with `.kookr/delivery-gate.json`, `staging` with squash commits, a train
 * revert, and remote-tracking refs (with reflog) standing in for `origin`.
 */
let root: string;
let repo: string;
let trainDir: string;
const sha: Record<string, string> = {};

function git(args: string[], env: Record<string, string> = {}): string {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', ...env },
  }).trim();
}

function commit(message: string, file: string, date: string): string {
  writeFileSync(join(repo, file), `${message}\n`);
  git(['add', file]);
  git(['commit', '-q', '-m', message], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  return git(['rev-parse', 'HEAD']);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'pr-delivery-'));
  repo = join(root, 'repo');
  trainDir = join(root, 'train');
  mkdirSync(repo);
  mkdirSync(trainDir);
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'core.logAllRefUpdates', 'always']);
  mkdirSync(join(repo, '.kookr'));
  commit('base', 'base.txt', '2026-10-01T00:00:00Z');
  writeFileSync(join(repo, '.kookr', 'delivery-gate.json'), '{"integrationBranch":"staging"}\n');
  git(['add', '.kookr/delivery-gate.json']);
  git(['commit', '-q', '-m', 'turn on the train'], { GIT_AUTHOR_DATE: '2026-11-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-11-01T00:00:00Z' });
  sha.gate = git(['rev-parse', 'HEAD']);
  git(['checkout', '-q', '-b', 'staging']);
  sha.promoted = commit('feat: promoted (#10)', 'a.txt', '2026-11-16T09:00:00Z');
  sha.reverted = commit('feat: broke the suite (#11)', 'b.txt', '2026-11-16T09:10:00Z');
  git(['revert', '--no-edit', '--no-commit', sha.reverted]);
  git(['commit', '-q', '-m', 'Revert "feat: broke the suite (#11)"', '-m', `This reverts commit ${sha.reverted}.`, '-m', 'Kookr-Integration-Train: revert'],
    { GIT_AUTHOR_DATE: '2026-11-16T09:30:00Z', GIT_COMMITTER_DATE: '2026-11-16T09:30:00Z' });
  sha.revert = git(['rev-parse', 'HEAD']);
  sha.waiting = commit('feat: waiting for the train (#12)', 'c.txt', '2026-11-16T09:40:00Z');
  // origin/main moved twice: to the gate commit, then the train promoted #10.
  git(['update-ref', '--create-reflog', '-m', 'fetch', 'refs/remotes/origin/main', sha.gate]);
  git(['update-ref', '--create-reflog', '-m', 'update by push', 'refs/remotes/origin/main', sha.promoted]);
  git(['update-ref', '--create-reflog', '-m', 'fetch', 'refs/remotes/origin/staging', sha.waiting]);
  writeFileSync(join(trainDir, 'events.jsonl'), `${JSON.stringify({
    at: '2026-11-16T09:31:00.000Z',
    kind: 'reverted',
    detail: `reverted ${sha.reverted} as ${sha.revert} on staging; fix task train-fix-issue-3915-2 spawned (automatic re-land 2 of 3)`,
  })}\n`);
  writeFileSync(join(trainDir, `verify-${sha.reverted.slice(0, 10)}.log`), '[unit_lane]  FAIL  |unit| src/b.test.ts > b > breaks\n');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function ref(number: number, taskId = `task-${number}`): GitHubReference {
  return {
    type: 'pr', owner: 'kookr-ai', repo: 'kookr', number,
    url: `https://github.com/kookr-ai/kookr/pull/${number}`,
    detectedAt: new Date('2026-11-16T08:00:00Z'), detectedFrom: 'agent', taskId,
  };
}

function pr(number: number, fields: Partial<GitHubPRState>): GitHubPRState {
  return {
    ref: ref(number), title: `PR ${number}`, status: 'merged', mergeable: 'UNKNOWN', author: 'dev',
    branch: `b-${number}`, baseBranch: 'staging', reviewDecision: null, reviewers: [], unresolvedThreads: [],
    totalComments: 0, checks: [], createdAt: new Date('2026-11-16T08:30:00Z'), mergedAt: new Date('2026-11-16T09:00:00Z'),
    lastFetchedAt: new Date('2026-11-16T09:50:00Z'), ...fields,
  };
}

function setup(states: GitHubPRState[]) {
  const store = new GitHubStateStore();
  for (const state of states) {
    store.addReference(state.ref);
    store.updatePRState(state);
  }
  const changed: string[] = [];
  const tracker = new PrDeliveryTracker({
    store,
    kookrDir: root,
    resolveRepoPath: () => repo,
    trainStateDir: () => trainDir,
    onDeliveryChanged: (taskId) => changed.push(taskId),
  });
  const delivery = (n: number) => store.getPRState({ owner: 'kookr-ai', repo: 'kookr', number: n })?.delivery;
  return { store, tracker, changed, delivery };
}

describe('PrDeliveryTracker (real git repository)', () => {
  test('derives open, in staging, on main, reverted and skipped-the-train from git and the train log', async () => {
    const { tracker, changed, delivery } = setup([
      pr(9, { status: 'open', mergedAt: undefined }),
      pr(10, { mergeCommit: sha.promoted }),
      pr(11, { mergeCommit: sha.reverted, mergedAt: new Date('2026-11-16T09:10:00Z') }),
      pr(12, { mergeCommit: sha.waiting, mergedAt: new Date('2026-11-16T09:40:00Z') }),
      pr(13, { baseBranch: 'main', mergeCommit: sha.gate, mergedAt: new Date('2026-11-16T07:00:00Z') }),
      pr(14, { mergeCommit: 'f'.repeat(40) }),
    ]);
    await tracker.refresh();

    expect(delivery(9)).toEqual({ stage: 'pr-open', integrationBranch: 'staging', openedAt: '2026-11-16T08:30:00.000Z' });
    expect(delivery(10)).toMatchObject({ stage: 'on-main', mergedAt: '2026-11-16T09:00:00.000Z' });
    // The promotion time comes from origin/main's reflog, i.e. when this checkout saw main move.
    expect(Number.isFinite(Date.parse(delivery(10)!.onMainAt!))).toBe(true);
    expect(delivery(10)?.skippedTrain).toBeUndefined();
    expect(delivery(11)).toEqual({
      stage: 'reverted',
      integrationBranch: 'staging',
      openedAt: '2026-11-16T08:30:00.000Z',
      mergedAt: '2026-11-16T09:10:00.000Z',
      revertedAt: '2026-11-16T09:31:00.000Z',
      revert: {
        revertCommit: sha.revert,
        attempt: 2,
        maxAttempts: 3,
        fixTaskKey: 'train-fix-issue-3915-2',
        needsHuman: false,
        failingTests: ['src/b.test.ts > b > breaks'],
      },
    });
    expect(delivery(12)).toEqual({
      stage: 'in-staging', integrationBranch: 'staging',
      openedAt: '2026-11-16T08:30:00.000Z', mergedAt: '2026-11-16T09:40:00.000Z',
    });
    expect(delivery(13)).toMatchObject({ stage: 'on-main', skippedTrain: true, onMainAt: '2026-11-16T07:00:00.000Z' });
    // A merge commit this checkout has not fetched: no guess.
    expect(delivery(14)).toBeUndefined();
    expect(changed.sort()).toEqual(['task-10', 'task-11', 'task-12', 'task-13', 'task-9']);
  });

  test('moves a PR from in staging to on main once origin/main contains it, and reports only that change', async () => {
    const { tracker, changed, delivery } = setup([
      pr(12, { mergeCommit: sha.waiting }),
      pr(10, { mergeCommit: sha.promoted }),
    ]);
    await tracker.refresh();
    expect(delivery(12)?.stage).toBe('in-staging');
    changed.length = 0;

    git(['update-ref', '--create-reflog', '-m', 'update by push', 'refs/remotes/origin/main', sha.waiting]);
    try {
      await tracker.refresh();
      expect(delivery(12)?.stage).toBe('on-main');
      expect(changed).toEqual(['task-12']);
    } finally {
      git(['update-ref', '--create-reflog', '-m', 'reset', 'refs/remotes/origin/main', sha.promoted]);
    }
  });

  test('no delivery for a repository the server has no checkout of', async () => {
    const store = new GitHubStateStore();
    const state = pr(10, { mergeCommit: sha.promoted });
    store.addReference(state.ref);
    store.updatePRState(state);
    const tracker = new PrDeliveryTracker({
      store, kookrDir: root, resolveRepoPath: () => null, trainStateDir: () => trainDir, onDeliveryChanged: () => {},
    });
    await tracker.refresh();
    expect(store.getPRState({ owner: 'kookr-ai', repo: 'kookr', number: 10 })?.delivery).toBeUndefined();
  });
});

describe('GitHubStateStore delivery', () => {
  test('a refetch keeps the delivery while status and base are unchanged, and drops it when they change', () => {
    const store = new GitHubStateStore();
    const open = pr(5, { status: 'open' });
    store.addReference(open.ref);
    store.updatePRState(open);
    expect(store.setPRDelivery(open.ref, { stage: 'pr-open', integrationBranch: 'staging' })).toBe(true);
    expect(store.setPRDelivery(open.ref, { stage: 'pr-open', integrationBranch: 'staging' })).toBe(false);

    store.updatePRState(pr(5, { status: 'open' }));
    expect(store.getPRState(open.ref)?.delivery?.stage).toBe('pr-open');

    store.updatePRState(pr(5, { status: 'merged' }));
    expect(store.getPRState(open.ref)?.delivery).toBeUndefined();
  });
});

describe('finishedTaskPrReferences', () => {
  const now = new Date('2026-11-16T12:00:00Z');
  const terminal = (status: string) => status === 'completed' || status === 'cancelled';

  test('re-tracks the digest PRs of tasks that finished within the window', () => {
    const refs = finishedTaskPrReferences([
      { id: 'recent', status: 'completed', finishedAt: new Date('2026-11-15T12:00:00Z'), completionDigest: { prUrls: ['https://github.com/kookr-ai/kookr/pull/3920', 'not a url'] } },
      { id: 'old', status: 'completed', finishedAt: new Date('2026-10-01T12:00:00Z'), completionDigest: { prUrls: ['https://github.com/kookr-ai/kookr/pull/1'] } },
      { id: 'live', status: 'running', completionDigest: { prUrls: ['https://github.com/kookr-ai/kookr/pull/2'] } },
    ], now, 7 * 24 * 3600 * 1000, terminal);
    expect(refs).toEqual([{
      type: 'pr', owner: 'kookr-ai', repo: 'kookr', number: 3920,
      url: 'https://github.com/kookr-ai/kookr/pull/3920',
      detectedAt: new Date('2026-11-15T12:00:00Z'), detectedFrom: 'completion-digest', taskId: 'recent',
    }]);
  });

  test('parsePullRequestUrl accepts only github.com pull URLs', () => {
    expect(parsePullRequestUrl('https://github.com/a/b/pull/7/files')).toEqual({ owner: 'a', repo: 'b', number: 7 });
    expect(parsePullRequestUrl('https://github.com/a/b/issues/7')).toBeNull();
    expect(parsePullRequestUrl('https://example.com/a/b/pull/7')).toBeNull();
  });
});

describe('createRepoPathResolver', () => {
  test("uses the server's checkout for its own repository, else the task's existing directory", () => {
    const keys: Record<string, string> = { '/srv/kookr': 'kookr-ai-kookr', '/wt/other': 'acme-tool' };
    const resolve = createRepoPathResolver({
      serverCwd: '/srv/kookr',
      getTaskCwd: (taskId) => (taskId === 't-other' ? '/wt/other' : taskId === 't-gone' ? '/wt/gone' : undefined),
      exists: (path) => path !== '/wt/gone',
      repoKeyOf: (path) => keys[path] ?? 'none',
    });
    expect(resolve('Kookr-AI', 'Kookr', 't-any')).toBe('/srv/kookr');
    expect(resolve('acme', 'tool', 't-other')).toBe('/wt/other');
    expect(resolve('acme', 'tool', 't-gone')).toBeNull();
  });
});

describe('withSnapshotPrDelivery', () => {
  test('adds prDelivery to agents whose PRs have a delivery state, and leaves the others alone', () => {
    const delivered = pr(10, { delivery: { stage: 'in-staging', integrationBranch: 'staging' } });
    const plain = { agentId: 'b', taskId: 'task-2' };
    const out = withSnapshotPrDelivery([{ agentId: 'a', taskId: 'task-10' }, plain, { agentId: 'c' }], (taskId) => (
      taskId === 'task-10' ? [delivered, pr(11, {})] : []
    ));
    expect(out[0]).toEqual({
      agentId: 'a', taskId: 'task-10',
      prDelivery: [{ number: 10, url: 'https://github.com/kookr-ai/kookr/pull/10', stage: 'in-staging', integrationBranch: 'staging' }],
    });
    expect(out[1]).toBe(plain);
    expect(out[2]).toEqual({ agentId: 'c' });
  });
});
