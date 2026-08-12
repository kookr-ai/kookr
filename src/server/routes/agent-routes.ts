import type { Hono } from 'hono';
import { createSnapshotMessage, getAgentStateProjected } from '../use-cases/get-snapshot.js';
import { sendDirectAgentInput } from '../use-cases/agent-input.js';
import { ACTOR_HEADER, resolveLifecycleActor } from '../actor-attribution.js';
import type { AgentRouteDeps } from './shared.js';

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

/** Path-param validator for `:agentId`, `:toolUseId`, and `:sessionId`. Caps
 *  length so oversize inputs 400 before any lookup work, and rejects
 *  path-separator characters as defense in depth against adapters that might
 *  construct a filesystem path from the id. */
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function registerAgentRoutes(app: Hono, deps: AgentRouteDeps): void {
  const { monitor, adapter, interactionLog, broadcastToAll, serverCwd, serverStartedAt, hookIngestion } = deps;

  app.get('/api/agents/:agentId/edit-events/:toolUseId', (c) => {
    const agentId = c.req.param('agentId');
    const toolUseId = c.req.param('toolUseId');

    if (!SAFE_ID_RE.test(agentId)) {
      const body: EditEventMiss = { error: 'invalid_param', field: 'agentId' };
      return c.json(body, 400);
    }
    if (!SAFE_ID_RE.test(toolUseId)) {
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
    if (!SAFE_ID_RE.test(sessionId)) {
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

      // Single-agent lookup by id — resolve just the owning task instead of
      // cloning the whole ~37 MB store (issue #2411).
      const agent = getAgentStateProjected({ monitor, taskStore: deps.taskStore }, agentId);
      if (!agent) {
        return c.json({ error: `Agent not found: ${agentId}` }, 404);
      }

      // Actor attribution (issue #1526 Phase B / FM12): send-text was already
      // part of Lucy's mutation surface during the 2026-07-24 incident, but
      // carried no caller id in the interaction log.
      const actor = resolveLifecycleActor('api', c.req.header(ACTOR_HEADER));
      await sendDirectAgentInput({
        adapter,
        interactionLog,
      }, agentId, body.input, actor.actorId);

      broadcastToAll(createSnapshotMessage({ monitor, serverCwd, activityMetaProvider: hookIngestion, ...(deps.taskStore ? { relationTaskStore: deps.taskStore } : {}) }));
      return c.json({ ok: true, agentId, delivered: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });
}
