import type { Hono } from 'hono';
import { ASK_LIMITS, type AskState, type CreateAskError } from '../../shared/contracts/asks.js';
import { toAskView, type AskService } from '../asks/ask-service.js';

export interface AskRouteDeps {
  /** Undefined when Telegram is not configured: POST then 503s and reads are empty (flag-off behaviour). */
  service?: AskService;
}

const ASK_STATES: readonly AskState[] = ['pending', 'answered', 'expired', 'cancelled'];

function errorResponse(error: CreateAskError): { status: 400 | 404 | 409 | 422 | 429 | 502 | 503; body: Record<string, unknown> } {
  switch (error.code) {
    case 'not_configured':
      return { status: 503, body: { error: 'Telegram is not configured; `kookr ask` is unavailable.', code: 'not_configured' } };
    case 'unknown_task':
      return { status: 404, body: { error: 'unknown taskId', code: 'unknown_task' } };
    case 'terminal_task':
      return { status: 409, body: { error: 'task is already terminal', code: 'terminal_task' } };
    case 'invalid':
      return { status: 400, body: { error: error.message, code: 'invalid' } };
    case 'redacted_option':
      return { status: 422, body: { error: 'an option label looks like a credential and was refused', code: 'redacted_option' } };
    case 'rate_limited':
      return { status: 429, body: { error: `ask rate limit reached (${error.scope})`, code: 'rate_limited', scope: error.scope } };
    case 'delivery_failed':
      return { status: 502, body: { error: `could not deliver the question: ${error.message}`, code: 'delivery_failed' } };
  }
}

/**
 * `kookr ask` routes. Deliberately no route that records an answer: the only
 * answer channel is the authenticated Telegram path, so an agent cannot answer
 * its own question over HTTP.
 */
export function registerAskRoutes(app: Hono, deps: AskRouteDeps): void {
  const { service } = deps;

  app.post('/api/asks', async (c) => {
    if (!service) {
      const { status, body } = errorResponse({ code: 'not_configured' });
      return c.json(body, status);
    }
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid JSON body', code: 'invalid' }, 400);
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ error: 'body must be a JSON object', code: 'invalid' }, 400);
    }
    const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
    const taskId = str(body.taskId);
    const question = str(body.question);
    const options = body.options;
    if (!taskId) return c.json({ error: 'taskId is required', code: 'invalid' }, 400);
    if (question === undefined) return c.json({ error: 'question is required', code: 'invalid' }, 400);
    if (!Array.isArray(options) || !options.every((o) => typeof o === 'string')) {
      return c.json({ error: 'options must be an array of strings', code: 'invalid' }, 400);
    }
    if (body.context !== undefined && typeof body.context !== 'string') {
      return c.json({ error: 'context must be a string', code: 'invalid' }, 400);
    }
    if (body.timeoutSec !== undefined && typeof body.timeoutSec !== 'number') {
      return c.json({ error: 'timeoutSec must be a number', code: 'invalid' }, 400);
    }
    if (body.idempotencyKey !== undefined && typeof body.idempotencyKey !== 'string') {
      return c.json({ error: 'idempotencyKey must be a string', code: 'invalid' }, 400);
    }
    if (body.allowText !== undefined && typeof body.allowText !== 'boolean') {
      return c.json({ error: 'allowText must be a boolean', code: 'invalid' }, 400);
    }

    const result = await service.create({
      taskId,
      question,
      options: options as string[],
      ...(str(body.context) !== undefined ? { context: str(body.context) } : {}),
      ...(typeof body.timeoutSec === 'number' ? { timeoutSec: body.timeoutSec } : {}),
      ...(str(body.idempotencyKey) !== undefined ? { idempotencyKey: str(body.idempotencyKey) } : {}),
      ...(typeof body.allowText === 'boolean' ? { allowText: body.allowText } : {}),
    });
    if (!result.ok) {
      const { status, body: errBody } = errorResponse(result.error);
      return c.json(errBody, status);
    }
    return c.json(
      { ask: toAskView(result.ask), deduped: result.deduped, redacted: result.redacted },
      result.deduped ? 200 : 201,
    );
  });

  app.get('/api/asks', async (c) => {
    if (!service) return c.json({ asks: [], limits: ASK_LIMITS });
    const state = c.req.query('state');
    if (state !== undefined && !ASK_STATES.includes(state as AskState)) {
      return c.json({ error: `state must be one of ${ASK_STATES.join(', ')}`, code: 'invalid' }, 400);
    }
    const asks = await service.list({
      ...(c.req.query('taskId') ? { taskId: c.req.query('taskId') } : {}),
      ...(state ? { state: state as AskState } : {}),
    });
    return c.json({ asks: asks.map(toAskView), limits: ASK_LIMITS });
  });

  app.get('/api/asks/:id', async (c) => {
    if (!service) return c.json({ error: 'ask not found', code: 'not_found' }, 404);
    const ask = await service.get(c.req.param('id'));
    if (!ask) return c.json({ error: 'ask not found', code: 'not_found' }, 404);
    return c.json({ ask: toAskView(ask) });
  });

  app.post('/api/asks/:id/cancel', async (c) => {
    if (!service) return c.json({ error: 'ask not found', code: 'not_found' }, 404);
    const result = await service.cancel(c.req.param('id'));
    if (!result.ok) {
      return result.reason === 'not_found'
        ? c.json({ error: 'ask not found', code: 'not_found' }, 404)
        : c.json({ error: 'ask is no longer pending', code: 'not_pending' }, 409);
    }
    return c.json({ ask: toAskView(result.ask) });
  });
}
