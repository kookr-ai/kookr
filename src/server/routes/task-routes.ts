import type { Hono } from 'hono';
import { discoverPlaybooks } from '../../core/playbook-discovery.js';
import { normalizeAgentType } from '../../core/agent-types.js';
import { CodexRolloutScanner } from '../../adapters/codex-rollout-scanner.js';
import { aggregate as aggregateCostComparison } from '../../core/cost-comparison-aggregator.js';
import type { CostAgent, TimeWindow } from '../../shared/contracts/cost-comparison.js';
import { createSnapshotMessage, getSnapshotAgentsRaw } from '../use-cases/get-snapshot.js';
import { sendDirectAgentInput } from '../use-cases/agent-input.js';
import { deleteTask } from '../use-cases/delete-task.js';
import { launchTask } from '../launch-service.js';
import { cancelTask as cancelTaskLifecycle } from '../agent-lifecycle.js';
import { detectStandalonePlugin } from '../../core/ralph-plugin-coexistence.js';
import { DEFAULT_RALPH_ITERATION_READ_LIMIT, MAX_RALPH_ITERATION_READ_LIMIT, appendIterationRecord, formatIterationLogCsv, readIterationLog } from '../../core/ralph-iteration-log.js';
import { validateRalphLoopRequest } from '../ralph-loop-service.js';
import { canonicalizeTarget } from '../../core/ralph-iteration-verdict.js';
import { resolveStallConfig } from '../../shared/contracts/ralph.js';
import {
  launchLoopedPlaybook,
  LoopedPlaybookLaunchError,
  replaceLoopedPlaybook,
} from '../use-cases/looped-playbook-launch.js';
import { nowISO } from '../../core/interaction-log.js';
import type { RouteDeps } from './shared.js';

/** Shape of the /api/agents/:id/edit-events/:toolUseId response.
 *  See docs/rfc/rfc-activity-panel-ux.md §3. */
type EditEventResponse =
  | { kind: 'edit'; filePath: string; structuredPatch: unknown; oldString: string; newString: string; serverStartedAt: string }
  | { kind: 'write'; filePath: string; structuredPatch: unknown; originalFile: string; serverStartedAt: string }
  | { kind: 'unsupported'; serverStartedAt: string };

type EditEventMiss =
  | { error: 'not_found'; reason: 'agent_unknown'; serverStartedAt: string }
  | { error: 'not_found'; reason: 'event_not_found'; serverStartedAt: string }
  | { error: 'invalid_param'; field: string };

/** Regex used to validate the `:agentId` and `:toolUseId` path params. Length
 *  is capped so oversize inputs 400 before any lookup work. */
const EDIT_EVENT_PARAM_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** Same shape as EDIT_EVENT_PARAM_RE — reused for session id params that must
 *  not carry path-separator characters. Defense in depth against any future
 *  adapter that might construct a filesystem path from the id. */
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function registerTaskRoutes(app: Hono, deps: RouteDeps): void {
  const { taskStore, monitor, adapter, hookWatcher, watchdog, interactionLog, broadcastToAll, serverCwd, serverStartedAt } = deps;
  const { ralphLoopService } = deps;

  app.get('/api/tasks', (c) => {
    const tasks = taskStore.listTasks();
    if (!deps.suppressionTracker) return c.json(tasks);
    const tracker = deps.suppressionTracker;
    return c.json(tasks.map((t) => {
      const hasSuppressedSession = t.sessions.some(
        (s) => s.lastStatus !== 'completed' && s.lastStatus !== 'aborted' && tracker.isSuppressed(s.tmuxSession),
      );
      return hasSuppressedSession ? { ...t, suppressed: true } : t;
    }));
  });

  app.post('/api/tasks', async (c) => {
    try {
      const body = await c.req.json() as {
        prompt?: string;
        cwd?: string;
        criteria?: string;
        parentTaskId?: string;
        autonomy?: string;
        agentType?: string;
      };

      if (!body.prompt || typeof body.prompt !== 'string') {
        return c.json({ error: 'prompt is required and must be a string' }, 400);
      }
      if (!body.cwd || typeof body.cwd !== 'string') {
        return c.json({ error: 'cwd is required and must be a string' }, 400);
      }
      if (body.parentTaskId !== undefined) {
        if (typeof body.parentTaskId !== 'string') {
          return c.json({ error: 'parentTaskId must be a string' }, 400);
        }
        if (!taskStore.getTask(body.parentTaskId)) {
          return c.json({ error: `Parent task not found: ${body.parentTaskId}` }, 404);
        }
      }

      const autonomy = body.autonomy === 'autonomous' ? 'autonomous' as const : undefined;
      const rawSource = c.req.header('X-Kookr-Launch-Source');
      const launchSource: 'cli' | 'ui' | 'api' =
        rawSource === 'cli' || rawSource === 'ui' ? rawSource : 'api';
      const { task, queued, duplicate } = await launchTask(deps.launchServiceDeps, {
        prompt: body.prompt,
        cwd: body.cwd,
        criteria: body.criteria,
        parentTaskId: body.parentTaskId,
        autonomy,
        agentType: body.agentType ? normalizeAgentType(body.agentType) : undefined,
        launchSource,
      });

      if (duplicate) {
        return c.json({ task, duplicate: true }, 200);
      }

      broadcastToAll(createSnapshotMessage({ monitor, serverCwd }));
      return c.json({ ...task, ...(queued ? { queued: true } : {}) }, 201);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  app.post('/api/tasks/ralph-loop', async (c) => {
    let body: {
      prompt?: unknown;
      cwd?: unknown;
      criteria?: string;
      parentTaskId?: unknown;
      autonomy?: string;
      agentType?: string;
      iterationCap?: unknown;
      stopPredicate?: unknown;
      stallPredicate?: unknown;
      zeroDiffConvergence?: unknown;
      costCapUsd?: unknown;
      stallConfig?: unknown;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }

    if (typeof body.cwd !== 'string' || body.cwd.trim().length === 0) {
      return c.json({ error: 'cwd is required and must be a string' }, 400);
    }
    if (body.parentTaskId !== undefined) {
      if (typeof body.parentTaskId !== 'string') {
        return c.json({ error: 'parentTaskId must be a string' }, 400);
      }
      if (!taskStore.getTask(body.parentTaskId)) {
        return c.json({ error: `Parent task not found: ${body.parentTaskId}` }, 404);
      }
    }

    const ralphInput = validateRalphLoopRequest(body);
    if (!ralphInput.ok) return c.json({ error: ralphInput.error }, 400);

    const coexistence = await detectStandalonePlugin(body.cwd);
    if (coexistence.detected) {
      return c.json({
        error: 'standalone ralph-wiggum plugin detected — would double-fire on Stop',
        conflictKind: 'standalone_ralph_plugin',
        code: 'standalone_ralph_plugin_detected',
        matchedFiles: coexistence.matchedFiles,
        reasons: coexistence.reasons,
      }, 409);
    }

    try {
      const rawSource = c.req.header('X-Kookr-Launch-Source');
      const launchSource: 'cli' | 'ui' | 'api' =
        rawSource === 'cli' || rawSource === 'ui' ? rawSource : 'api';
      const autonomy = body.autonomy === 'autonomous' ? 'autonomous' as const : undefined;
      const result = await launchTask(deps.launchServiceDeps, {
        prompt: ralphInput.value.prompt,
        cwd: body.cwd,
        criteria: body.criteria,
        parentTaskId: body.parentTaskId,
        autonomy,
        agentType: body.agentType ? normalizeAgentType(body.agentType) : undefined,
        launchSource,
        disableDedup: true,
        // PR4: inject RALPH_VERDICT_FILE on the first agent runtime so
        // iteration 0 can write a verdict — the launchFreshRuntime path used
        // for iterations 1+ already does this; this closes the gap.
        ralphVerdictEnv: true,
      });

      if (result.duplicate) {
        return c.json({ error: 'Ralph task launch unexpectedly resolved to an existing task; no loop was attached' }, 409);
      }
      // PR4: refuse to attach a Ralph loop to a queued task. Promotion via
      // `promotePendingTasks` calls adapter.launch with no extraEnv, so a
      // queued ralph launch would silently lose `RALPH_VERDICT_FILE` on
      // iteration 0 — the very bug PR4 is fixing for fresh launches. Mirrors
      // the equivalent rejection in `looped-playbook-launch.ts`.
      if (result.queued) {
        return c.json({
          error: 'Ralph task launch was queued (max active tasks reached). Retry when concurrency frees up.',
          taskId: result.task.id,
          status: 'pending',
        }, 503);
      }

      await ralphLoopService.startLoop(result.task, ralphInput.value);
      broadcastToAll(createSnapshotMessage({ monitor, serverCwd }));
      return c.json({ ...result.task }, 201);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  /**
   * Attach a Ralph iteration loop to an existing task.
   *
   * Refuses (409) when:
   *   - the task already has an active loop (would shadow on the next Stop)
   *   - the standalone `ralph-wiggum@*` Claude Code plugin is enabled in any
   *     settings file (would double-fire on the same Stop event)
   *
   * Requires (400) when:
   *   - prompt is missing, empty, or non-string
   *   - iterationCap is missing, non-integer, or non-positive
   *   - stopPredicate (when present) is non-string
   *   - stallPredicate (when present) is non-string
   *   - zeroDiffConvergence.consecutiveIterations (when present) is not a positive integer
   *   - costCapUsd (when present) is not a positive finite number
   *   - stallConfig (when present) has invalid fields — see `validateRalphLoopRequest`
   */
  app.post('/api/tasks/:id/ralph-loop', async (c) => {
    const id = c.req.param('id');
    const task = taskStore.getTask(id);
    if (!task) return c.json({ error: 'Task not found' }, 404);

    let body: {
      prompt?: unknown;
      iterationCap?: unknown;
      stopPredicate?: unknown;
      stallPredicate?: unknown;
      zeroDiffConvergence?: unknown;
      costCapUsd?: unknown;
      stallConfig?: unknown;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }

    const ralphInput = validateRalphLoopRequest(body);
    if (!ralphInput.ok) return c.json({ error: ralphInput.error }, 400);

    const coexistence = await detectStandalonePlugin(task.cwd);
    if (coexistence.detected) {
      return c.json({
        error: 'standalone ralph-wiggum plugin detected — would double-fire on Stop',
        conflictKind: 'standalone_ralph_plugin',
        code: 'standalone_ralph_plugin_detected',
        matchedFiles: coexistence.matchedFiles,
        reasons: coexistence.reasons,
      }, 409);
    }

    const result = await ralphLoopService.attachLoop(task, ralphInput.value);
    if (!result.ok) return c.json(result.body, result.status);
    broadcastToAll(createSnapshotMessage({ monitor, serverCwd }));
    return c.json({ ok: true, ralphLoop: task.ralphLoop });
  });

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
        // the engine's defaults — operators see the actual values the cycler
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
   * No JSONL access — call /iterations for history. See rfc §8.
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
   * Modify burned-out targets — operator unblock path. Idempotent. Every
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
      // Empty no-op: return current state without firing an audit event.
      return c.json({ ok: true, burnedOutTargets: loop.burnedOutTargets ?? [] });
    }

    // Snapshot the FULL prior shape so the audit log can reproduce state if
    // the operator needs to roll back manually.
    const previous = (loop.burnedOutTargets ?? []).map((t) => ({ ...t }));

    if (clear) {
      loop.burnedOutTargets = [];
    } else {
      const removeSet = new Set(remove.map((t) => canonicalizeTarget(t as string)));
      loop.burnedOutTargets = (loop.burnedOutTargets ?? []).filter((t) => !removeSet.has(t.target));
    }

    // `removed` is the actual delta of canonicalized targets that left the
    // burned list, not the operator's input. Operators may submit unknown or
    // already-clean targets; the audit should reflect what changed.
    const remaining = new Set((loop.burnedOutTargets ?? []).map((t) => t.target));
    const actuallyRemoved = previous
      .filter((t) => !remaining.has(t.target));

    // Audit trail (operability §9). Awaited so the on-disk record order
    // matches mutation order; a concurrent PATCH cannot interleave its
    // append before this one. Best-effort failure: log but don't fail the
    // operator's mutation, which is already committed in memory.
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
        console.warn(`[task-routes] ralph_burned_targets_modified audit append failed for task ${id}:`, err);
      }
      // Per-target ralph_target_unburned (RFC §9): one event per *burned*
      // target the PATCH actually removed. Pre-burn rows aren't unburns.
      // Mirrors the cycler's contract for progress_verdict / decay un-burns.
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
    broadcastToAll(createSnapshotMessage({ monitor, serverCwd }));
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
      broadcastToAll(createSnapshotMessage({ monitor, serverCwd }));
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
      broadcastToAll(createSnapshotMessage({ monitor, serverCwd }));
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
    broadcastToAll(createSnapshotMessage({ monitor, serverCwd }));
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
      broadcastToAll(createSnapshotMessage({ monitor, serverCwd }));
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
      broadcastToAll(createSnapshotMessage({ monitor, serverCwd }));
    }
    return c.json({ ok: true, status: result.value.status, ralphLoop: result.value });
  });

  app.delete('/api/tasks/:id', async (c) => {
    const id = c.req.param('id');
    const task = taskStore.getTask(id);
    if (!task) return c.json({ error: 'Task not found' }, 404);

    try {
      await deleteTask({
        adapter,
        monitor,
        taskStore,
        hookWatcher,
        watchdog,
        shadowRegistry: deps.shadowRegistry,
        suppressionTracker: deps.suppressionTracker,
        queue: deps.queue,
      }, id);
      broadcastToAll(createSnapshotMessage({ monitor, serverCwd }));
      return c.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  app.get('/api/playbooks', async (c) => {
    try {
      const cwd = c.req.query('cwd') ?? serverCwd;
      const playbooks = await discoverPlaybooks(cwd);
      return c.json(playbooks);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.post('/api/playbooks/ralph-loop', async (c) => {
    let body: {
      playbookPath?: unknown;
      cwd?: unknown;
      parameterValues?: unknown;
      autonomy?: string;
      agentType?: string;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }

    if (typeof body.playbookPath !== 'string' || body.playbookPath.trim().length === 0) {
      return c.json({ error: 'playbookPath is required and must be a string' }, 400);
    }
    if (typeof body.cwd !== 'string' || body.cwd.trim().length === 0) {
      return c.json({ error: 'cwd is required and must be a string' }, 400);
    }
    if (!isStringRecord(body.parameterValues)) {
      return c.json({ error: 'parameterValues is required and must be an object of strings' }, 400);
    }

    try {
      const rawSource = c.req.header('X-Kookr-Launch-Source');
      const launchSource: 'cli' | 'ui' | 'api' =
        rawSource === 'cli' || rawSource === 'ui' ? rawSource : 'api';
      const autonomy = body.autonomy === 'autonomous' ? 'autonomous' as const : undefined;
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
          autonomyOrchestrator: deps.autonomyOrchestrator,
          suppressionTracker: deps.suppressionTracker,
        }),
      }, {
        cwd: body.cwd,
        playbookPath: body.playbookPath,
        parameterValues: body.parameterValues,
        autonomy,
        agentType: body.agentType ? normalizeAgentType(body.agentType) : undefined,
        launchSource,
      });

      broadcastToAll(createSnapshotMessage({ monitor, serverCwd }));
      return c.json({ ...result.task, ...(result.queued ? { queued: true } : {}) }, 201);
    } catch (err) {
      if (err instanceof LoopedPlaybookLaunchError) {
        return c.json({ error: err.message, ...err.details }, err.status);
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
      parameterValues?: unknown;
      autonomy?: string;
      agentType?: string;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }

    if (typeof body.playbookPath !== 'string' || body.playbookPath.trim().length === 0) {
      return c.json({ error: 'playbookPath is required and must be a string' }, 400);
    }
    if (typeof body.cwd !== 'string' || body.cwd.trim().length === 0) {
      return c.json({ error: 'cwd is required and must be a string' }, 400);
    }
    if (!isStringRecord(body.parameterValues)) {
      return c.json({ error: 'parameterValues is required and must be an object of strings' }, 400);
    }

    try {
      const rawSource = c.req.header('X-Kookr-Launch-Source');
      const launchSource: 'cli' | 'ui' | 'api' =
        rawSource === 'cli' || rawSource === 'ui' ? rawSource : 'api';
      const autonomy = body.autonomy === 'autonomous' ? 'autonomous' as const : undefined;

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
        autonomyOrchestrator: deps.autonomyOrchestrator,
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
        cwd: body.cwd,
        playbookPath: body.playbookPath,
        parameterValues: body.parameterValues,
        autonomy,
        agentType: body.agentType ? normalizeAgentType(body.agentType) : undefined,
        launchSource,
      });

      broadcastToAll(createSnapshotMessage({ monitor, serverCwd }));
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
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  app.get('/api/agents/:agentId/edit-events/:toolUseId', (c) => {
    const agentId = c.req.param('agentId');
    const toolUseId = c.req.param('toolUseId');

    if (!EDIT_EVENT_PARAM_RE.test(agentId)) {
      const body: EditEventMiss = { error: 'invalid_param', field: 'agentId' };
      return c.json(body, 400);
    }
    if (!EDIT_EVENT_PARAM_RE.test(toolUseId)) {
      const body: EditEventMiss = { error: 'invalid_param', field: 'toolUseId' };
      return c.json(body, 400);
    }

    const events = monitor.getAgentEvents(agentId);
    if (events.length === 0) {
      console.warn(`[edit-events] miss agentId=${agentId} toolUseId=${toolUseId} reason=agent_unknown`);
      const body: EditEventMiss = { error: 'not_found', reason: 'agent_unknown', serverStartedAt };
      return c.json(body, 404);
    }

    // Walk backward — most recent match wins for a given toolUseId.
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      if (ev.type !== 'tool_result') continue;
      if (ev.toolUseId !== toolUseId) continue;

      const tr = ev.toolResponse;
      if (tr === null || typeof tr !== 'object') break;
      const resp = tr as Record<string, unknown>;

      if (ev.toolName === 'Edit') {
        const body: EditEventResponse = {
          kind: 'edit',
          filePath: typeof resp.filePath === 'string' ? resp.filePath : '',
          structuredPatch: resp.structuredPatch ?? [],
          oldString: typeof resp.oldString === 'string' ? resp.oldString : '',
          newString: typeof resp.newString === 'string' ? resp.newString : '',
          serverStartedAt,
        };
        return c.json(body);
      }
      if (ev.toolName === 'Write') {
        const body: EditEventResponse = {
          kind: 'write',
          filePath: typeof resp.filePath === 'string' ? resp.filePath : '',
          structuredPatch: resp.structuredPatch ?? [],
          originalFile: typeof resp.originalFile === 'string' ? resp.originalFile : '',
          serverStartedAt,
        };
        return c.json(body);
      }
      // Known tool but not something DiffPane can render (NotebookEdit, etc.)
      const body: EditEventResponse = { kind: 'unsupported', serverStartedAt };
      return c.json(body);
    }

    console.warn(`[edit-events] miss agentId=${agentId} toolUseId=${toolUseId} reason=event_not_found`);
    const body: EditEventMiss = { error: 'not_found', reason: 'event_not_found', serverStartedAt };
    return c.json(body, 404);
  });

  app.get('/api/sessions/:sessionId/effective-hook-settings', (c) => {
    const sessionId = c.req.param('sessionId');
    if (!SESSION_ID_RE.test(sessionId)) {
      return c.json({ error: 'invalid session id' }, 400);
    }
    const effective = adapter.getEffectiveHookSettings(sessionId);
    if (!effective) {
      return c.json({ error: 'unknown session' }, 404);
    }
    return c.json(effective);
  });

  app.post('/api/agents/:id/message', async (c) => {
    const agentId = c.req.param('id');
    try {
      const body = await c.req.json() as { input?: string };
      if (!body.input || typeof body.input !== 'string') {
        return c.json({ error: 'input is required and must be a string' }, 400);
      }

      const agent = getSnapshotAgentsRaw({ monitor }).find((candidate) => candidate.agentId === agentId);
      if (!agent) {
        return c.json({ error: `Agent not found: ${agentId}` }, 404);
      }

      await sendDirectAgentInput({
        adapter,
        interactionLog,
        autonomyOrchestrator: deps.autonomyOrchestrator,
      }, agentId, body.input, 'rest_api');

      broadcastToAll(createSnapshotMessage({ monitor, serverCwd }));
      return c.json({ ok: true, agentId, delivered: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  // ---------------------------------------------------------------------------
  // Cost comparison (rfc-cost-comparison-panel.md). Read-only telemetry route;
  // flag-gated behind KOOKR_COST_PANEL=1 so half-implemented frontends cannot
  // poll a partial backend (R11 + PR 3 rollback safety in §Implementation phases).
  // ---------------------------------------------------------------------------

  if (process.env.KOOKR_COST_PANEL === '1') {
    app.get('/api/cost-comparison', async (c) => {
      const tokenTracker = deps.tokenTracker;
      if (!tokenTracker) return c.json({ error: 'token tracker not wired' }, 500);

      const window = (c.req.query('window') ?? '7d') as TimeWindow;
      const agentParam = c.req.query('agent');
      const agentFilter: CostAgent | undefined =
        agentParam === 'claude-code' || agentParam === 'codex-cli' ? agentParam : undefined;
      const taskNameQuery = c.req.query('q');

      const now = Date.now();
      const windowEndMs = now;
      const windowStartMs =
        window === '24h' ? now - 24 * 60 * 60 * 1000
        : window === '7d' ? now - 7 * 24 * 60 * 60 * 1000
        : window === '30d' ? now - 30 * 24 * 60 * 60 * 1000
        : 0;                                                          // 'all' → epoch

      // Codex side: scan + bind. The scanner is a per-route singleton so its
      // (path, mtime) cache survives across requests.
      const scanner = costScannerSingleton;
      const tasks = taskStore.listTasks();
      const codexTasks = tasks
        .filter(t => t.agentType === 'codex-cli')
        .map(t => {
          // Use the first session's cwd (the actual cwd Codex saw) when present;
          // task.cwd is the user-supplied launch cwd which may differ.
          const sessionCwd = t.sessions[0]?.cwd;
          const created = t.createdAt instanceof Date ? t.createdAt.getTime() : new Date(t.createdAt).getTime();
          return { taskId: t.id, cwd: sessionCwd ?? t.cwd, createdAtMs: created };
        });

      const scanStart = Date.now();
      const scan = await scanner.scan(windowStartMs, windowEndMs);
      const { outcomes, orphanRollouts } = scanner.bindTasks(scan.rollouts, codexTasks);

      // Claude side: pull live token usage and the resolved model id (used by the aggregator
      // to drive the R17 pricing-staleness banner — Claude per-task rows themselves keep
      // model:null because dated Claude ids don't round-trip through exact-match pricing).
      const claudeUsage = new Map<string, NonNullable<ReturnType<typeof tokenTracker.getUsage>>>();
      const claudeModels = new Map<string, string | null>();
      for (const t of tasks) {
        if (t.agentType !== 'claude-code') continue;
        const u = tokenTracker.getUsage(t.id);
        if (u) claudeUsage.set(t.id, u);
        claudeModels.set(t.id, tokenTracker.getModel(t.id));
      }

      // Resolve playbooks for displayName. discoverPlaybooks reads .kookr/playbooks/
      // in the server cwd; missing entries fall back to the id string.
      let playbooksById = new Map<string, import('../../shared/contracts/playbook.js').Playbook>();
      try {
        const playbooks = await discoverPlaybooks(serverCwd);
        playbooksById = new Map(playbooks.map(p => [p.id, p]));
      } catch {
        // discovery failure is non-fatal — the panel still renders with id strings.
      }

      const response = aggregateCostComparison({
        tasks, agentFilter, taskNameQuery,
        windowStartMs, windowEndMs,
        claudeUsage, claudeModels, codexOutcomes: outcomes,
        playbooksById,
        todayMs: now,
        codexStats: {
          rolloutCount: scan.stats.rolloutCount,
          parseErrorCount: scan.stats.parseErrorCount,
          abandonedCount: scan.stats.abandonedCount,
          orphanRollouts,
        },
        scannedAt: new Date().toISOString(),
        scanDurationMs: Date.now() - scanStart,
      });

      return c.json(response);
    });
  }
}

// Singleton scanner — its in-memory (path, mtime) cache outlives a single
// request so warm scans hit the < 200 ms target (R6). Only instantiated when
// the route is registered, so KOOKR_COST_PANEL=0 deployments pay nothing.
const costScannerSingleton = new CodexRolloutScanner();

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
