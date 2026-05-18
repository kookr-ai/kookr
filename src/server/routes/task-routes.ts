import type { Hono } from 'hono';
import { discoverPlaybooks } from '../../core/playbook-discovery.js';
import { normalizeAgentSelection } from '../../core/agent-types.js';
import { CodexRolloutScanner } from '../../adapters/codex-rollout-scanner.js';
import { aggregate as aggregateCostComparison } from '../../core/cost-comparison-aggregator.js';
import type { CostAgent, TimeWindow } from '../../shared/contracts/cost-comparison.js';
import { clampScanStart, loadHistoricalTasks } from '../use-cases/load-historical-tasks.js';
import { createSnapshotMessage, getSnapshotAgentsRaw } from '../use-cases/get-snapshot.js';
import { sendDirectAgentInput } from '../use-cases/agent-input.js';
import { deleteTask } from '../use-cases/delete-task.js';
import { launchTask } from '../launch-service.js';
import { LaunchPreflightError } from '../../core/launch-dependency-preflight.js';
import type { LaunchDependency } from '../../core/playbook.js';
import type { Task } from '../../core/tasks.js';
import { normalizeTerminalWorktreeHealth } from '../../core/worktree-health.js';
import { isSharedTaskId } from '../../shared/contracts/contact-share.js';
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
  const { taskStore, monitor, adapter, hookWatcher, watchdog, interactionLog, broadcastToAll, serverCwd, serverStartedAt, hookIngestion } = deps;

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

  app.post('/api/tasks', async (c) => {
    try {
      const body = await c.req.json() as {
        prompt?: string;
        cwd?: string;
        criteria?: string;
        parentTaskId?: string;
        agentType?: string;
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

      const rawSource = c.req.header('X-Kookr-Launch-Source');
      const launchSource: 'cli' | 'ui' | 'api' =
        rawSource === 'cli' || rawSource === 'ui' ? rawSource : 'api';
      const { task, queued, duplicate } = await launchTask(deps.launchServiceDeps, {
        prompt: body.prompt,
        cwd: body.cwd,
        criteria: body.criteria,
        parentTaskId: body.parentTaskId,
        agentType: body.agentType ? normalizeAgentSelection(body.agentType) : undefined,
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
    const scan = await scanner.scan(effectiveScanStartMs, windowEndMs);
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
