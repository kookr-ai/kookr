import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitExecEnv } from '../../core/git-helpers.js';
import type { TaskChangesRouteDeps } from './shared.js';
import { registerTaskChangesRoutes } from './task-changes-routes.js';

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
