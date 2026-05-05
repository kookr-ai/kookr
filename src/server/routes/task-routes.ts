import type { Hono } from 'hono';
import { discoverPlaybooks } from '../../core/playbook-discovery.js';
import { normalizeAgentType } from '../../core/agent-types.js';
import { createSnapshotMessage, getSnapshotAgentsRaw } from '../use-cases/get-snapshot.js';
import { sendDirectAgentInput } from '../use-cases/agent-input.js';
import { deleteTask } from '../use-cases/delete-task.js';
import { launchTask } from '../launch-service.js';
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
}
