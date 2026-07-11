import type { Hono } from 'hono';
import type { TaskStore } from '../../core/tasks.js';
import type {
  ReconnectTransportReason,
  ReconnectTransportResult,
  TerminalBackend,
} from '../../adapters/terminal-backend.js';

/**
 * Session-transport routes (kookr-ai/kookr#1347).
 *
 * Exposes the safe "Reconnect terminal transport" operator action:
 *
 *   POST /api/tasks/:taskId/sessions/:sessionId/reconnect-transport
 *
 * It rebuilds ONLY Kookr's internal dtach attach child (fresh attach
 * generation, reapplied size, preserved ring + SessionBridge consumers) after
 * verifying the dtach master pid + socket still belong to the session. It
 * NEVER writes terminal input and NEVER relaunches the agent — the dtach master
 * pid and agent pid are preserved and reported.
 *
 * Authorization: the whole route lives under `/api/*`, which the actor gate
 * makes owner-only — read-only / shared viewers can reach only
 * `/api/auth/session` (see viewer-data-policy.ts), so they can never invoke
 * this action. The per-session serialization, cooldown, and retry cap live in
 * the backend (`reconnectTransport`), so duplicate clicks collapse to one
 * attempt and storms are rejected regardless of how many browser tabs fire.
 */
export interface SessionTransportRouteDeps {
  taskStore: TaskStore;
  terminalBackend?: TerminalBackend;
}

/** Map a reconnect result onto an HTTP status. */
function statusForResult(result: ReconnectTransportResult): 200 | 409 | 429 | 502 {
  if (result.outcome === 'success' || result.outcome === 'inconclusive') return 200;
  return statusForFailureReason(result.reason);
}

function statusForFailureReason(reason: ReconnectTransportReason): 409 | 429 | 502 {
  switch (reason) {
    case 'cooldown':
    case 'retry-cap':
      // Actionable rate-limit: retry after the cooldown / window.
      return 429;
    case 'attach-spawn-failed':
      // The transport genuinely could not be rebuilt.
      return 502;
    default:
      // session-unknown / socket-missing / identity-unverified — the session
      // state cannot be confirmed, so the request conflicts with reality.
      return 409;
  }
}

export function registerSessionTransportRoutes(app: Hono, deps: SessionTransportRouteDeps): void {
  const { taskStore } = deps;

  app.post('/api/tasks/:taskId/sessions/:sessionId/reconnect-transport', async (c) => {
    const taskId = c.req.param('taskId');
    const sessionId = c.req.param('sessionId');

    const task = taskStore.getTask(taskId);
    if (!task) return c.json({ error: 'Task not found' }, 404);
    const session = task.sessions.find((s) => s.tmuxSession === sessionId);
    if (!session) return c.json({ error: 'Session not found for task' }, 404);

    const backend = deps.terminalBackend;
    if (!backend?.reconnectTransport) {
      return c.json({ error: 'Reconnect transport not supported by this backend' }, 501);
    }

    // Optional body: { reason?, livenessTimeoutMs? }. Parsed by hand rather than
    // via `c.req.json()` on purpose: the action needs no input, so a missing or
    // empty body must be tolerated (Hono's `c.req.json()` throws on an empty
    // body), while a present-but-malformed body is an explicit 400.
    let reason: string | undefined;
    let livenessTimeoutMs: number | undefined;
    const raw = await c.req.text();
    if (raw.trim()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return c.json({ error: 'invalid-json' }, 400);
      }
      if (parsed && typeof parsed === 'object') {
        const body = parsed as { reason?: unknown; livenessTimeoutMs?: unknown };
        if (typeof body.reason === 'string') reason = body.reason.slice(0, 500);
        if (
          typeof body.livenessTimeoutMs === 'number'
          && Number.isFinite(body.livenessTimeoutMs)
          && body.livenessTimeoutMs > 0
        ) {
          livenessTimeoutMs = Math.min(body.livenessTimeoutMs, 30_000);
        }
      }
    }

    let result: ReconnectTransportResult;
    try {
      result = await backend.reconnectTransport(sessionId, {
        actor: 'owner',
        ...(reason ? { reason } : {}),
        ...(livenessTimeoutMs ? { livenessTimeoutMs } : {}),
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }

    return c.json({ taskId, sessionId, ...result }, statusForResult(result));
  });
}
