import type { Hono } from 'hono';
import type { TaskChangeFileResponse, TaskChangesResponse } from '../../shared/contracts/task-changes.js';
import { splitOwnPullRequests } from '../../shared/task-own-pull-requests.js';
import {
  defaultGitRunner,
  listTaskChanges,
  readTaskChangeFile,
  type GitRunner,
  type TaskPullRequestBase,
} from '../task-changes.js';
import { PullRequestChanges, type PullRequestRef } from '../task-changes-pr.js';
import type { TaskChangesRouteDeps } from './shared.js';

/**
 * The reading pane's Changes tab (#4024 item 4): what a task changed in its
 * working directory. The directory comes from the task record, never from the
 * request; the per-file route answers only for a path in the computed list.
 *
 * Once the worktree is gone, the tab lists the files of the task's own pull
 * request instead (slice 3), as GitHub reports them.
 */
export function registerTaskChangesRoutes(
  app: Hono,
  deps: TaskChangesRouteDeps,
  runGit: GitRunner = defaultGitRunner,
  pullRequests: PullRequestChanges = new PullRequestChanges(),
): void {
  const { taskStore } = deps;

  interface TaskContext {
    taskId: string;
    cwd: string | undefined;
    prs: TaskPullRequestBase[];
  }

  function taskContext(taskId: string): TaskContext | null {
    const task = taskStore.getTask(taskId);
    if (!task) return null;
    const cwd = task.sessions[task.sessions.length - 1]?.cwd ?? task.cwd;
    const prs = (deps.githubStateStore?.getTaskState(taskId).prs ?? [])
      .filter((pr) => pr.status !== 'closed')
      .map((pr) => ({ branch: pr.branch, baseBranch: pr.baseBranch }));
    return { taskId, cwd, prs };
  }

  /**
   * The task's own pull request that is not closed, for the fallback: the most
   * recently opened when there are several. Read only once the worktree is gone.
   */
  function ownPullRequest(taskId: string): PullRequestRef | null {
    const task = taskStore.getTask(taskId);
    if (!task) return null;
    const tracked = deps.githubStateStore?.getTaskState(taskId).prs ?? [];
    const branch = task.sessions[task.sessions.length - 1]?.gitBranch;
    const own = splitOwnPullRequests(tracked, { branch, createdAt: task.createdAt }).own
      .filter((pr) => pr.status !== 'closed');
    const openedMs = (pr: (typeof own)[number]) => (pr.createdAt === undefined ? 0 : new Date(pr.createdAt).getTime() || 0);
    const newest = own.reduce<(typeof own)[number] | null>((best, pr) => (!best || openedMs(pr) > openedMs(best) ? pr : best), null);
    if (!newest) return null;
    return {
      owner: newest.ref.owner,
      repo: newest.ref.repo,
      number: newest.ref.number,
      url: newest.ref.url,
      branch: newest.branch,
      baseBranch: newest.baseBranch,
    };
  }

  /** The pull request that stands in for a worktree that is gone (or was never recorded), if any. */
  function pullRequestFor(response: TaskChangesResponse | TaskChangeFileResponse, ctx: TaskContext): PullRequestRef | null {
    const gone = response.kind === 'unavailable' && (response.reason === 'worktree_gone' || response.reason === 'no_cwd');
    return gone ? ownPullRequest(ctx.taskId) : null;
  }

  app.get('/api/tasks/:id/changes', async (c) => {
    const ctx = taskContext(c.req.param('id'));
    if (!ctx) return c.json({ error: 'Task not found' }, 404);
    let body: TaskChangesResponse = await listTaskChanges(ctx.cwd, ctx.prs, runGit);
    const pr = pullRequestFor(body, ctx);
    if (pr) {
      // Refresh (`?fresh=1`) asks GitHub again instead of reusing a cached list.
      body = await pullRequests.list(pr, { fresh: c.req.query('fresh') === '1' })
        ?? { kind: 'unavailable', reason: 'pull_request_unreachable' };
    }
    return c.json(body);
  });

  app.get('/api/tasks/:id/changes/file', async (c) => {
    const filePath = c.req.query('path');
    if (!filePath || filePath.length > 4096 || filePath.includes('\0')) {
      return c.json({ error: 'invalid_param', field: 'path' }, 400);
    }
    const ctx = taskContext(c.req.param('id'));
    if (!ctx) return c.json({ error: 'Task not found' }, 404);
    let body: TaskChangeFileResponse | null = await readTaskChangeFile(ctx.cwd, ctx.prs, filePath, runGit);
    const pr = body ? pullRequestFor(body, ctx) : null;
    if (pr) {
      const fromPr = await pullRequests.file(pr, filePath);
      body = fromPr === undefined ? { kind: 'unavailable', reason: 'pull_request_unreachable' } : fromPr;
    }
    if (!body) return c.json({ error: 'not_in_change_list' }, 404);
    return c.json(body);
  });
}
