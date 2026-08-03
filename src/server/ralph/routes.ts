import type { Context, Hono } from 'hono';
import {
  DEFAULT_RALPH_ITERATION_READ_LIMIT,
  MAX_RALPH_ITERATION_READ_LIMIT,
  appendIterationRecord,
  formatIterationLogCsv,
  readIterationLog,
} from '../../core/ralph-iteration-log.js';
import { nowISO } from '../../core/interaction-log.js';
import { normalizeAgentType } from '../../core/agent-types.js';
import { LaunchPreflightError } from '../../core/launch-dependency-preflight.js';
import { resolveStallConfig } from '../../shared/contracts/ralph.js';
import { cancelTask as cancelTaskLifecycle } from '../agent-lifecycle.js';
import { launchTask, DrainModeError } from '../launch-service.js';
import {
  launchLoopedPlaybook,
  LoopedPlaybookLaunchError,
  replaceLoopedPlaybook,
} from '../use-cases/looped-playbook-launch.js';
import { createSnapshotMessage } from '../use-cases/get-snapshot.js';
import type { RouteDeps } from '../routes/shared.js';

export interface RalphRouteDeps {
  adapter: RouteDeps['adapter'];
  broadcastToAll: RouteDeps['broadcastToAll'];
  hookIngestion?: RouteDeps['hookIngestion'];
  hookWatcher: RouteDeps['hookWatcher'];
  interactionLog: RouteDeps['interactionLog'];
  launchServiceDeps: RouteDeps['launchServiceDeps'];
  monitor: RouteDeps['monitor'];
  ralphLoopService: RouteDeps['ralphLoopService'];
  serverCwd: RouteDeps['serverCwd'];
  shadowRegistry?: RouteDeps['shadowRegistry'];
  suppressionTracker?: RouteDeps['suppressionTracker'];
  taskStore: RouteDeps['taskStore'];
  tokenTracker?: RouteDeps['tokenTracker'];
  watchdog: RouteDeps['watchdog'];
}

function removedGenericRalphBody(): { error: string; code: 'generic_ralph_removed' } {
  return {
    error: 'Generic Ralph task launch and attach endpoints have been removed. Use loopable playbooks instead.',
    code: 'generic_ralph_removed',
  };
}

export function registerRalphRoutes(app: Hono, deps: RalphRouteDeps): void {
  const { taskStore, ralphLoopService, monitor, serverCwd, hookIngestion, broadcastToAll } = deps;

  app.post('/api/tasks/ralph-loop', (c) => c.json(removedGenericRalphBody(), 410));

  app.post('/api/tasks/:id/ralph-loop', (c) => c.json(removedGenericRalphBody(), 410));

  app.get('/api/tasks/:id/ralph-loop/iterations', async (c) => {
    const id = c.req.param('id');
    const task = taskStore.getTask(id);
    if (!task) return c.json({ error: 'Task not found' }, 404);
    if (!task.ralphLoop) return c.json({ error: 'task has no Ralph loop attached' }, 404);

    const rawLimit = c.req.query('limit');
    const limit = parseIterationLimit(rawLimit);

    try {
      const model = await readIterationLog(task.cwd, { limit, loop: task.ralphLoop });
      return c.json({
        taskId: task.id,
        ralphLoop: task.ralphLoop,
        effectiveStallConfig: resolveStallConfig(task.ralphLoop.stallConfig),
        ...model,
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.get('/api/tasks/:id/ralph-loop/iterations/export', async (c) => {
    const id = c.req.param('id');
    const task = taskStore.getTask(id);
    if (!task) return c.json({ error: 'Task not found' }, 404);
    if (!task.ralphLoop) return c.json({ error: 'task has no Ralph loop attached' }, 404);

    const format = c.req.query('format') ?? 'json';
    if (format !== 'json' && format !== 'csv') {
      return c.json({ error: 'format must be json or csv' }, 400);
    }

    const rawLimit = c.req.query('limit');
    const limit = parseIterationLimit(rawLimit);

    try {
      const model = await readIterationLog(task.cwd, { limit, loop: task.ralphLoop });
      const filename = `ralph-iterations-${sanitizeFilenamePart(task.id)}.${format}`;
      c.header('Content-Disposition', `attachment; filename="${filename}"`);
      if (format === 'csv') {
        c.header('Content-Type', 'text/csv; charset=utf-8');
        return c.body(formatIterationLogCsv(model));
      }
      return c.json({
        taskId: task.id,
        ralphLoop: task.ralphLoop,
        ...model,
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.get('/api/tasks/:id/ralph-loop', (c) => {
    const id = c.req.param('id');
    const task = taskStore.getTask(id);
    if (!task) return c.json({ error: 'Task not found' }, 404);
    if (!task.ralphLoop) return c.json({ error: 'task has no Ralph loop attached' }, 404);

    return c.json({
      ralphLoop: task.ralphLoop,
      effectiveStallConfig: resolveStallConfig(task.ralphLoop.stallConfig),
    });
  });

  /**
   * Modify burned-out targets, the operator unblock path for stalled loops.
   * The mutation is idempotent and emits audit events for actual state deltas.
   */
  app.patch('/api/tasks/:id/ralph-loop/burned-targets', async (c) => {
    const id = c.req.param('id');
    let body: { remove?: unknown; clear?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    if (body.remove !== undefined && !Array.isArray(body.remove)) {
      return c.json({ error: 'remove, when present, must be an array of strings' }, 400);
    }
    const remove = body.remove ?? [];
    if (!remove.every((target) => typeof target === 'string')) {
      return c.json({ error: 'remove, when present, must be an array of strings' }, 400);
    }
    const clear = body.clear === true;

    const result = await ralphLoopService.modifyBurnedTargets(id, { remove: remove as string[], clear });
    if (!result.ok) return c.json(result.body, result.status);
    if (result.changed) {
      broadcastToAll(createSnapshotMessage({ monitor, serverCwd, activityMetaProvider: hookIngestion, relationTaskStore: taskStore }));
    }
    return c.json({ ok: true, burnedOutTargets: result.value });
  });

  app.delete('/api/tasks/:id/ralph-loop', (c) => {
    const id = c.req.param('id');
    const task = taskStore.getTask(id);
    if (!task) return c.json({ error: 'Task not found' }, 404);
    if (!task.ralphLoop) return c.json({ error: 'task has no Ralph loop attached' }, 404);

    const result = ralphLoopService.cancelLoop(task);
    if (!result.ok) return c.json(result.body, result.status);
    if (result.changed) {
      broadcastToAll(createSnapshotMessage({ monitor, serverCwd, activityMetaProvider: hookIngestion, relationTaskStore: taskStore }));
    }
    return c.json({ ok: true, status: result.value });
  });

  app.post('/api/tasks/:id/ralph-loop/complete', (c) => {
    const id = c.req.param('id');
    const task = taskStore.getTask(id);
    if (!task) return c.json({ error: 'Task not found' }, 404);
    if (!task.ralphLoop) return c.json({ error: 'task has no Ralph loop attached' }, 404);

    const result = ralphLoopService.completeLoop(task);
    if (!result.ok) return c.json(result.body, result.status);
    if (result.changed) {
      broadcastToAll(createSnapshotMessage({ monitor, serverCwd, activityMetaProvider: hookIngestion, relationTaskStore: taskStore }));
    }
    return c.json({ ok: true, status: result.value });
  });

  app.patch('/api/tasks/:id/ralph-loop/prompt', async (c) => {
    const id = c.req.param('id');
    const task = taskStore.getTask(id);
    if (!task) return c.json({ error: 'Task not found' }, 404);
    if (!task.ralphLoop) return c.json({ error: 'task has no Ralph loop attached' }, 404);

    let body: { prompt?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }

    const result = await ralphLoopService.updatePrompt(task, body.prompt);
    if (!result.ok) return c.json(result.body, result.status);
    broadcastToAll(createSnapshotMessage({ monitor, serverCwd, activityMetaProvider: hookIngestion, relationTaskStore: taskStore }));
    return c.json({ ok: true, status: result.value.status, ralphLoop: result.value });
  });

  app.post('/api/tasks/:id/ralph-loop/pause', (c) => {
    const id = c.req.param('id');
    const task = taskStore.getTask(id);
    if (!task) return c.json({ error: 'Task not found' }, 404);
    if (!task.ralphLoop) return c.json({ error: 'task has no Ralph loop attached' }, 404);

    const result = ralphLoopService.pauseLoop(task);
    if (!result.ok) return c.json(result.body, result.status);
    if (result.changed) {
      broadcastToAll(createSnapshotMessage({ monitor, serverCwd, activityMetaProvider: hookIngestion, relationTaskStore: taskStore }));
    }
    return c.json({ ok: true, status: result.value.status, ralphLoop: result.value });
  });

  app.post('/api/tasks/:id/ralph-loop/resume', async (c) => {
    const id = c.req.param('id');
    const task = taskStore.getTask(id);
    if (!task) return c.json({ error: 'Task not found' }, 404);
    if (!task.ralphLoop) return c.json({ error: 'task has no Ralph loop attached' }, 404);

    const result = await ralphLoopService.resumeLoop(task);
    if (!result.ok) return c.json(result.body, result.status);
    if (result.changed) {
      broadcastToAll(createSnapshotMessage({ monitor, serverCwd, activityMetaProvider: hookIngestion, relationTaskStore: taskStore }));
    }
    return c.json({ ok: true, status: result.value.status, ralphLoop: result.value });
  });

  app.post('/api/playbooks/ralph-loop', async (c) => {
    let body: RalphPlaybookLaunchBody;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }

    const validationError = validateRalphPlaybookBody(body);
    if (validationError) return c.json({ error: validationError }, 400);
    const scope = body.scope as 'project' | 'user' | 'plugin' | undefined;

    try {
      const rawSource = c.req.header('X-Kookr-Launch-Source');
      const launchSource: 'cli' | 'ui' | 'api' =
        rawSource === 'cli' || rawSource === 'ui' ? rawSource : 'api';
      const result = await launchLoopedPlaybook({
        taskStore,
        ralphLoopService,
        launchTask: (opts, serverOpts) => launchTask(deps.launchServiceDeps, opts, serverOpts),
        getMaxActiveTasks: deps.launchServiceDeps.getMaxActiveTasks,
        cleanupFailedTask: (taskId) => cancelTaskLifecycle(taskId, lifecycleOpts(deps)),
      }, {
        ...ralphPlaybookLaunchOptions(body),
        agentType: body.agentType ? normalizeAgentType(body.agentType) : undefined,
        launchSource,
        scope,
      });

      broadcastToAll(createSnapshotMessage({ monitor, serverCwd, activityMetaProvider: hookIngestion, relationTaskStore: taskStore }));
      return c.json({ ...result.task, ...(result.queued ? { queued: true } : {}) }, 201);
    } catch (err) {
      return ralphLaunchErrorResponse(c, err);
    }
  });

  /**
   * Replace the Ralph loop attached to `:taskId` with a fresh launch using the
   * supplied playbook/cwd/parameters. The use-case owns the cancel-and-launch
   * ordering and holds its in-flight key across both steps.
   */
  app.post('/api/tasks/:taskId/ralph-loop/replace-with-new', async (c) => {
    const replacedTaskId = c.req.param('taskId');

    let body: RalphPlaybookLaunchBody;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }

    const validationError = validateRalphPlaybookBody(body);
    if (validationError) return c.json({ error: validationError }, 400);
    const scope = body.scope as 'project' | 'user' | 'plugin' | undefined;

    try {
      const rawSource = c.req.header('X-Kookr-Launch-Source');
      const launchSource: 'cli' | 'ui' | 'api' =
        rawSource === 'cli' || rawSource === 'ui' ? rawSource : 'api';

      console.info(
        `[ralph-replace] replacedTaskId=${replacedTaskId} playbook=${body.playbookPath} source=${launchSource}`,
      );

      const lifecycle = lifecycleOpts(deps);
      const { result, oldIteration } = await replaceLoopedPlaybook({
        taskStore,
        ralphLoopService,
        launchTask: (opts, serverOpts) => launchTask(deps.launchServiceDeps, opts, serverOpts),
        getMaxActiveTasks: deps.launchServiceDeps.getMaxActiveTasks,
        cleanupFailedTask: (taskId) => cancelTaskLifecycle(taskId, lifecycle),
        cancelReplacedTask: (taskId) => cancelTaskLifecycle(taskId, lifecycle),
        writeReplaceAudit: async (info) => {
          const ts = Date.now();
          await deps.interactionLog?.append({
            type: 'ralph_loop_replaced',
            replacedTaskId: info.replacedTaskId,
            newTaskId: info.newTaskId,
            oldIteration: info.oldIteration,
            playbookPath: info.playbookPath,
            cwd: info.cwd,
            source: info.source,
            timestamp: nowISO(),
          });
          // Per-task iteration-log terminal record. Without this, a loop
          // cancelled via Replace has no closing row in its iteration log.
          // Best-effort; warn-log on failure.
          try {
            await appendIterationRecord(info.cwd, {
              iterationNumber: info.oldIteration,
              startedAt: ts,
              endedAt: ts,
              exitReason: 'replaced_by_user',
              cumulativeCostUsd: null,
              gitBaselineRef: null,
              diffStats: null,
            });
          } catch (err) {
            console.warn(
              `[ralph-replace] iteration-log append failed for replacedTaskId=${info.replacedTaskId}:`,
              err,
            );
          }
        },
      }, {
        replacedTaskId,
        ...ralphPlaybookLaunchOptions(body),
        agentType: body.agentType ? normalizeAgentType(body.agentType) : undefined,
        launchSource,
        scope,
      });

      broadcastToAll(createSnapshotMessage({ monitor, serverCwd, activityMetaProvider: hookIngestion, relationTaskStore: taskStore }));
      return c.json(
        {
          ...result.task,
          ...(result.queued ? { queued: true } : {}),
          replacedTaskId,
          oldIteration,
        },
        201,
      );
    } catch (err) {
      return ralphLaunchErrorResponse(c, err);
    }
  });
}

interface RalphPlaybookLaunchBody {
  playbookPath?: unknown;
  cwd?: unknown;
  playbookSourceCwd?: unknown;
  taskTargetCwd?: unknown;
  projectId?: unknown;
  parameterValues?: unknown;
  agentType?: string;
  scope?: unknown;
}

function parseIterationLimit(rawLimit: string | undefined): number {
  if (rawLimit === undefined) return DEFAULT_RALPH_ITERATION_READ_LIMIT;
  const parsed = Number(rawLimit);
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_RALPH_ITERATION_READ_LIMIT;
  return Math.min(parsed, MAX_RALPH_ITERATION_READ_LIMIT);
}

function sanitizeFilenamePart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value).every((item) => typeof item === 'string');
}

function validatePlaybookLaunchCwdFields(body: {
  cwd?: unknown;
  playbookSourceCwd?: unknown;
  taskTargetCwd?: unknown;
}): string | null {
  const hasCwd = body.cwd !== undefined;
  const hasSource = body.playbookSourceCwd !== undefined;
  const hasTarget = body.taskTargetCwd !== undefined;

  if (hasCwd && (typeof body.cwd !== 'string' || body.cwd.trim().length === 0)) {
    return 'cwd must be a non-empty string when supplied';
  }
  if (hasSource && (typeof body.playbookSourceCwd !== 'string' || body.playbookSourceCwd.trim().length === 0)) {
    return 'playbookSourceCwd must be a non-empty string when supplied';
  }
  if (hasTarget && (typeof body.taskTargetCwd !== 'string' || body.taskTargetCwd.trim().length === 0)) {
    return 'taskTargetCwd must be a non-empty string when supplied';
  }
  if ((hasSource || hasTarget) && !(hasSource && hasTarget)) {
    return 'playbookSourceCwd and taskTargetCwd must be supplied together';
  }
  if (!hasCwd && !(hasSource && hasTarget)) {
    return 'playbookSourceCwd/taskTargetCwd or cwd is required and must be a string';
  }
  return null;
}

function validateRalphPlaybookBody(body: RalphPlaybookLaunchBody): string | null {
  if (typeof body.playbookPath !== 'string' || body.playbookPath.trim().length === 0) {
    return 'playbookPath is required and must be a string';
  }
  const cwdValidationError = validatePlaybookLaunchCwdFields(body);
  if (cwdValidationError) return cwdValidationError;
  if (!isStringRecord(body.parameterValues)) {
    return 'parameterValues is required and must be an object of strings';
  }
  if (body.projectId !== undefined && typeof body.projectId !== 'string') {
    return 'projectId must be a string';
  }
  if (body.scope !== undefined && body.scope !== 'project' && body.scope !== 'user' && body.scope !== 'plugin') {
    return 'scope must be "project", "user", or "plugin"';
  }
  return null;
}

function ralphPlaybookLaunchOptions(body: RalphPlaybookLaunchBody) {
  return {
    cwd: typeof body.cwd === 'string' ? body.cwd : undefined,
    playbookSourceCwd: typeof body.playbookSourceCwd === 'string' ? body.playbookSourceCwd : undefined,
    taskTargetCwd: typeof body.taskTargetCwd === 'string' ? body.taskTargetCwd : undefined,
    taskTargetCwdExplicit: typeof body.taskTargetCwd === 'string' && body.taskTargetCwd.trim().length > 0,
    projectId: typeof body.projectId === 'string' ? body.projectId : undefined,
    playbookPath: body.playbookPath as string,
    parameterValues: body.parameterValues as Record<string, string>,
  };
}

function lifecycleOpts(deps: RalphRouteDeps) {
  return {
    adapter: deps.adapter,
    monitor: deps.monitor,
    taskStore: deps.taskStore,
    interactionLog: deps.interactionLog,
    hookWatcher: deps.hookWatcher,
    watchdog: deps.watchdog,
    shadowRegistry: deps.shadowRegistry,
    tokenTracker: deps.tokenTracker,
    suppressionTracker: deps.suppressionTracker,
  };
}

function ralphLaunchErrorResponse(c: Context, err: unknown) {
  if (err instanceof LoopedPlaybookLaunchError) {
    return c.json({ error: err.message, ...err.details }, err.status);
  }
  if (err instanceof LaunchPreflightError) {
    return c.json({ error: err.message, code: 'launch_preflight_failed', findings: err.findings }, 409);
  }
  if (err instanceof DrainModeError) {
    // Issue #1976: same drain 503 contract as POST /api/tasks.
    c.header('Retry-After', String(err.retryAfterSeconds));
    return c.json({
      error: err.message,
      code: err.code,
      reason: err.reason,
      retryAfterSeconds: err.retryAfterSeconds,
    }, 503);
  }
  const message = err instanceof Error ? err.message : String(err);
  return c.json({ error: message }, 500);
}
