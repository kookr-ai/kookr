import type { Hono } from 'hono';
import { discoverPlaybooks } from '../../core/playbook-discovery.js';
import { saveTasks, serializeSnoozed } from '../../core/task-persistence.js';
import { normalizeAgentSelection } from '../../core/agent-types.js';
import { createSnapshotMessage } from '../use-cases/get-snapshot.js';
import { deleteTask } from '../use-cases/delete-task.js';
import { completeTask } from '../agent-lifecycle.js';
import { isTerminalStatus } from '../../core/task-status.js';
import { InvalidTransitionError } from '../../core/tasks.js';
import { redactSecrets } from '../../core/redact-secrets.js';
import {
  AGENT_SIGNAL_KINDS,
  isAgentSignalKind,
  MAX_AGENT_SIGNAL_NOTE_LENGTH,
  type PendingAgentSignal,
} from '../../shared/contracts/agent-signal.js';
import { launchTask, DrainModeError, isEffortValidationError } from '../launch-service.js';
import { LaunchPreflightError } from '../../core/launch-dependency-preflight.js';
import type { LaunchDependency } from '../../core/playbook.js';
import type { Task } from '../../core/tasks.js';
import type { TaskDependencyEdge, TaskMetadataIntent } from '../../shared/contracts/task.js';
import { normalizeTerminalWorktreeHealth } from '../../core/worktree-health.js';
import { isSharedTaskId } from '../../shared/contracts/contact-share.js';
import { CoordinatorSuppressionStore } from '../coordinator/suppression-store.js';
import type { TaskRouteDeps } from './shared.js';

const MAX_TASK_EDGE_COUNT = 64;
const MAX_TASK_EDGE_LENGTH = 240;

export function registerTaskRoutes(app: Hono, deps: TaskRouteDeps): void {
  const { taskStore, monitor, adapter, hookWatcher, watchdog, broadcastToAll, serverCwd, hookIngestion } = deps;
  const coordinatorSuppressions = deps.coordinatorSuppressions ?? new CoordinatorSuppressionStore(deps.kookrDir ?? serverCwd);

  function broadcastSnapshotWithCoordinator(): void {
    broadcastToAll(createSnapshotMessage({
      monitor,
      serverCwd,
      activityMetaProvider: hookIngestion,
      coordinator: { taskStore, auditTailProvider: hookIngestion, suppressions: coordinatorSuppressions },
      relationTaskStore: taskStore,
    }));
  }

  app.get('/api/tasks', (c) => {
    const tasks = taskStore.listTasks().map(normalizeTaskForApi);
    if (!deps.suppressionTracker) return c.json(tasks);
    const tracker = deps.suppressionTracker;
    return c.json(tasks.map((t) => {
      const hasSuppressedSession = t.sessions.some(
        (s) => s.lastStatus !== 'completed' && s.lastStatus !== 'aborted' && tracker.isSuppressed(s.tmuxSession),
      );
      return hasSuppressedSession ? { ...t, suppressed: true } : t;
    }));
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
    if (deps.tasksFile) {
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
        disableDedup?: unknown;
        metadata?: unknown;
        dependencies?: unknown;
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
      // #681: shape check only. The agent-specific allowed-set check runs in
      // launchTask after round-robin resolution and surfaces as a 400 via
      // EffortValidationError (mapped below).
      if (body.effort !== undefined && typeof body.effort !== 'string') {
        return c.json({ error: 'effort must be a string' }, 400);
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
        disableDedup: body.disableDedup === true,
        metadataIntent,
        dependencies: parseLaunchDependencies(body.dependencies),
        launchSource,
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
      await deleteTask({
        adapter,
        monitor,
        taskStore,
        hookWatcher,
        watchdog,
        shadowRegistry: deps.shadowRegistry,
        suppressionTracker: deps.suppressionTracker,
        queue: deps.queue,
        activityLedger: deps.activityLedger,
        hookIngestion: deps.hookIngestion,
      }, id);
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
  // A task completed this way has no completion digest, so it never trips the
  // `done_not_cleared` coordinator finding (that detector only fires on
  // completed tasks that still carry a digest) — yet it is terminal, so it
  // leaves the default actionable list like any other completed task.
  app.post('/api/tasks/:id/complete', async (c) => {
    const id = c.req.param('id');
    if (isSharedTaskId(id)) return c.json({ error: 'SharedTask IDs are remote-owned' }, 403);
    const task = taskStore.getTask(id);
    if (!task) return c.json({ error: 'Task not found' }, 404);

    // Idempotent: re-completing a task that is already `completed`, or one the
    // user deliberately `cancelled`, is a safe no-op (neither can transition to
    // `completed`), so retries and double-clicks are harmless. `terminated` is
    // intentionally NOT short-circuited here — the state machine allows
    // terminated → completed (the documented "acknowledge a dead-session task"
    // path), so we fall through and perform that ack below.
    if (task.status === 'completed' || task.status === 'cancelled') {
      return c.json({ ok: true, task, alreadyTerminal: true });
    }

    // An active Ralph loop owns its own iteration lifecycle: a full completeTask
    // teardown (status flip, lease release, worktree cleanup) here would corrupt
    // the next iteration's state. Refuse rather than silently break the loop —
    // use cancel to stop a loop. This reuses the WS handler's active-loop
    // detection but refuses outright rather than doing the WS path's "complete
    // this iteration" partial session teardown.
    if (task.ralphLoop && (task.ralphLoop.status === 'running' || task.ralphLoop.status === 'paused')) {
      return c.json(
        { error: 'Task has an active Ralph loop; cancel it to stop the loop', code: 'ralph_loop_active' },
        409,
      );
    }

    // Only `inProgress` (finished its work) and `terminated` (dead sessions
    // awaiting ack) can become `completed`. The state machine deliberately
    // forbids open/pending → completed (a task cannot skip inProgress); a task
    // that never started has no deliverable to mark done — delete or cancel it.
    if (task.status !== 'inProgress' && task.status !== 'terminated') {
      return c.json(
        {
          error: `Cannot complete a task in status "${task.status}"; only in-progress or terminated tasks can be completed`,
          code: 'not_in_progress',
        },
        409,
      );
    }

    try {
      await completeTask(id, {
        adapter,
        monitor,
        taskStore,
        hookWatcher,
        watchdog,
        shadowRegistry: deps.shadowRegistry,
        suppressionTracker: deps.suppressionTracker,
        tokenTracker: deps.tokenTracker,
        queue: deps.queue,
        interactionLog: deps.interactionLog,
      });
      // Keep the schedule service in lockstep, exactly as the WS path does, so a
      // scheduled task's execution receipt records the terminal outcome.
      await deps.scheduleService?.recordTaskTerminalOutcome(id, 'completed');
      broadcastSnapshotWithCoordinator();
      return c.json({ ok: true, task: taskStore.getTask(id) });
    } catch (err) {
      // Concurrency: if a racing complete moved the task terminal between our
      // guard read and the transition, taskStore.completeTask throws
      // InvalidTransitionError. That request effectively succeeded — report the
      // idempotent no-op rather than a misleading 500.
      if (err instanceof InvalidTransitionError) {
        const current = taskStore.getTask(id);
        if (current && isTerminalStatus(current.status)) {
          return c.json({ ok: true, task: current, alreadyTerminal: true });
        }
      }
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
    if (body.note !== undefined) {
      if (typeof body.note !== 'string') {
        return c.json({ error: 'note must be a string when supplied' }, 400);
      }
      const trimmed = body.note.slice(0, MAX_AGENT_SIGNAL_NOTE_LENGTH);
      const redacted = redactSecrets(trimmed).trim();
      if (redacted) note = redacted;
    }

    const signal: PendingAgentSignal = {
      kind: body.kind,
      raisedAt: new Date().toISOString(),
      ...(note ? { note } : {}),
    };
    taskStore.setPendingSignal(id, signal);
    broadcastSnapshotWithCoordinator();
    return c.json({ ok: true, signal });
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

function normalizeTaskForApi(task: Task): Task {
  let changed = false;
  const sessions = task.sessions.map((session) => {
    const worktreeHealth = normalizeTerminalWorktreeHealth(task.status, session.worktreeHealth);
    if (worktreeHealth === session.worktreeHealth) return session;
    changed = true;
    return { ...session, worktreeHealth };
  });

  return changed ? { ...task, sessions } : task;
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
    if (item !== 'kb') throw new Error(`Unsupported launch dependency: ${String(item)}`);
    return item;
  });
}

function isLaunchDependencyValidationError(err: unknown): err is Error {
  return err instanceof Error
    && (err.message === 'dependencies must be an array when supplied'
      || err.message.startsWith('Unsupported launch dependency:'));
}
