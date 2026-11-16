import type { Hono } from 'hono';
import type { TaskChangeFileResponse, TaskChangesResponse } from '../../shared/contracts/task-changes.js';
import {
  defaultGitRunner,
  listTaskChanges,
  readTaskChangeFile,
  type GitRunner,
  type TaskPullRequestBase,
} from '../task-changes.js';
import type { TaskChangesRouteDeps } from './shared.js';

/**
 * The reading pane's Changes tab (#4024 item 4): what a task changed in its
 * working directory. The directory comes from the task record, never from the
 * request; the per-file route answers only for a path in the computed list.
 */
export function registerTaskChangesRoutes(app: Hono, deps: TaskChangesRouteDeps, runGit: GitRunner = defaultGitRunner): void {
  const { taskStore } = deps;

  function taskContext(taskId: string): { cwd: string | undefined; prs: TaskPullRequestBase[] } | null {
    const task = taskStore.getTask(taskId);
    if (!task) return null;
    const cwd = task.sessions[task.sessions.length - 1]?.cwd ?? task.cwd;
    const prs = (deps.githubStateStore?.getTaskState(taskId).prs ?? [])
      .filter((pr) => pr.status !== 'closed')
      .map((pr) => ({ branch: pr.branch, baseBranch: pr.baseBranch }));
    return { cwd, prs };
  }

  app.get('/api/tasks/:id/changes', async (c) => {
    const ctx = taskContext(c.req.param('id'));
    if (!ctx) return c.json({ error: 'Task not found' }, 404);
    const body: TaskChangesResponse = await listTaskChanges(ctx.cwd, ctx.prs, runGit);
    return c.json(body);
  });

  app.get('/api/tasks/:id/changes/file', async (c) => {
    const filePath = c.req.query('path');
    if (!filePath || filePath.length > 4096 || filePath.includes('\0')) {
      return c.json({ error: 'invalid_param', field: 'path' }, 400);
    }
    const ctx = taskContext(c.req.param('id'));
    if (!ctx) return c.json({ error: 'Task not found' }, 404);
    const body: TaskChangeFileResponse | null = await readTaskChangeFile(ctx.cwd, ctx.prs, filePath, runGit);
    if (!body) return c.json({ error: 'not_in_change_list' }, 404);
    return c.json(body);
  });
}
