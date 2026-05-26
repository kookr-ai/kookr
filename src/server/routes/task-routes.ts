import type { Hono } from 'hono';
import { discoverPlaybooks } from '../../core/playbook-discovery.js';
import { saveTasks, serializeSnoozed } from '../../core/task-persistence.js';
import { normalizeAgentSelection } from '../../core/agent-types.js';
import { CodexRolloutScanner } from '../../adapters/codex-rollout-scanner.js';
import { aggregate as aggregateCostComparison } from '../../core/cost-comparison-aggregator.js';
import type { CostAgent, TimeWindow } from '../../shared/contracts/cost-comparison.js';
import { clampScanStart, loadHistoricalTasks } from '../use-cases/load-historical-tasks.js';
import { buildCoordinatorDetectorTasks, createSnapshotMessage, getSnapshotAgentsRaw } from '../use-cases/get-snapshot.js';
import { sendDirectAgentInput } from '../use-cases/agent-input.js';
import { deleteTask } from '../use-cases/delete-task.js';
import { completeTask as completeTaskLifecycle } from '../agent-lifecycle.js';
import { launchTask } from '../launch-service.js';
import { LaunchPreflightError } from '../../core/launch-dependency-preflight.js';
import type { LaunchDependency } from '../../core/playbook.js';
import type { Task } from '../../core/tasks.js';
import type { TaskDependencyEdge, TaskMetadataIntent } from '../../shared/contracts/task.js';
import {
  isTaskRelationLifecycle,
  isTaskRelationSource,
  isTaskRelationType,
  type TaskRelationInput,
} from '../../shared/contracts/task-relations.js';
import { normalizeTerminalWorktreeHealth } from '../../core/worktree-health.js';
import { isSharedTaskId } from '../../shared/contracts/contact-share.js';
import { buildCoordinatorSnapshotState } from '../coordinator/detectors.js';
import { CoordinatorSuppressionStore } from '../coordinator/suppression-store.js';
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
const MAX_TASK_EDGE_COUNT = 64;
const MAX_TASK_EDGE_LENGTH = 240;

/** Same shape as EDIT_EVENT_PARAM_RE — reused for session id params that must
 *  not carry path-separator characters. Defense in depth against any future
 *  adapter that might construct a filesystem path from the id. */
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function registerTaskRoutes(app: Hono, deps: RouteDeps): void {
  const { taskStore, monitor, adapter, hookWatcher, watchdog, interactionLog, broadcastToAll, serverCwd, serverStartedAt, hookIngestion } = deps;
  const coordinatorSuppressions = deps.coordinatorSuppressions ?? new CoordinatorSuppressionStore(deps.kookrDir ?? serverCwd);

  function coordinatorSnapshot() {
    const agents = getSnapshotAgentsRaw({ monitor, activityMetaProvider: hookIngestion });
    return buildCoordinatorSnapshotState(
      { tasks: buildCoordinatorDetectorTasks(taskStore.listTasks(), agents) },
      hookIngestion?.getCoordinatorAuditTail() ?? [],
      { suppressions: coordinatorSuppressions },
    );
  }

  function broadcastSnapshotWithCoordinator(): void {
    broadcastToAll(createSnapshotMessage({
      monitor,
      serverCwd,
      activityMetaProvider: hookIngestion,
      coordinator: { taskStore, auditTailProvider: hookIngestion, suppressions: coordinatorSuppressions },
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
    broadcastToAll(createSnapshotMessage({ monitor, serverCwd, activityMetaProvider: hookIngestion }));
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

  app.post('/api/coordinator/suppressions', async (c) => {
    let body: { taskId?: unknown; detectorId?: unknown; agentType?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    if (!isCoordinatorDetectorId(body.detectorId)) return c.json({ error: 'detectorId is required' }, 400);
    const task = typeof body.taskId === 'string' ? taskStore.getTask(body.taskId) : undefined;
    const agentType = isAgentType(body.agentType) ? body.agentType : task?.agentType;
    if (!agentType) return c.json({ error: 'agentType or valid taskId is required' }, 400);

    const suppression = coordinatorSuppressions.suppress(body.detectorId, agentType);
    broadcastSnapshotWithCoordinator();
    return c.json({ ok: true, suppression });
  });

  app.post('/api/coordinator/acknowledgements', async (c) => {
    let body: { taskId?: unknown; detectorId?: unknown; agentType?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    if (typeof body.taskId !== 'string') return c.json({ error: 'taskId is required' }, 400);
    if (!isCoordinatorDetectorId(body.detectorId)) return c.json({ error: 'detectorId is required' }, 400);
    const task = taskStore.getTask(body.taskId);
    if (!task) return c.json({ error: 'Task not found' }, 404);
    const agentType = isAgentType(body.agentType) ? body.agentType : task.agentType;

    const acknowledgement = coordinatorSuppressions.acknowledgeTask(body.detectorId, agentType, task.id);
    broadcastSnapshotWithCoordinator();
    return c.json({ ok: true, acknowledgement });
  });

  app.post('/api/coordinator/mark-prior-done', async (c) => {
    let body: { taskId?: unknown; priorTaskIds?: unknown; concurrencyToken?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    if (typeof body.taskId !== 'string') return c.json({ error: 'taskId is required' }, 400);
    if (!Array.isArray(body.priorTaskIds) || !body.priorTaskIds.every((id) => typeof id === 'string')) {
      return c.json({ error: 'priorTaskIds must be a string array' }, 400);
    }
    if (typeof body.concurrencyToken !== 'string') return c.json({ error: 'concurrencyToken is required' }, 400);
    if (!taskStore.getTask(body.taskId)) return c.json({ error: 'Task not found' }, 404);

    for (const priorTaskId of body.priorTaskIds) {
      await deps.githubScanner.refreshTaskState(priorTaskId);
    }

    const fresh = coordinatorSnapshot();
    const chain = fresh.chains[body.taskId];
    if (!chain || chain.concurrencyToken !== body.concurrencyToken) {
      return c.json({ error: 'Coordinator state changed; review the refreshed chain strip before applying the batch action.' }, 409);
    }
    if (!sameStringSet(body.priorTaskIds, chain.priorTaskIds)) {
      return c.json({ error: 'Submitted prior tasks no longer match the refreshed chain strip.' }, 409);
    }

    for (const priorTaskId of body.priorTaskIds) {
      const prior = taskStore.getTask(priorTaskId);
      if (!prior) return c.json({ error: `Prior task not found: ${priorTaskId}` }, 409);
      if (prior.status !== 'terminated' && prior.status !== 'completed') {
        return c.json({ error: `Prior task ${priorTaskId.slice(0, 8)} is ${prior.status}; only terminated tasks can be marked done automatically.` }, 409);
      }
      const gh = deps.githubStateStore.getTaskState(priorTaskId);
      const merged = gh.prs.find((pr) => pr.status === 'merged');
      if (!merged) {
        return c.json({ error: `Prior task ${priorTaskId.slice(0, 8)} has no freshly verified merged PR.` }, 409);
      }
      const failedCheck = merged.checks.find((check) => (
        check.status !== 'completed'
        || (check.conclusion !== 'success' && check.conclusion !== 'neutral' && check.conclusion !== 'skipped')
      ));
      if (failedCheck) {
        return c.json({ error: `Prior task ${priorTaskId.slice(0, 8)} has non-passing post-merge CI: ${failedCheck.name}.` }, 409);
      }
      const dirtySession = prior.sessions.find((session) => session.worktreeHealth && session.worktreeHealth !== 'ok');
      if (dirtySession) {
        return c.json({ error: `Prior task ${priorTaskId.slice(0, 8)} worktree is ${dirtySession.worktreeHealth}.` }, 409);
      }
    }

    for (const priorTaskId of body.priorTaskIds) {
      const prior = taskStore.getTask(priorTaskId);
      if (prior && prior.status !== 'completed') {
        await completeTaskLifecycle(priorTaskId, {
          adapter,
          monitor,
          taskStore,
          interactionLog,
          hookWatcher,
          watchdog,
          shadowRegistry: deps.shadowRegistry,
          suppressionTracker: deps.suppressionTracker,
          queue: deps.queue,
        });
      }
    }
    broadcastSnapshotWithCoordinator();
    return c.json({ ok: true, completedTaskIds: body.priorTaskIds });
  });

  app.post('/api/tasks', async (c) => {
    try {
      const body = await c.req.json() as {
        prompt?: string;
        cwd?: string;
        criteria?: string;
        parentTaskId?: string;
        agentType?: string;
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

      const rawSource = c.req.header('X-Kookr-Launch-Source');
      const launchSource: 'cli' | 'ui' | 'api' =
        rawSource === 'cli' || rawSource === 'ui' ? rawSource : 'api';
      const { task, queued, duplicate } = await launchTask(deps.launchServiceDeps, {
        prompt: body.prompt,
        cwd: body.cwd,
        criteria: body.criteria,
        parentTaskId: body.parentTaskId,
        agentType: body.agentType ? normalizeAgentSelection(body.agentType) : undefined,
        disableDedup: body.disableDedup === true,
        metadataIntent,
        dependencies: parseLaunchDependencies(body.dependencies),
        launchSource,
      });

      if (duplicate) {
        return c.json({ task, duplicate: true }, 200);
      }

      broadcastToAll(createSnapshotMessage({ monitor, serverCwd, activityMetaProvider: hookIngestion }));
      return c.json({ ...task, ...(queued ? { queued: true } : {}) }, 201);
    } catch (err) {
      if (isLaunchDependencyValidationError(err)) {
        return c.json({ error: err.message }, 400);
      }
      if (err instanceof LaunchPreflightError) {
        return c.json({ error: err.message, code: 'launch_preflight_failed', findings: err.findings }, 409);
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
      broadcastToAll(createSnapshotMessage({ monitor, serverCwd, activityMetaProvider: hookIngestion }));
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
      }, agentId, body.input);

      broadcastToAll(createSnapshotMessage({ monitor, serverCwd, activityMetaProvider: hookIngestion }));
      return c.json({ ok: true, agentId, delivered: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  // ---------------------------------------------------------------------------
  // Typed task-relation graph (issue #599). Read endpoint returns the full
  // graph; write endpoint upserts a single relation keyed by
  // (sourceTaskId, targetTaskId, type) so duplicate submissions are idempotent.
  // ---------------------------------------------------------------------------

  app.get('/api/task-relations', (c) => {
    const sourceTaskId = c.req.query('sourceTaskId') || undefined;
    const targetTaskId = c.req.query('targetTaskId') || undefined;
    const taskId = c.req.query('taskId') || undefined;
    const rawType = c.req.query('type');
    if (rawType !== undefined && !isTaskRelationType(rawType)) {
      return c.json({ error: 'invalid relation type' }, 400);
    }
    const relations = taskStore.listRelations({
      sourceTaskId,
      targetTaskId,
      taskId,
      type: rawType,
    });
    return c.json({ relations });
  });

  app.post('/api/task-relations', async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json() as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const input = parseTaskRelationInput(body);
    if (input instanceof Error) return c.json({ error: input.message }, 400);
    if (!taskStore.getTask(input.sourceTaskId)) {
      return c.json({ error: `Source task not found: ${input.sourceTaskId}` }, 404);
    }
    if (!taskStore.getTask(input.targetTaskId)) {
      return c.json({ error: `Target task not found: ${input.targetTaskId}` }, 404);
    }
    const relation = taskStore.upsertRelation(input);
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
    return c.json({ ok: true, relation });
  });

  // ---------------------------------------------------------------------------
  // Cost comparison (rfc-cost-comparison-panel.md). Read-only telemetry route.
  // Originally flag-gated behind KOOKR_COST_PANEL=1 for PR 3 rollback safety;
  // ungated post-merge once the panel proved stable.
  // ---------------------------------------------------------------------------

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
    // Union live + on-disk snapshots. The live store only holds currently-visible
    // tasks; everything swept lives in tasks.json.daily.* / tasks.json.predelete.*.
    // Without this union the panel renders structurally empty against any swept
    // task history (rfc-cost-comparison-coverage-and-perf.md §Change 1).
    const liveTasks = taskStore.listTasks();
    const tasks = deps.tasksFile
      ? await loadHistoricalTasks(liveTasks, deps.tasksFile)
      : liveTasks;
    const codexTasks = tasks
      .filter(t => t.agentType === 'codex-cli')
      .map(t => {
        // Use the first session's cwd (the actual cwd Codex saw) when present;
        // task.cwd is the user-supplied launch cwd which may differ.
        const sessionCwd = t.sessions[0]?.cwd;
        const created = t.createdAt instanceof Date ? t.createdAt.getTime() : new Date(t.createdAt).getTime();
        return { taskId: t.id, cwd: sessionCwd ?? t.cwd, createdAtMs: created };
      });

    // Clamp the directory walk so window=all stops walking 57 years of empty
    // UTC date directories (rfc-cost-comparison-coverage-and-perf.md §Change 3).
    const effectiveScanStartMs = clampScanStart(windowStartMs, windowEndMs, tasks);

    const scanStart = Date.now();
    let scan;
    try {
      scan = await scanner.scan(effectiveScanStartMs, windowEndMs, { signal: c.req.raw.signal });
    } catch (err) {
      if (isAbortError(err)) {
        return new Response(null, { status: 499 });
      }
      throw err;
    }
    const { outcomes, orphanBindings } = scanner.bindTasks(scan.rollouts, codexTasks);

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
        orphanBindings,
      },
      scannedAt: new Date().toISOString(),
      scanDurationMs: Date.now() - scanStart,
    });

    return c.json(response);
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

function isCoordinatorDetectorId(value: unknown): value is 'declared_edge' | 'stale' | 'duplicate' | 'done_not_cleared' {
  return value === 'declared_edge' || value === 'stale' || value === 'duplicate' || value === 'done_not_cleared';
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

function isAgentType(value: unknown): value is 'claude-code' | 'codex-cli' {
  return value === 'claude-code' || value === 'codex-cli';
}

function sameStringSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  if (new Set(left).size !== left.length || new Set(right).size !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((item) => rightSet.has(item));
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

// Singleton scanner — its in-memory (path, mtime) cache outlives a single
// request so warm scans hit the < 200 ms target (R6).
const costScannerSingleton = new CodexRolloutScanner();

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

const MAX_RELATION_EVIDENCE_ENTRIES = 16;
const MAX_RELATION_EVIDENCE_FIELD_LENGTH = 4096;

function parseTaskRelationInput(body: Record<string, unknown>): TaskRelationInput | Error {
  if (typeof body.sourceTaskId !== 'string' || body.sourceTaskId.length === 0) {
    return new Error('sourceTaskId is required and must be a string');
  }
  if (typeof body.targetTaskId !== 'string' || body.targetTaskId.length === 0) {
    return new Error('targetTaskId is required and must be a string');
  }
  if (body.sourceTaskId === body.targetTaskId) {
    return new Error('sourceTaskId and targetTaskId must differ');
  }
  if (!isTaskRelationType(body.type)) {
    return new Error('type is required and must be a valid relation type');
  }
  if (typeof body.confidence !== 'number' || !Number.isFinite(body.confidence) || body.confidence < 0 || body.confidence > 1) {
    return new Error('confidence is required and must be a number in [0, 1]');
  }
  if (!isTaskRelationSource(body.source)) {
    return new Error('source is required and must be a valid relation source');
  }
  if (body.lifecycle !== undefined && !isTaskRelationLifecycle(body.lifecycle)) {
    return new Error('lifecycle must be active, superseded, or rejected');
  }
  const evidence: TaskRelationInput['evidence'] = [];
  if (body.evidence !== undefined) {
    if (!Array.isArray(body.evidence)) return new Error('evidence must be an array');
    if (body.evidence.length > MAX_RELATION_EVIDENCE_ENTRIES) {
      return new Error(`evidence cannot contain more than ${MAX_RELATION_EVIDENCE_ENTRIES} entries`);
    }
    for (const entry of body.evidence) {
      if (!entry || typeof entry !== 'object') return new Error('evidence entries must be objects');
      const e = entry as { snippet?: unknown; path?: unknown; observedAt?: unknown };
      if (typeof e.observedAt !== 'string' || e.observedAt.length === 0) {
        return new Error('evidence.observedAt is required and must be a string');
      }
      if (e.snippet !== undefined && (typeof e.snippet !== 'string' || e.snippet.length > MAX_RELATION_EVIDENCE_FIELD_LENGTH)) {
        return new Error(`evidence.snippet must be a string of at most ${MAX_RELATION_EVIDENCE_FIELD_LENGTH} chars`);
      }
      if (e.path !== undefined && (typeof e.path !== 'string' || e.path.length > MAX_RELATION_EVIDENCE_FIELD_LENGTH)) {
        return new Error(`evidence.path must be a string of at most ${MAX_RELATION_EVIDENCE_FIELD_LENGTH} chars`);
      }
      evidence.push({
        ...(typeof e.snippet === 'string' ? { snippet: e.snippet } : {}),
        ...(typeof e.path === 'string' ? { path: e.path } : {}),
        observedAt: e.observedAt,
      });
    }
  }
  return {
    sourceTaskId: body.sourceTaskId,
    targetTaskId: body.targetTaskId,
    type: body.type,
    confidence: body.confidence,
    source: body.source,
    evidence,
    ...(isTaskRelationLifecycle(body.lifecycle) ? { lifecycle: body.lifecycle } : {}),
  };
}
