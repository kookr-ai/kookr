import type { Hono } from 'hono';
import { stream } from 'hono/streaming';
import {
  LUCY_CONVERSATION_ID_RE,
  LUCY_TURN_CONTENT_TYPE,
  LUCY_TURN_PATH,
  MAX_LUCY_TURN_TEXT_CHARS,
  type LucyTurnErrorCode,
  type LucyTurnEvent,
} from '../../shared/contracts/lucy-turn.js';
import type { LucyOperatorService } from '../lucy-operator/service.js';

export interface LucyOperatorRouteDeps {
  /**
   * Absent when the setting `KOOKR_LUCY_OPERATOR` is off: the route then answers 404
   * and no model is ever called. Present without a `service` when the setting is on
   * but something is missing (for example the OpenRouter key): the route answers 503
   * with `unavailableReason`.
   */
  lucyOperator?: { service?: LucyOperatorService; unavailableReason?: string };
}

function refuse(code: LucyTurnErrorCode, message: string): { error: LucyTurnErrorCode; message: string } {
  return { error: code, message };
}

/**
 * POST /api/lucy/turn: one sentence from the operator in, Lucy's reply out as a stream
 * of newline-delimited JSON events (see `shared/contracts/lucy-turn.ts`).
 *
 * Owner only: like every route except `/api/auth/session`, it is denied to viewers by
 * the API auth middleware. That matters here because her answers draw on every task.
 */
export function registerLucyOperatorRoutes(app: Hono, deps: LucyOperatorRouteDeps): void {
  app.post(LUCY_TURN_PATH, async (c) => {
    if (!deps.lucyOperator) {
      return c.json(refuse('lucy_operator_disabled', 'Lucy\'s conversation is switched off on this server (set KOOKR_LUCY_OPERATOR=true to enable it).'), 404);
    }
    const service = deps.lucyOperator.service;
    if (!service) {
      return c.json(refuse('lucy_operator_unavailable', deps.lucyOperator.unavailableReason ?? 'Lucy\'s conversation is not available on this server.'), 503);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(refuse('bad_request', 'The request body must be JSON: { "text": string, "conversationId": string }.'), 400);
    }
    const { text: rawText, conversationId } = (typeof body === 'object' && body !== null ? body : {}) as { text?: unknown; conversationId?: unknown };
    const text = typeof rawText === 'string' ? rawText.trim() : '';
    if (!text) return c.json(refuse('bad_request', '"text" must be a non-empty string.'), 400);
    if (text.length > MAX_LUCY_TURN_TEXT_CHARS) {
      return c.json(refuse('bad_request', `"text" must be at most ${MAX_LUCY_TURN_TEXT_CHARS} characters.`), 400);
    }
    if (typeof conversationId !== 'string' || !LUCY_CONVERSATION_ID_RE.test(conversationId)) {
      return c.json(refuse('bad_request', '"conversationId" must be 1 to 64 letters, digits, "_" or "-".'), 400);
    }
    if (service.isBusy(conversationId)) {
      return c.json(refuse('turn_in_progress', 'A turn of this conversation is still running. Wait for it to end, or use another conversation id.'), 409);
    }

    if (service.atCapacity()) {
      return c.json(refuse('too_many_turns', 'Too many turns are running at once. Try again in a moment.'), 429);
    }

    // Aborted when the client goes away, so the model call stops instead of running (and costing) to the end.
    const gone = new AbortController();
    c.header('Content-Type', LUCY_TURN_CONTENT_TYPE);
    c.header('Cache-Control', 'no-store');
    // Tells a reverse proxy not to hold the lines back until the response is complete.
    c.header('X-Accel-Buffering', 'no');
    return stream(c, async (out) => {
      out.onAbort(() => gone.abort());
      const events: AsyncGenerator<LucyTurnEvent, void, void> = service.runTurn({ text, conversationId }, gone.signal);
      try {
        for await (const event of events) {
          if (gone.signal.aborted) break;
          await out.write(`${JSON.stringify(event)}\n`);
        }
      } finally {
        // Leaving the loop early must still release the conversation and record the turn.
        await events.return(undefined).catch(() => undefined);
      }
    });
  });
}
