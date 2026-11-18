/**
 * Interrupted-task batches (issue #4215).
 *
 *  - `GET  /api/interrupted-tasks`                    the pending batch and recent decided ones
 *  - `POST /api/interrupted-tasks/ask`                `{ taskIds }`: park already-stopped tasks in a
 *                                                     batch and ask the operator (for tasks a restart
 *                                                     stopped before this feature, or that the
 *                                                     watchdog reaped after a failed relaunch)
 *  - `POST /api/interrupted-tasks/:batchId/decide`    `{ choice: resume | resume_all | leave }`
 *
 * The two POSTs relaunch agents, so they are supervisor-gated like
 * `POST /api/tasks/:id/reopen`.
 */
import type { Context, Hono } from 'hono';
import type { TaskStore } from '../../core/tasks.js';
import { isTerminalStatus } from '../../core/task-status.js';
import { SUPERVISOR_AUTH_HEADER } from '../../shared/contracts/supervisor-actions.js';
import { isAuthorizedSupervisorRequest } from '../supervisor-auth.js';
import { describeReopenResume } from '../resume-context.js';
import type {
  InterruptedBatchChoice,
  InterruptedTaskEntry,
  InterruptedTasksService,
} from '../interrupted-tasks/interrupted-tasks-service.js';

export interface InterruptedTasksRouteDeps {
  service: Pick<InterruptedTasksService, 'list' | 'park' | 'decide'>;
  taskStore: Pick<TaskStore, 'getTask'>;
}

const CHOICES: ReadonlySet<string> = new Set<InterruptedBatchChoice>(['resume', 'resume_all', 'leave']);
const MAX_TASK_IDS = 50;

function unauthorized(c: Context) {
  c.header('WWW-Authenticate', 'Bearer');
  return c.json({ error: 'supervisor-unauthorized' }, 401);
}

export function registerInterruptedTasksRoutes(app: Hono, deps: InterruptedTasksRouteDeps): void {
  app.get('/api/interrupted-tasks', (c) => c.json({ batches: deps.service.list() }));

  app.post('/api/interrupted-tasks/ask', async (c) => {
    if (!isAuthorizedSupervisorRequest(c.req.header(SUPERVISOR_AUTH_HEADER))) return unauthorized(c);
    const body = await c.req.json().catch(() => undefined) as { taskIds?: unknown } | undefined;
    const ids = body?.taskIds;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_TASK_IDS || !ids.every((id) => typeof id === 'string' && id.length > 0)) {
      return c.json({ error: `taskIds must be 1..${MAX_TASK_IDS} task ids` }, 400);
    }
    const entries: InterruptedTaskEntry[] = [];
    const refused: Array<{ taskId: string; reason: string }> = [];
    for (const id of new Set(ids as string[])) {
      const task = deps.taskStore.getTask(id);
      if (!task) {
        refused.push({ taskId: id, reason: 'not found' });
        continue;
      }
      if (!isTerminalStatus(task.status)) {
        refused.push({ taskId: id, reason: `task is ${task.status}, not stopped` });
        continue;
      }
      const report = await describeReopenResume(task, { activeRalphLoop: false });
      entries.push({
        taskId: task.id,
        name: task.name ?? task.id,
        mode: report.mode === 'resume' ? 'resume' : 'fresh',
        ...(report.mode !== 'resume' ? { reason: report.reason } : {}),
      });
    }
    if (entries.length === 0) return c.json({ error: 'no task can be parked', refused }, 409);
    const batch = await deps.service.park(entries, 'operator');
    return c.json({ batch, refused });
  });

  app.post('/api/interrupted-tasks/:batchId/decide', async (c) => {
    if (!isAuthorizedSupervisorRequest(c.req.header(SUPERVISOR_AUTH_HEADER))) return unauthorized(c);
    const body = await c.req.json().catch(() => undefined) as { choice?: unknown } | undefined;
    const choice = body?.choice;
    if (typeof choice !== 'string' || !CHOICES.has(choice)) {
      return c.json({ error: 'choice must be one of resume, resume_all, leave' }, 400);
    }
    const batch = await deps.service.decide(c.req.param('batchId'), choice as InterruptedBatchChoice, 'operator');
    if (!batch) return c.json({ error: 'no pending batch with that id' }, 404);
    return c.json({ batch });
  });
}
