import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gitExecEnv } from '../../core/git-helpers.js';
import type { TaskChangesRouteDeps } from './shared.js';
import { registerTaskChangesRoutes } from './task-changes-routes.js';
import { PR_FILES_PER_PAGE, PullRequestChanges, type PullRequestFile, type PullRequestFilesPage } from '../task-changes-pr.js';

let root: string;
let repo: string;

function git(...args: string[]): void {
  execFileSync('git', args, { cwd: repo, env: gitExecEnv() });
}

function commit(rel: string, content: string): void {
  writeFileSync(path.join(repo, rel), content);
  git('add', rel);
  git('commit', '-q', '-m', rel);
}

type PrStub = { branch: string; baseBranch: string; status: string };

function mkApp(prs: PrStub[] = []): Hono {
  const tasks: Record<string, unknown> = {
    // The latest session's directory wins over the task's launch directory.
    t1: { cwd: path.join(root, 'launch-dir-not-used'), sessions: [{ cwd: path.join(root, 'old') }, { cwd: repo }] },
    t2: { cwd: undefined, sessions: [] },
  };
  const deps = {
    taskStore: { getTask: (id: string) => tasks[id] },
    githubStateStore: { getTaskState: () => ({ prs, issues: [] }) },
  } as unknown as TaskChangesRouteDeps;
  const app = new Hono();
  registerTaskChangesRoutes(app, deps);
  return app;
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'kookr-task-changes-routes-'));
  repo = path.join(root, 'repo');
  mkdirSync(repo);
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  commit('base.txt', 'one\n');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  commit('staging-only.txt', 'two\n');
  git('update-ref', 'refs/remotes/origin/staging', 'HEAD');
  git('checkout', '-q', '-b', 'feat');
  commit('feature.txt', 'three\n');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('GET /api/tasks/:id/changes', () => {
  it('lists the changes in the task\'s latest session directory', async () => {
    const res = await mkApp().request('/api/tasks/t1/changes');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      kind: 'ok',
      baseRef: 'origin/staging',
      branch: 'feat',
      repoRoot: realpathSync(repo),
      files: [{ path: 'feature.txt', status: 'added', added: 1, removed: 0 }],
      truncated: false,
    });
  });

  it('considers the base of the task\'s open PR, but not of a closed one', async () => {
    // origin/release ties with origin/staging, so an eligible PR base wins.
    git('update-ref', 'refs/remotes/origin/release', 'refs/remotes/origin/staging');
    const open = await (await mkApp([{ branch: 'feat', baseBranch: 'release', status: 'open' }]).request('/api/tasks/t1/changes')).json();
    expect(open.baseRef).toBe('origin/release');
    const closed = await (await mkApp([{ branch: 'feat', baseBranch: 'release', status: 'closed' }]).request('/api/tasks/t1/changes')).json();
    expect(closed.baseRef).toBe('origin/staging');
  });

  it('answers unavailable for a task with no directory, and 404 for an unknown task', async () => {
    const app = mkApp();
    expect(await (await app.request('/api/tasks/t2/changes')).json()).toEqual({ kind: 'unavailable', reason: 'no_cwd' });
    expect((await app.request('/api/tasks/nope/changes')).status).toBe(404);
  });
});

describe('GET /api/tasks/:id/changes/file', () => {
  it('returns the patch of a listed file', async () => {
    const res = await mkApp().request('/api/tasks/t1/changes/file?path=feature.txt');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      kind: 'patch',
      path: 'feature.txt',
      hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ['+three'] }],
    });
  });

  it('refuses a file outside the change list, a missing path and an unknown task', async () => {
    const app = mkApp();
    const outside = await app.request('/api/tasks/t1/changes/file?path=base.txt');
    expect(outside.status).toBe(404);
    expect(await outside.json()).toEqual({ error: 'not_in_change_list' });
    expect((await app.request('/api/tasks/t1/changes/file')).status).toBe(400);
    expect((await app.request('/api/tasks/nope/changes/file?path=feature.txt')).status).toBe(404);
  });
});

describe('the pull request fallback once the worktree is gone (#4024 slice 3)', () => {
  const OWN_PR = {
    ref: { owner: 'o', repo: 'r', number: 4070, url: 'https://github.com/o/r/pull/4070', detectedFrom: 'agent-1' },
    branch: 'feat-gone', baseBranch: 'main', status: 'merged', createdAt: new Date('2026-11-16T13:00:00Z'),
  };
  const PROMPT_PR = {
    ref: { owner: 'o', repo: 'r', number: 1, url: 'https://github.com/o/r/pull/1', detectedFrom: 'prompt' },
    branch: 'other', baseBranch: 'main', status: 'open', createdAt: new Date('2026-11-16T14:00:00Z'),
  };
  const FILES: PullRequestFile[] = [
    { filename: 'src/a.ts', status: 'modified', additions: 2, deletions: 1, patch: '@@ -1,1 +1,2 @@\n-old\n+new\n+more' },
    { filename: 'src/b.ts', status: 'renamed', previous_filename: 'src/old-b.ts', additions: 0, deletions: 0, patch: '' },
    { filename: 'logo.png', status: 'added', additions: 0, deletions: 0 },
    { filename: 'gone.txt', status: 'removed', additions: 0, deletions: 3, patch: '@@ -1,3 +0,0 @@\n-a\n-b\n-c' },
  ];

  function mkGoneApp(prs: unknown[], fetchPage: PullRequestFilesPage) {
    const tasks: Record<string, unknown> = {
      t1: {
        cwd: undefined,
        createdAt: new Date('2026-11-16T12:00:00Z'),
        sessions: [{ cwd: path.join(root, 'removed-worktree'), gitBranch: 'feat-gone' }],
      },
    };
    const deps = {
      taskStore: { getTask: (id: string) => tasks[id] },
      githubStateStore: { getTaskState: () => ({ prs, issues: [] }) },
    } as unknown as TaskChangesRouteDeps;
    const app = new Hono();
    registerTaskChangesRoutes(app, deps, undefined, new PullRequestChanges(fetchPage));
    return app;
  }

  it('lists the own pull request\'s files, and asks GitHub once for the list and its files', async () => {
    const fetchPage = vi.fn<PullRequestFilesPage>(async () => FILES);
    const app = mkGoneApp([PROMPT_PR, OWN_PR], fetchPage);

    expect(await (await app.request('/api/tasks/t1/changes')).json()).toEqual({
      kind: 'ok',
      source: 'pull_request',
      pullRequest: { number: 4070, url: 'https://github.com/o/r/pull/4070' },
      baseRef: 'main',
      branch: 'feat-gone',
      repoRoot: null,
      files: [
        { path: 'src/a.ts', status: 'modified', added: 2, removed: 1 },
        { path: 'src/b.ts', oldPath: 'src/old-b.ts', status: 'renamed', added: 0, removed: 0 },
        { path: 'logo.png', status: 'added', added: null, removed: null },
        { path: 'gone.txt', status: 'deleted', added: 0, removed: 3 },
      ],
      truncated: false,
    });
    expect(await (await app.request('/api/tasks/t1/changes/file?path=src%2Fa.ts')).json()).toEqual({
      kind: 'patch',
      path: 'src/a.ts',
      hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ['-old', '+new', '+more'] }],
    });
    expect(await (await app.request('/api/tasks/t1/changes/file?path=logo.png')).json()).toEqual({ kind: 'no_patch', path: 'logo.png' });
    // Only paths in the pull request's list answer.
    expect((await app.request('/api/tasks/t1/changes/file?path=etc%2Fpasswd')).status).toBe(404);
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(fetchPage.mock.calls[0]).toEqual([expect.objectContaining({ owner: 'o', repo: 'r', number: 4070 }), 1]);

    // Refresh asks GitHub again.
    await app.request('/api/tasks/t1/changes?fresh=1');
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it('pages through a long list and marks it cut at the file cap', async () => {
    const page = (n: number) => Array.from({ length: PR_FILES_PER_PAGE }, (_, i) => ({ filename: `f${n}-${i}`, status: 'added', additions: 1, deletions: 0, patch: '@@ -0,0 +1 @@\n+x' }));
    const fetchPage = vi.fn<PullRequestFilesPage>(async (_pr, n) => page(n));
    const body = await (await mkGoneApp([OWN_PR], fetchPage).request('/api/tasks/t1/changes')).json();
    expect(body.files).toHaveLength(500);
    expect(body.truncated).toBe(true);
    expect(fetchPage).toHaveBeenCalledTimes(5);

    const short = vi.fn<PullRequestFilesPage>(async (_pr, n) => (n === 1 ? page(1) : page(2).slice(0, 3)));
    const shortBody = await (await mkGoneApp([OWN_PR], short).request('/api/tasks/t1/changes')).json();
    expect(shortBody.files).toHaveLength(103);
    expect(shortBody.truncated).toBe(false);
  });

  it('says GitHub did not answer, and keeps "worktree removed" when the task has no own pull request', async () => {
    const failing = mkGoneApp([OWN_PR], async () => null);
    expect(await (await failing.request('/api/tasks/t1/changes')).json()).toEqual({ kind: 'unavailable', reason: 'pull_request_unreachable' });
    expect(await (await failing.request('/api/tasks/t1/changes/file?path=src%2Fa.ts')).json()).toEqual({ kind: 'unavailable', reason: 'pull_request_unreachable' });

    const fetchPage = vi.fn<PullRequestFilesPage>(async () => FILES);
    const promptOnly = mkGoneApp([PROMPT_PR, { ...OWN_PR, status: 'closed' }], fetchPage);
    expect(await (await promptOnly.request('/api/tasks/t1/changes')).json()).toEqual({ kind: 'unavailable', reason: 'worktree_gone' });
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it('never asks GitHub while the worktree exists', async () => {
    const fetchPage = vi.fn<PullRequestFilesPage>(async () => FILES);
    const tasks: Record<string, unknown> = { t1: { createdAt: new Date('2026-11-16T12:00:00Z'), sessions: [{ cwd: repo, gitBranch: 'feat-gone' }] } };
    const deps = {
      taskStore: { getTask: (id: string) => tasks[id] },
      githubStateStore: { getTaskState: () => ({ prs: [OWN_PR], issues: [] }) },
    } as unknown as TaskChangesRouteDeps;
    const app = new Hono();
    registerTaskChangesRoutes(app, deps, undefined, new PullRequestChanges(fetchPage));
    const body = await (await app.request('/api/tasks/t1/changes')).json();
    expect(body.source).toBeUndefined();
    expect(fetchPage).not.toHaveBeenCalled();
  });
});
