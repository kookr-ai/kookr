import type { Hono } from 'hono';
import { normalizeAgentType } from '../../core/agent-types.js';
import {
  DEFAULT_RALPH_ITERATION_READ_LIMIT,
  MAX_RALPH_ITERATION_READ_LIMIT,
  appendIterationRecord,
  formatIterationLogCsv,
  readIterationLog,
} from '../../core/ralph-iteration-log.js';
import { canonicalizeTarget } from '../../core/ralph-iteration-verdict.js';
import { LaunchPreflightError } from '../../core/launch-dependency-preflight.js';
import { resolveStallConfig } from '../../shared/contracts/ralph.js';
import { nowISO } from '../../core/interaction-log.js';
import { cancelTask as cancelTaskLifecycle } from '../agent-lifecycle.js';
import { launchTask } from '../launch-service.js';
import {
  launchLoopedPlaybook,
  LoopedPlaybookLaunchError,
  replaceLoopedPlaybook,
} from '../use-cases/looped-playbook-launch.js';
import { createSnapshotMessage } from '../use-cases/get-snapshot.js';
import type { RouteDeps } from '../routes/shared.js';

export type RalphRouteDeps = Pick<
  RouteDeps,
  | 'taskStore'
  | 'monitor'
  | 'adapter'
  | 'hookWatcher'
  | 'watchdog'
  | 'interactionLog'
  | 'broadcastToAll'
  | 'serverCwd'
  | 'hookIngestion'
  | 'ralphLoopService'
  | 'launchServiceDeps'
  | 'shadowRegistry'
  | 'tokenTracker'
  | 'suppressionTracker'
>;

function removedGenericRalphBody(): { error: string; code: 'generic_ralph_removed' } {
  return {
    error: 'Generic Ralph task launch and attach endpoints have been removed. Use loopable playbooks instead.',
    code: 'generic_ralph_removed',
  };
}

export function registerRalphRoutes(app: Hono, deps: RalphRouteDeps): void {
  const { taskStore, monitor, adapter, hookWatcher, watchdog, interactionLog, broadcastToAll, serverCwd, hookIngestion } = deps;
  const { ralphLoopService } = deps;

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
        // Resolve stallConfig defaults so the frontend doesn't need to know
        // the engine's defaults; operators see the actual values the cycler
        // uses. Same shape as GET /ralph-loop's `effectiveStallConfig`.
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

  /**
   * Read-only inspection of the Ralph loop state, with effective stallConfig
   * (defaults merged) so operators see the values the engine actually uses.
   * No JSONL access; call /iterations for history. See rfc §8.
   */
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
   * Modify burned-out targets. Operator unblock path. Idempotent. Every
   * mutation fires a `ralph_burned_targets_modified` interaction-log event
   * for audit. See rfc §8.
   */
  app.patch('/api/tasks/:id/ralph-loop/burned-targets', async (c) => {
    const id = c.req.param('id');
    const task = taskStore.getTask(id);
    if (!task) return c.json({ error: 'Task not found' }, 404);
    const loop = task.ralphLoop;
    if (!loop) return c.json({ error: 'task has no Ralph loop attached' }, 404);

    let body: { remove?: unknown; clear?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }

    const remove = Array.isArray(body.remove) ? body.remove : [];
    if (!remove.every((t) => typeof t === 'string')) {
      return c.json({ error: 'remove, when present, must be an array of strings' }, 400);
    }
    const clear = body.clear === true;

    if (remove.length === 0 && !clear) {
      return c.json({ ok: true, burnedOutTargets: loop.burnedOutTargets ?? [] });
    }

    const previous = (loop.burnedOutTargets ?? []).map((t) => ({ ...t }));

    if (clear) {
      loop.burnedOutTargets = [];
    } else {
      const removeSet = new Set(remove.map((t) => canonicalizeTarget(t as string)));
      loop.burnedOutTargets = (loop.burnedOutTargets ?? []).filter((t) => !removeSet.has(t.target));
    }

    const remaining = new Set((loop.burnedOutTargets ?? []).map((t) => t.target));
    const actuallyRemoved = previous
      .filter((t) => !remaining.has(t.target));

    if (interactionLog) {
      const ts = new Date().toISOString();
      try {
        await interactionLog.append({
          type: 'ralph_burned_targets_modified',
          taskId: id,
          removed: actuallyRemoved.map((t) => t.target),
          cleared: clear,
          previousBurnedOutTargets: previous,
          timestamp: ts,
        });
      } catch (err) {
        console.warn(`[ralph-routes] ralph_burned_targets_modified audit append failed for task ${id}:`, err);
      }
      const iter = loop.currentIteration;
      for (const t of actuallyRemoved) {
        if (!t.burned) continue;
        void interactionLog.append({
          type: 'ralph_target_unburned',
          taskId: id,
          target: t.target,
          iteration: iter,
          via: 'patch_burned_targets',
          timestamp: ts,
        }).catch(() => undefined);
      }
    }

    task.updatedAt = new Date();
    broadcastToAll(createSnapshotMessage({ monitor, serverCwd, activityMetaProvider: hookIngestion }));
    return c.json({ ok: true, burnedOutTargets: loop.burnedOutTargets });
  });

  /**
   * Cancel a Ralph loop attached to a task. Sets `status: 'cancelled'` so the
   * cycler stops launching iterations on the next Stop event. Idempotent.
   */
  app.delete('/api/tasks/:id/ralph-loop', (c) => {
    const id = c.req.param('id');
    const task = taskStore.getTask(id);
    if (!task) return c.json({ error: 'Task not found' }, 404);
    if (!task.ralphLoop) return c.json({ error: 'task has no Ralph loop attached' }, 404);

    const result = ralphLoopService.cancelLoop(task);
    if (!result.ok) return c.json(result.body, result.status);
    if (result.changed) {
      broadcastToAll(createSnapshotMessage({ monitor, serverCwd, activityMetaProvider: hookIngestion }));
    }
    return c.json({ ok: true, status: task.ralphLoop.status });
  });

  /**
   * Mark a Ralph loop as successfully complete while leaving the owner agent
   * alive long enough to write its final answer.
   */
  app.post('/api/tasks/:id/ralph-loop/complete', (c) => {
    const id = c.req.param('id');
    const task = taskStore.getTask(id);
    if (!task) return c.json({ error: 'Task not found' }, 404);
    if (!task.ralphLoop) return c.json({ error: 'task has no Ralph loop attached' }, 404);

    const result = ralphLoopService.completeLoop(task);
    if (!result.ok) return c.json(result.body, result.status);
    if (result.changed) {
      broadcastToAll(createSnapshotMessage({ monitor, serverCwd, activityMetaProvider: hookIngestion }));
    }
    return c.json({ ok: true, status: task.ralphLoop.status });
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
    broadcastToAll(createSnapshotMessage({ monitor, serverCwd, activityMetaProvider: hookIngestion }));
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
      broadcastToAll(createSnapshotMessage({ monitor, serverCwd, activityMetaProvider: hookIngestion }));
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
      broadcastToAll(createSnapshotMessage({ monitor, serverCwd, activityMetaProvider: hookIngestion }));
    }
    return c.json({ ok: true, status: result.value.status, ralphLoop: result.value });
  });

  app.post('/api/playbooks/ralph-loop', async (c) => {
    let body: {
      playbookPath?: unknown;
      cwd?: unknown;
      playbookSourceCwd?: unknown;
      taskTargetCwd?: unknown;
      projectId?: unknown;
      parameterValues?: unknown;
      agentType?: string;
      scope?: unknown;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }

    if (typeof body.playbookPath !== 'string' || body.playbookPath.trim().length === 0) {
      return c.json({ error: 'playbookPath is required and must be a string' }, 400);
    }
    const cwdValidationError = validatePlaybookLaunchCwdFields(body);
    if (cwdValidationError) {
      return c.json({ error: cwdValidationError }, 400);
    }
    if (!isStringRecord(body.parameterValues)) {
      return c.json({ error: 'parameterValues is required and must be an object of strings' }, 400);
    }
    if (body.projectId !== undefined && typeof body.projectId !== 'string') {
      return c.json({ error: 'projectId must be a string' }, 400);
    }
    if (body.scope !== undefined && body.scope !== 'project' && body.scope !== 'user' && body.scope !== 'plugin') {
      return c.json({ error: 'scope must be "project", "user", or "plugin"' }, 400);
    }
    const scope = body.scope as 'project' | 'user' | 'plugin' | undefined;

    try {
      const rawSource = c.req.header('X-Kookr-Launch-Source');
      const launchSource: 'cli' | 'ui' | 'api' =
        rawSource === 'cli' || rawSource === 'ui' ? rawSource : 'api';
      const result = await launchLoopedPlaybook({
        taskStore,
        ralphLoopService,
        launchTask: (opts) => launchTask(deps.launchServiceDeps, opts),
        getMaxActiveTasks: deps.launchServiceDeps.getMaxActiveTasks,
        cleanupFailedTask: (taskId) => cancelTaskLifecycle(taskId, {
          adapter,
          monitor,
          taskStore,
          interactionLog,
          hookWatcher,
          watchdog,
          shadowRegistry: deps.shadowRegistry,
          tokenTracker: deps.tokenTracker,
          suppressionTracker: deps.suppressionTracker,
        }),
      }, {
        cwd: typeof body.cwd === 'string' ? body.cwd : undefined,
        playbookSourceCwd: typeof body.playbookSourceCwd === 'string' ? body.playbookSourceCwd : undefined,
        taskTargetCwd: typeof body.taskTargetCwd === 'string' ? body.taskTargetCwd : undefined,
        taskTargetCwdExplicit: typeof body.taskTargetCwd === 'string' && body.taskTargetCwd.trim().length > 0,
        projectId: typeof body.projectId === 'string' ? body.projectId : undefined,
        playbookPath: body.playbookPath,
        parameterValues: body.parameterValues,
        agentType: body.agentType ? normalizeAgentType(body.agentType) : undefined,
        launchSource,
        scope,
      });

      broadcastToAll(createSnapshotMessage({ monitor, serverCwd, activityMetaProvider: hookIngestion }));
      return c.json({ ...result.task, ...(result.queued ? { queued: true } : {}) }, 201);
    } catch (err) {
      if (err instanceof LoopedPlaybookLaunchError) {
        return c.json({ error: err.message, ...err.details }, err.status);
      }
      if (err instanceof LaunchPreflightError) {
        return c.json({ error: err.message, code: 'launch_preflight_failed', findings: err.findings }, 409);
      }
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  /**
   * Replace the Ralph loop attached to `:taskId` with a fresh launch using
   * the supplied playbook+cwd+parameters. Cancels the old runtime + loop,
   * then launches anew. The in-flight key is held across both steps so
   * concurrent calls with the same key serialize.
   *
   * See docs/rfc/rfc-ralph-loop-crash-restart-recovery.md.
   */
  app.post('/api/tasks/:taskId/ralph-loop/replace-with-new', async (c) => {
    const replacedTaskId = c.req.param('taskId');

    let body: {
      playbookPath?: unknown;
      cwd?: unknown;
      playbookSourceCwd?: unknown;
      taskTargetCwd?: unknown;
      projectId?: unknown;
      parameterValues?: unknown;
      agentType?: string;
      scope?: unknown;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }

    if (typeof body.playbookPath !== 'string' || body.playbookPath.trim().length === 0) {
      return c.json({ error: 'playbookPath is required and must be a string' }, 400);
    }
    const cwdValidationError = validatePlaybookLaunchCwdFields(body);
    if (cwdValidationError) {
      return c.json({ error: cwdValidationError }, 400);
    }
    if (!isStringRecord(body.parameterValues)) {
      return c.json({ error: 'parameterValues is required and must be an object of strings' }, 400);
    }
    if (body.projectId !== undefined && typeof body.projectId !== 'string') {
      return c.json({ error: 'projectId must be a string' }, 400);
    }
    if (body.scope !== undefined && body.scope !== 'project' && body.scope !== 'user' && body.scope !== 'plugin') {
      return c.json({ error: 'scope must be "project", "user", or "plugin"' }, 400);
    }
    const scope = body.scope as 'project' | 'user' | 'plugin' | undefined;

    try {
      const rawSource = c.req.header('X-Kookr-Launch-Source');
      const launchSource: 'cli' | 'ui' | 'api' =
        rawSource === 'cli' || rawSource === 'ui' ? rawSource : 'api';

      console.info(
        `[ralph-replace] replacedTaskId=${replacedTaskId} playbook=${body.playbookPath} source=${launchSource}`,
      );

      const lifecycleOpts = {
        adapter,
        monitor,
        taskStore,
        interactionLog,
        hookWatcher,
        watchdog,
        shadowRegistry: deps.shadowRegistry,
        tokenTracker: deps.tokenTracker,
        suppressionTracker: deps.suppressionTracker,
      };

      const { result, oldIteration } = await replaceLoopedPlaybook({
        taskStore,
        ralphLoopService,
        launchTask: (opts) => launchTask(deps.launchServiceDeps, opts),
        getMaxActiveTasks: deps.launchServiceDeps.getMaxActiveTasks,
        cleanupFailedTask: (taskId) => cancelTaskLifecycle(taskId, lifecycleOpts),
        cancelReplacedTask: (taskId) => cancelTaskLifecycle(taskId, lifecycleOpts),
        writeReplaceAudit: async (info) => {
          const ts = Date.now();
          await interactionLog?.append({
            type: 'ralph_loop_replaced',
            replacedTaskId: info.replacedTaskId,
            newTaskId: info.newTaskId,
            oldIteration: info.oldIteration,
            playbookPath: info.playbookPath,
            cwd: info.cwd,
            source: info.source,
            timestamp: nowISO(),
          });
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
        cwd: typeof body.cwd === 'string' ? body.cwd : undefined,
        playbookSourceCwd: typeof body.playbookSourceCwd === 'string' ? body.playbookSourceCwd : undefined,
        taskTargetCwd: typeof body.taskTargetCwd === 'string' ? body.taskTargetCwd : undefined,
        taskTargetCwdExplicit: typeof body.taskTargetCwd === 'string' && body.taskTargetCwd.trim().length > 0,
        projectId: typeof body.projectId === 'string' ? body.projectId : undefined,
        playbookPath: body.playbookPath,
        parameterValues: body.parameterValues,
        agentType: body.agentType ? normalizeAgentType(body.agentType) : undefined,
        launchSource,
        scope,
      });

      broadcastToAll(createSnapshotMessage({ monitor, serverCwd, activityMetaProvider: hookIngestion }));
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
      if (err instanceof LoopedPlaybookLaunchError) {
        return c.json({ error: err.message, ...err.details }, err.status);
      }
      if (err instanceof LaunchPreflightError) {
        return c.json({ error: err.message, code: 'launch_preflight_failed', findings: err.findings }, 409);
      }
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });
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
