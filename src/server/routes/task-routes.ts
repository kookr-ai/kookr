import type { Hono } from 'hono';
import { join } from 'node:path';
import { discoverPlaybooks } from '../../core/playbook-discovery.js';
import { saveTasks, serializeSnoozed } from '../../core/task-persistence.js';
import { normalizeAgentSelection } from '../../core/agent-types.js';
import { createSnapshotMessage } from '../use-cases/get-snapshot.js';
import { isTerminalStatus } from '../../core/task-status.js';
import { redactSecrets } from '../../core/redact-secrets.js';
import {
  AGENT_SIGNAL_KINDS,
  isAgentSignalKind,
  MAX_AGENT_SIGNAL_NOTE_LENGTH,
  type PendingAgentSignal,
} from '../../shared/contracts/agent-signal.js';
import { TaskLifecycleCommands } from '../use-cases/task-lifecycle-commands.js';
import { launchTask, DrainModeError, isCwdValidationError, isEffortValidationError, isModelValidationError } from '../launch-service.js';
import { LaunchPreflightError } from '../../core/launch-dependency-preflight.js';
import { LAUNCH_DEPENDENCIES, type LaunchDependency } from '../../core/playbook.js';
import type { SessionInfo, Task, TaskStore, TokenUsage } from '../../core/tasks.js';
import type { TaskDependencyEdge, TaskMetadataIntent } from '../../shared/contracts/task.js';
import { normalizeTerminalWorktreeHealth } from '../../core/worktree-health.js';
import { readEvolutionRunProjection } from '../../core/evolution-summary.js';
import { isSharedTaskId } from '../../shared/contracts/contact-share.js';
import { MAX_BATCH_ABORT_TASKS } from '../../shared/contracts/messages.js';
import { CoordinatorSuppressionStore } from '../coordinator/suppression-store.js';
import { promotePendingTasks } from '../agent-lifecycle.js';
import type { TaskRouteDeps } from './shared.js';
import {
  DEFAULT_STALE_COMPLETION_READY_THRESHOLD_MS,
  classifyCompletionReadyClosePolicy,
  listStaleCompletionReadyTasks,
} from '../../core/completion-ready-cleanup.js';
import {
  boundTailText,
  parseTailLinesQuery,
  TASK_TAIL_SCHEMA_VERSION,
} from '../../core/task-tail-store.js';

const MAX_TASK_EDGE_COUNT = 64;
const MAX_TASK_EDGE_LENGTH = 240;

export function registerTaskRoutes(app: Hono, deps: TaskRouteDeps): void {
  const { taskStore, monitor, adapter, hookWatcher, watchdog, broadcastToAll, serverCwd, hookIngestion } = deps;
  const coordinatorSuppressions = deps.coordinatorSuppressions ?? new CoordinatorSuppressionStore(deps.kookrDir ?? serverCwd);
  const lifecycleCommands = new TaskLifecycleCommands({
    taskStore,
    monitor,
    interactionLog: deps.interactionLog,
    scheduleService: deps.scheduleService,
    broadcastToAll,
    activityMetaProvider: hookIngestion,
    auditLogPath: deps.kookrDir ? join(deps.kookrDir, 'audit.jsonl') : undefined,
    getLifecycleDeps: () => ({
      adapter,
      monitor,
      taskStore,
      getCleanupWorktreeOnComplete: deps.getCleanupWorktreeOnComplete,
      hookWatcher,
      watchdog,
      ...(deps.issueClaimRegistry ? { issueClaimRegistry: deps.issueClaimRegistry } : {}),
      ...(deps.onTaskOutcome ? { onTaskOutcome: deps.onTaskOutcome } : {}),
      ...(deps.taskTailStore ? { taskTailStore: deps.taskTailStore } : {}),
      shadowRegistry: deps.shadowRegistry,
      suppressionTracker: deps.suppressionTracker,
      tokenTracker: deps.tokenTracker,
      queue: deps.queue,
      interactionLog: deps.interactionLog,
      activityLedger: deps.activityLedger,
      hookIngestion: deps.hookIngestion,
    }),
    tryPromotePending: async () => {
      const launchDeps = deps.launchServiceDeps;
      if (!launchDeps?.adapterRegistry || !launchDeps.lifecycleDeps) return;
      await promotePendingTasks({
        taskStore,
        adapterRegistry: launchDeps.adapterRegistry,
        lifecycleDeps: launchDeps.lifecycleDeps,
        broadcastToAll,
        serverCwd,
        getMaxActiveTasks: launchDeps.getMaxActiveTasks,
      });
    },
  });

  function broadcastSnapshotWithCoordinator(): void {
    broadcastToAll(createSnapshotMessage({
      monitor,
      serverCwd,
      activityMetaProvider: hookIngestion,
      coordinator: { taskStore, auditTailProvider: hookIngestion, suppressions: coordinatorSuppressions },
      relationTaskStore: taskStore,
    }));
  }

  // Additive compact list projection (issue: compact GET /api/tasks). Dashboards
  // and pollers list hundreds of historical tasks but only need list-row fields;
  // the default full view ships every task's multi-KB `prompt`/`userPrompt`, which
  // on prod totalled ~8.7 MB for ~213 tasks. `?view=compact` omits those heavy
  // bodies (prompt, userPrompt, criteria, launchNote, completionDigest,
  // launchHealthSummary) while keeping the id/status/session-health/token/timeline
  // fields a list needs. The full detail — including prompt — stays available via
  // GET /api/tasks/:id. Default remains the full list for backward compatibility.
  app.get('/api/tasks', (c) => {
    if (c.req.query('view') === 'compact') {
      const compact = taskStore.listTasks().map((t) => toCompactApiTask(t, taskStore));
      if (!deps.suppressionTracker) return c.json(compact);
      const tracker = deps.suppressionTracker;
      return c.json(compact.map((t) => withSuppressionFlag(t, tracker)));
    }
    const tasks = taskStore.listTasks()
      .map(normalizeTaskForApi)
      .map((t) => attachAggregateTokenUsage(t, taskStore));
    if (!deps.suppressionTracker) return c.json(tasks);
    const tracker = deps.suppressionTracker;
    return c.json(tasks.map((t) => withSuppressionFlag(t, tracker)));
  });

  app.get('/api/tasks/completion-ready/stale', (c) => {
    const thresholdMs = parseThresholdMs(c.req.query('thresholdMs'));
    if (thresholdMs instanceof Error) return c.json({ error: thresholdMs.message }, 400);

    const generatedAt = new Date();
    const ttlMs = deps.getCompletionReadyTtlMs?.();
    // `closeReason` (issue #1526 Phase A) is additive under the existing
    // schemaVersion below — only present when canAutoClose is true, so an
    // older client that doesn't know the field simply ignores it.
    const tasks = listStaleCompletionReadyTasks(taskStore.listTasks(), { now: generatedAt, thresholdMs, ttlMs })
      .map((entry) => ({
        task: normalizeTaskForApi(entry.task),
        signal: entry.signal,
        ageMs: entry.ageMs,
        canAutoClose: entry.canAutoClose,
        ...(entry.manualActionRequiredReason ? { manualActionRequiredReason: entry.manualActionRequiredReason } : {}),
        ...(entry.closeReason ? { closeReason: entry.closeReason } : {}),
      }));
    return c.json({
      schemaVersion: 'stale-completion-ready-tasks.v1',
      generatedAt: generatedAt.toISOString(),
      thresholdMs,
      count: tasks.length,
      tasks,
    });
  });

  app.get('/api/tasks/:id', (c) => {
    const id = c.req.param('id');
    const task = taskStore.getTask(id);
    if (!task) return c.json({ error: 'Task not found' }, 404);
    const normalized = attachAggregateTokenUsage(normalizeTaskForApi(task), taskStore);
    if (!deps.suppressionTracker) return c.json(normalized);
    return c.json(withSuppressionFlag(normalized, deps.suppressionTracker));
  });

  /**
   * Bounded terminal tail for a task — live ring when in progress, durable
   * persisted tail after completion (rfc-task-tail-retrieval).
   */
  app.get('/api/tasks/:id/tail', async (c) => {
    const id = c.req.param('id');
    const linesOrErr = parseTailLinesQuery(c.req.query('lines'));
    if (linesOrErr instanceof Error) return c.json({ error: linesOrErr.message }, 400);

    const task = taskStore.getTask(id);
    if (!task) return c.json({ error: 'Task not found' }, 404);

    const liveSession = [...task.sessions]
      .reverse()
      .find((s) => s.lastStatus !== 'completed' && s.lastStatus !== 'aborted');

    if (liveSession && typeof adapter.captureDisplay === 'function') {
      try {
        const raw = await adapter.captureDisplay(liveSession.tmuxSession);
        const bound = boundTailText(raw, linesOrErr);
        return c.json({
          schemaVersion: TASK_TAIL_SCHEMA_VERSION,
          taskId: task.id,
          sessionId: liveSession.tmuxSession,
          taskStatus: task.status,
          source: 'live' as const,
          capturedAt: new Date().toISOString(),
          linesRequested: linesOrErr,
          totalLines: bound.totalLines,
          shownLines: bound.shownLines,
          text: bound.text,
          truncated: false,
        });
      } catch (err) {
        // Fall through to persisted tail when live capture fails (e.g. race
        // with session teardown).
        console.warn(
          `[task-tail] live capture failed for ${liveSession.tmuxSession}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    const stored = deps.taskTailStore
      ? await deps.taskTailStore.getByTaskId(task.id)
      : null;
    if (!stored) {
      const reason = isTerminalStatus(task.status)
        ? 'No persisted terminal tail for this task (never captured, expired, or retention disabled)'
        : 'No live session output and no persisted terminal tail';
      return c.json({ error: reason, taskId: task.id }, 404);
    }

    const bound = boundTailText(stored.text, linesOrErr);
    return c.json({
      schemaVersion: TASK_TAIL_SCHEMA_VERSION,
      taskId: task.id,
      sessionId: stored.sessionId,
      taskStatus: task.status,
      source: 'persisted' as const,
      capturedAt: stored.capturedAt,
      retentionExpiresAt: deps.taskTailStore!.retentionExpiresAt(stored.capturedAt),
      linesRequested: linesOrErr,
      totalLines: bound.totalLines,
      shownLines: bound.shownLines,
      text: bound.text,
      truncated: stored.truncated,
    });
  });

  app.get('/api/tasks/:id/evolution', async (c) => {
    const id = c.req.param('id');
    const task = taskStore.getTask(id);
    if (!task) return c.json({ error: 'Task not found' }, 404);

    try {
      return c.json(await readEvolutionRunProjection(task.cwd));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.patch('/api/tasks/:id/name', async (c) => {
    const id = c.req.param('id');
    if (isSharedTaskId(id)) return c.json({ error: 'SharedTask IDs are remote-owned' }, 403);
    const task = taskStore.getTask(id);
    if (!task) return c.json({ error: 'Task not found' }, 404);

    let body: { name?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    if (typeof body.name !== 'string') {
      return c.json({ error: 'name is required and must be a string' }, 400);
    }

    const updated = taskStore.renameTask(id, body.name);
    broadcastToAll(createSnapshotMessage({ monitor, serverCwd, activityMetaProvider: hookIngestion, relationTaskStore: taskStore }));
    return c.json({ ok: true, task: updated });
  });

  app.patch('/api/tasks/:id/edges', async (c) => {
    const id = c.req.param('id');
    if (isSharedTaskId(id)) return c.json({ error: 'SharedTask IDs are remote-owned' }, 403);
    const task = taskStore.getTask(id);
    if (!task) return c.json({ error: 'Task not found' }, 404);

    let body: { blocks?: unknown; blocked_by?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }

    const patch: { blocks?: TaskDependencyEdge[]; blocked_by?: TaskDependencyEdge[] } = {};
    try {
      if (body.blocks !== undefined) patch.blocks = normalizeTaskEdges(body.blocks, 'blocks');
      if (body.blocked_by !== undefined) patch.blocked_by = normalizeTaskEdges(body.blocked_by, 'blocked_by');
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
    if (patch.blocks === undefined && patch.blocked_by === undefined) {
      return c.json({ error: 'at least one of blocks or blocked_by is required' }, 400);
    }

    const updated = taskStore.setTaskEdges(id, patch);
    if (deps.taskStateSaveScheduler) {
      deps.taskStateSaveScheduler.requestSave('task_edges_mutation');
    } else if (deps.tasksFile) {
      const snoozes = deps.queue ? serializeSnoozed(deps.queue, taskStore) : undefined;
      const suppressionState = deps.suppressionTracker?.export();
      await saveTasks(
        taskStore.getAllTasks(),
        deps.tasksFile,
        taskStore.getLifetimeSpendUsd(),
        snoozes,
        suppressionState,
        taskStore.listRelations(),
      );
    }
    broadcastSnapshotWithCoordinator();
    return c.json({ ok: true, task: updated });
  });

  app.post('/api/tasks', async (c) => {
    try {
      const body = await c.req.json() as {
        prompt?: string;
        cwd?: string;
        criteria?: string;
        parentTaskId?: string;
        agentType?: string;
        effort?: unknown;
        model?: unknown;
        disableDedup?: unknown;
        metadata?: unknown;
        dependencies?: unknown;
        autoCloseOnSignal?: unknown;
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
      if (body.disableDedup !== undefined && typeof body.disableDedup !== 'boolean') {
        return c.json({ error: 'disableDedup must be a boolean' }, 400);
      }
      const metadataIntent = parseTaskMetadataIntent(body.metadata);
      if (metadataIntent instanceof Error) {
        return c.json({ error: metadataIntent.message }, 400);
      }
      if (body.disableDedup === true && metadataIntent !== 'keep_as_duplicate') {
        return c.json({ error: 'disableDedup requires metadata.intent "keep_as_duplicate"' }, 400);
      }
      if (metadataIntent === 'keep_as_duplicate' && body.disableDedup !== true) {
        return c.json({ error: 'metadata.intent "keep_as_duplicate" requires disableDedup true' }, 400);
      }
      // #681 / #1518: shape check only. The agent-specific allowed-set check
      // runs in launchTask after round-robin resolution and surfaces as a 400
      // via EffortValidationError / ModelValidationError (mapped below).
      if (body.effort !== undefined && typeof body.effort !== 'string') {
        return c.json({ error: 'effort must be a string' }, 400);
      }
      if (body.model !== undefined && typeof body.model !== 'string') {
        return c.json({ error: 'model must be a string' }, 400);
      }
      if (body.autoCloseOnSignal !== undefined && typeof body.autoCloseOnSignal !== 'boolean') {
        return c.json({ error: 'autoCloseOnSignal must be a boolean' }, 400);
      }

      const rawSource = c.req.header('X-Kookr-Launch-Source');
      const launchSource: 'cli' | 'ui' | 'api' =
        rawSource === 'cli' || rawSource === 'ui' ? rawSource : 'api';
      const { task, queued, duplicate } = await launchTask(deps.launchServiceDeps, {
        prompt: body.prompt,
        cwd: body.cwd,
        criteria: body.criteria,
        parentTaskId: body.parentTaskId,
        agentType: body.agentType ? normalizeAgentSelection(body.agentType) : undefined,
        effort: typeof body.effort === 'string' ? body.effort : undefined,
        model: typeof body.model === 'string' ? body.model : undefined,
        disableDedup: body.disableDedup === true,
        metadataIntent,
        dependencies: parseLaunchDependencies(body.dependencies),
        launchSource,
        autoCloseOnSignal: typeof body.autoCloseOnSignal === 'boolean' ? body.autoCloseOnSignal : undefined,
      });

      if (duplicate) {
        return c.json({ task, duplicate: true }, 200);
      }

      broadcastToAll(createSnapshotMessage({ monitor, serverCwd, activityMetaProvider: hookIngestion, relationTaskStore: taskStore }));
      return c.json({ ...task, ...(queued ? { queued: true } : {}) }, 201);
    } catch (err) {
      if (isLaunchDependencyValidationError(err)) {
        return c.json({ error: err.message }, 400);
      }
      if (isEffortValidationError(err)) {
        return c.json({ error: err.message, code: err.code }, 400);
      }
      if (isModelValidationError(err)) {
        return c.json({ error: err.message, code: err.code }, 400);
      }
      // RFC F12: a missing working directory is a client error, surfaced
      // before any session spawn with the actual cause leading the message.
      if (isCwdValidationError(err)) {
        return c.json({ error: err.message, code: err.code }, 400);
      }
      if (err instanceof LaunchPreflightError) {
        return c.json({ error: err.message, code: 'launch_preflight_failed', findings: err.findings }, 409);
      }
      if (err instanceof DrainModeError) {
        return c.json({ error: err.message, code: err.code }, 503);
      }
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  app.delete('/api/tasks/:id', async (c) => {
    const id = c.req.param('id');
    if (isSharedTaskId(id)) return c.json({ error: 'SharedTask IDs are remote-owned' }, 403);
    const task = taskStore.getTask(id);
    if (!task) return c.json({ error: 'Task not found' }, 404);

    try {
      await lifecycleCommands.deleteTask(id, { actor: { source: 'api' } });
      broadcastToAll(createSnapshotMessage({ monitor, serverCwd, activityMetaProvider: hookIngestion, relationTaskStore: taskStore }));
      return c.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  // Non-destructive terminal transition (issue #691). Marks a finished task
  // `completed` and tears down its idle dtach session via the same lifecycle
  // handler the WS `completeTask` message uses — so projections, the schedule
  // service, and the coordinator all observe the terminal state. Unlike DELETE
  // this preserves the task's history; unlike cancel it carries no kill/abort
  // semantics. It is the documented, safe way for an operator or orchestrating
  // agent to clear its own finished helper tasks.
  //
  // This route shares the WS completion command. When monitor events are
  // available it may finalize a completion digest; helper tasks with no captured
  // events remain digestless.
  app.post('/api/tasks/:id/complete', async (c) => {
    const id = c.req.param('id');
    if (isSharedTaskId(id)) return c.json({ error: 'SharedTask IDs are remote-owned' }, 403);

    try {
      const result = await lifecycleCommands.completeTask(id);
      if (result.outcome === 'not_found') {
        return c.json({ error: 'Task not found' }, 404);
      }
      if (result.outcome === 'invalid') {
        return c.json({ error: result.error, code: result.code }, 409);
      }
      broadcastSnapshotWithCoordinator();
      return c.json({
        ok: true,
        task: 'task' in result ? result.task : taskStore.getTask(id),
        ...(result.outcome === 'already_terminal' ? { alreadyTerminal: true } : {}),
        ...(result.outcome === 'partial_ralph_completion' ? { partialRalphCompletion: true } : {}),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  // Agent → user signal (RFC: rfc-agent-signal-surface). A non-blocking,
  // explicit signal an in-task agent raises (via `kookr signal <kind>`) to tell
  // the user something — the motivating case being "this task is ready for
  // completion". Kookr surfaces it (highlighted Complete button); the agent
  // never completes the task itself. Idempotent per task; rejected for unknown
  // or terminal tasks (the CLI maps that to a distinct exit code so a wrong
  // KOOKR_TASK_ID is visible rather than silently swallowed).
  app.post('/api/tasks/:id/signal', async (c) => {
    const id = c.req.param('id');
    if (isSharedTaskId(id)) return c.json({ error: 'SharedTask IDs are remote-owned' }, 403);
    const task = taskStore.getTask(id);
    if (!task) return c.json({ error: 'Task not found' }, 404);
    if (isTerminalStatus(task.status)) {
      return c.json(
        { error: `Cannot signal a task in status "${task.status}"`, code: 'task_terminal' },
        409,
      );
    }

    let body: { kind?: unknown; note?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    if (!isAgentSignalKind(body.kind)) {
      return c.json({ error: `kind must be one of: ${AGENT_SIGNAL_KINDS.join(', ')}` }, 400);
    }
    let note: string | undefined;
    let truncated = false;
    if (body.note !== undefined) {
      if (typeof body.note !== 'string') {
        return c.json({ error: 'note must be a string when supplied' }, 400);
      }
      const normalized = normalizeSignalNote(body.note);
      truncated = normalized.truncated;
      if (normalized.note) note = normalized.note;
    }

    const signal: PendingAgentSignal = {
      kind: body.kind,
      raisedAt: new Date().toISOString(),
      ...(note ? { note } : {}),
    };
    taskStore.setPendingSignal(id, signal);
    if (signal.kind === 'completion_ready') {
      try {
        deps.onTaskOutcome?.(id, { kind: 'completion_ready', ...(signal.note ? { note: signal.note } : {}) });
      } catch (err) {
        console.warn('[task-routes] onTaskOutcome threw:', err);
      }
    }

    // Auto-close opt-in (per-task `autoCloseOnSignal`, set at launch or inherited
    // from the parent). Explicit auto-close now gives operators a one-hour
    // review window: the signal is recorded here, then the lifecycle timer
    // completes stale eligible tasks. Without that opt-in, ask-first delivery
    // tasks keep the signal surfaced for manual review.
    // See docs/reference/auto-close-on-signal.md.
    const closePolicy = classifyCompletionReadyClosePolicy(task);
    const autoCloseScheduled =
      body.kind === 'completion_ready' &&
      closePolicy.canAutoClose &&
      task.status === 'inProgress' &&
      !isActiveRalphLoop(task);

    broadcastSnapshotWithCoordinator();
    return c.json({
      ok: true,
      signal,
      truncated,
      autoClosed: false,
      ...(autoCloseScheduled ? {
        autoCloseScheduled: true,
        autoCloseAfterMs: deps.getAutoCloseCompletionReadyDelayMs?.() ?? DEFAULT_STALE_COMPLETION_READY_THRESHOLD_MS,
      } : {}),
      ...(!autoCloseScheduled && !closePolicy.canAutoClose
        ? { manualActionRequiredReason: closePolicy.manualActionRequiredReason }
        : {}),
    });
  });

  // Idempotent batch abort (issue #1325). Accepts explicit task IDs plus an
  // operator reason, aborts every still-active task, interrupts its live
  // sessions, and returns a per-task result so callers can report partial
  // failures. Retrying the same request is safe: already-terminal tasks report
  // `already_terminal` without a second transition or audit row.
  app.post('/api/tasks/abort', async (c) => {
    let body: { taskIds?: unknown; reason?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    // Guard non-object bodies (`null`, primitives, arrays) before dereferencing
    // fields — otherwise `null.taskIds` throws and surfaces as a 500.
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ error: 'body must be a JSON object' }, 400);
    }
    if (!Array.isArray(body.taskIds)) {
      return c.json({ error: 'taskIds is required and must be an array of strings' }, 400);
    }
    if (body.taskIds.some((id) => typeof id !== 'string')) {
      return c.json({ error: 'taskIds entries must be strings' }, 400);
    }
    if (body.taskIds.length > MAX_BATCH_ABORT_TASKS) {
      return c.json(
        { error: `cannot abort more than ${MAX_BATCH_ABORT_TASKS} tasks in one request` },
        400,
      );
    }
    if (body.reason !== undefined && typeof body.reason !== 'string') {
      return c.json({ error: 'reason must be a string when supplied' }, 400);
    }
    // SharedTask lifecycle is remote-owned; drop any that slipped in and abort
    // the rest, matching the WS control-room path. A single remote-owned id must
    // never block a bulk abort of the operator's local tasks.
    const taskIds = (body.taskIds as string[]).filter((id) => !isSharedTaskId(id));

    try {
      const result = await lifecycleCommands.batchAbortTasks(taskIds, {
        reason: typeof body.reason === 'string' ? body.reason : undefined,
        actor: { source: 'api' },
      });
      broadcastSnapshotWithCoordinator();
      return c.json(result);
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
}

function normalizeSignalNote(raw: string): { note?: string; truncated: boolean } {
  const redacted = redactSecrets(raw).trim();
  if (!redacted) return { truncated: false };
  if (redacted.length <= MAX_AGENT_SIGNAL_NOTE_LENGTH) {
    return { note: redacted, truncated: false };
  }
  return {
    note: truncateAtWordBoundary(redacted, MAX_AGENT_SIGNAL_NOTE_LENGTH),
    truncated: true,
  };
}

function isActiveRalphLoop(task: Pick<Task, 'ralphLoop'>): boolean {
  return task.ralphLoop?.status === 'running' || task.ralphLoop?.status === 'paused';
}

function truncateAtWordBoundary(text: string, maxLength: number): string {
  const ellipsis = '…';
  const sliceLimit = Math.max(0, maxLength - ellipsis.length);
  const prefix = text.slice(0, sliceLimit).trimEnd();
  const boundaryMatch = prefix.match(/[\s,.;:!?]+[^\s,.;:!?]*$/);
  // Prefer a clean word boundary, but avoid discarding too much context for a
  // single long token near the limit.
  const wordBoundaryPrefix = boundaryMatch && boundaryMatch.index && boundaryMatch.index >= Math.floor(sliceLimit * 0.6)
    ? prefix.slice(0, boundaryMatch.index).trimEnd()
    : prefix;
  return `${wordBoundaryPrefix}${ellipsis}`;
}

function parseThresholdMs(raw: string | undefined): number | Error {
  if (raw === undefined) return DEFAULT_STALE_COMPLETION_READY_THRESHOLD_MS;
  if (!/^\d+$/.test(raw)) return new Error('thresholdMs must be a non-negative integer');
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) return new Error('thresholdMs must be a safe integer');
  return value;
}

/**
 * Task shape returned by the REST surface. Carries `taskId` as an alias of
 * `id` so scripts can use one field name across `/api/tasks`,
 * `/api/projects` `recentTasks[]`, and `/api/snapshot` agents (which all key
 * by `taskId`). `id` stays for backwards compatibility.
 */
type ApiTask = Task & { taskId: string; aggregateTokenUsage?: TokenUsage };

/**
 * Attach the descendant-rolled-up token usage to a parent/batch task so a
 * batch shows aggregate spend (issue #1307). Left off leaf tasks so their
 * response is byte-identical to before; `tokenUsage` (own usage) is never
 * touched, keeping cross-task totals free of double counting.
 */
function attachAggregateTokenUsage(task: ApiTask, store: TaskStore): ApiTask {
  if (!task.childTaskIds || task.childTaskIds.length === 0) return task;
  const aggregate = store.getAggregateTokenUsage(task.id);
  return aggregate ? { ...task, aggregateTokenUsage: aggregate } : task;
}

/**
 * Session fields the compact list surfaces. Enough for session-health badges and
 * for clients that match a task by its `tmuxSession` (e.g. the QuickLaunch CWD
 * resolver and DetailPanel relaunch lookup). Heavy/rarely-listed session fields
 * (transcriptPath, childSessionIds, git* identity) are dropped.
 */
type CompactApiTaskSession = Pick<
  SessionInfo,
  | 'tmuxSession'
  | 'agentType'
  | 'lastStatus'
  | 'lastTurnState'
  | 'worktreeHealth'
  | 'lastEventAt'
  | 'crashRecovered'
  | 'relaunchCount'
>;

/**
 * Compact list-row projection of a task, returned by `GET /api/tasks?view=compact`.
 * Carries the id/status/timeline/token/session-health fields a dashboard list
 * needs and deliberately OMITS the heavy bodies (`prompt`, `userPrompt`,
 * `criteria`, `launchNote`, `completionDigest`, `launchHealthSummary`). Fetch
 * `GET /api/tasks/:id` for the full detail including the prompt.
 */
type CompactApiTask = Pick<
  Task,
  | 'id'
  | 'name'
  | 'status'
  | 'cwd'
  | 'agentType'
  | 'playbookId'
  | 'projectId'
  | 'priority'
  | 'parentTaskId'
  | 'childTaskIds'
  | 'blocks'
  | 'blocked_by'
  | 'deliveryAuthorization'
  | 'autoCloseOnSignal'
  | 'tokenUsage'
  | 'pendingSignal'
  | 'issueClaim'
  | 'ralphLoop'
  | 'createdAt'
  | 'updatedAt'
  | 'finishedAt'
  | 'terminatedAt'
> & {
  /** Alias of `id`, mirroring the full `ApiTask` surface. */
  taskId: string;
  /** Descendant-rolled-up token usage on a parent/batch task (issue #1307). */
  aggregateTokenUsage?: TokenUsage;
  sessions: CompactApiTaskSession[];
};

/**
 * Build the compact list projection for a task. Rolls up child token usage the
 * same way `attachAggregateTokenUsage` does for the full view, and normalizes
 * terminal worktree health per session exactly like `normalizeTaskForApi`.
 * Undefined optional fields serialize away, so terminal/leaf tasks stay lean.
 */
function toCompactApiTask(task: Task, store: TaskStore): CompactApiTask {
  const aggregateTokenUsage =
    task.childTaskIds && task.childTaskIds.length > 0
      ? store.getAggregateTokenUsage(task.id) ?? undefined
      : undefined;
  return {
    id: task.id,
    taskId: task.id,
    name: task.name,
    status: task.status,
    cwd: task.cwd,
    agentType: task.agentType,
    playbookId: task.playbookId,
    projectId: task.projectId,
    priority: task.priority,
    parentTaskId: task.parentTaskId,
    childTaskIds: task.childTaskIds,
    blocks: task.blocks,
    blocked_by: task.blocked_by,
    deliveryAuthorization: task.deliveryAuthorization,
    autoCloseOnSignal: task.autoCloseOnSignal,
    tokenUsage: task.tokenUsage,
    aggregateTokenUsage,
    pendingSignal: task.pendingSignal,
    issueClaim: task.issueClaim,
    ralphLoop: task.ralphLoop,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    finishedAt: task.finishedAt,
    terminatedAt: task.terminatedAt,
    sessions: task.sessions.map((session) => ({
      tmuxSession: session.tmuxSession,
      agentType: session.agentType,
      lastStatus: session.lastStatus,
      lastTurnState: session.lastTurnState,
      worktreeHealth: normalizeTerminalWorktreeHealth(task.status, session.worktreeHealth),
      lastEventAt: session.lastEventAt,
      crashRecovered: session.crashRecovered,
      relaunchCount: session.relaunchCount,
    })),
  };
}

function normalizeTaskForApi(task: Task): ApiTask {
  let changed = false;
  const sessions = task.sessions.map((session) => {
    const worktreeHealth = normalizeTerminalWorktreeHealth(task.status, session.worktreeHealth);
    if (worktreeHealth === session.worktreeHealth) return session;
    changed = true;
    return { ...session, worktreeHealth };
  });

  return changed ? { ...task, sessions, taskId: task.id } : { ...task, taskId: task.id };
}

function withSuppressionFlag<
  T extends { sessions: Array<{ tmuxSession: string; lastStatus?: SessionInfo['lastStatus'] }> },
>(
  task: T,
  tracker: { isSuppressed(tmuxSession: string): boolean },
): T | (T & { suppressed: true }) {
  const hasSuppressedSession = task.sessions.some(
    (s) => s.lastStatus !== 'completed' && s.lastStatus !== 'aborted' && tracker.isSuppressed(s.tmuxSession),
  );
  return hasSuppressedSession ? { ...task, suppressed: true } : task;
}

function normalizeTaskEdges(value: unknown, field: 'blocks' | 'blocked_by'): TaskDependencyEdge[] {
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array`);
  }
  if (value.length > MAX_TASK_EDGE_COUNT) {
    throw new Error(`${field} cannot contain more than ${MAX_TASK_EDGE_COUNT} edges`);
  }

  const out: TaskDependencyEdge[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== 'string') {
      throw new Error(`${field} entries must be strings`);
    }
    const edge = normalizeTaskEdge(raw, field);
    if (seen.has(edge)) continue;
    seen.add(edge);
    out.push(edge);
  }
  return out;
}

function normalizeTaskEdge(raw: string, field: 'blocks' | 'blocked_by'): TaskDependencyEdge {
  const edge = raw.trim();
  if (edge.length === 0) {
    throw new Error(`${field} entries must not be empty`);
  }
  if (edge.length > MAX_TASK_EDGE_LENGTH) {
    throw new Error(`${field} entries must be ${MAX_TASK_EDGE_LENGTH} characters or fewer`);
  }
  if (edge.startsWith('task:')) {
    const id = edge.slice('task:'.length).trim();
    if (!id) throw new Error(`${field} task edges must include an id`);
    if (id !== edge.slice('task:'.length)) throw new Error(`${field} task edge ids must not have surrounding whitespace`);
    return `task:${id}`;
  }
  if (edge.startsWith('milestone:')) {
    const text = edge.slice('milestone:'.length).trim();
    if (!text) throw new Error(`${field} milestone edges must include text`);
    return `milestone:${text}`;
  }
  throw new Error(`${field} entries must start with task: or milestone:`);
}

function parseTaskMetadataIntent(raw: unknown): TaskMetadataIntent | undefined | Error {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return new Error('metadata must be an object');
  }
  const intent = (raw as { intent?: unknown }).intent;
  if (intent === undefined) return undefined;
  if (intent === 'keep_as_duplicate') return intent;
  return new Error('metadata.intent must be "keep_as_duplicate"');
}

function parseLaunchDependencies(value: unknown): LaunchDependency[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error('dependencies must be an array when supplied');
  return value.map((item) => {
    if (!isLaunchDependency(item)) {
      throw new Error(`Unsupported launch dependency: ${String(item)}`);
    }
    return item;
  });
}

function isLaunchDependency(value: unknown): value is LaunchDependency {
  return typeof value === 'string' && (LAUNCH_DEPENDENCIES as readonly string[]).includes(value);
}

function isLaunchDependencyValidationError(err: unknown): err is Error {
  return err instanceof Error
    && (err.message === 'dependencies must be an array when supplied'
      || err.message.startsWith('Unsupported launch dependency:'));
}
