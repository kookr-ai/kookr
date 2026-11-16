import type { Hono } from 'hono';

import { ReadyQueueFullError, type ReadyQueueService } from '../ready-queue-service.js';
import { ACTOR_HEADER } from '../actor-attribution.js';

/**
 * Ready-queue routes (issue #3933).
 *
 * - `POST /api/ready-queue` stores a `POST /api/tasks` body for later instead
 *   of launching it. Only the shape is checked here; the full validation runs
 *   when the tick starts the entry through the real POST /api/tasks handler.
 * - `GET /api/ready-queue` lists every entry (queued, launching, and started or
 *   failed in the last 24 hours) plus the health snapshot.
 * - `DELETE /api/ready-queue/:id` removes one entry.
 */
export function registerReadyQueueRoutes(app: Hono, deps: { readyQueue?: ReadyQueueService }): void {
  const readyQueue = deps.readyQueue;
  if (!readyQueue) return;

  app.get('/api/ready-queue', (c) => c.json({
    entries: readyQueue.list(),
    health: readyQueue.getHealthSnapshot(),
  }));

  app.post('/api/ready-queue', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'body must be a JSON object' }, 400);
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return c.json({ error: 'body must be a JSON object (the POST /api/tasks body)' }, 400);
    }
    const request = body as Record<string, unknown>;
    if (typeof request.cwd !== 'string' || request.cwd.length === 0) {
      return c.json({ error: 'cwd is required and must be a string' }, 400);
    }
    if (request.playbook === undefined && (typeof request.prompt !== 'string' || request.prompt.length === 0)) {
      return c.json({ error: 'prompt is required and must be a string' }, 400);
    }
    if (request.idempotencyKey !== undefined
      && (typeof request.idempotencyKey !== 'string' || request.idempotencyKey.length === 0)) {
      return c.json({ error: 'idempotencyKey must be a non-empty string' }, 400);
    }
    const rawSource = c.req.header('X-Kookr-Launch-Source');
    const launchSource = rawSource === 'cli' || rawSource === 'ui' ? rawSource : 'api';
    const actor = c.req.header(ACTOR_HEADER)?.trim() || undefined;
    try {
      const { entry, created } = await readyQueue.enqueue({
        request,
        launchSource,
        ...(actor ? { actor } : {}),
      });
      const position = readyQueue.list()
        .filter((candidate) => candidate.state === 'queued')
        .findIndex((candidate) => candidate.id === entry.id);
      return c.json({
        entry,
        created,
        ...(position >= 0 ? { position: position + 1 } : {}),
      }, created ? 201 : 200);
    } catch (err) {
      if (err instanceof ReadyQueueFullError) {
        return c.json({ error: err.message, code: err.code, limit: err.limit }, 429);
      }
      throw err;
    }
  });

  app.delete('/api/ready-queue/:id', async (c) => {
    const id = c.req.param('id');
    const result = await readyQueue.remove(id);
    if (result === 'not_found') return c.json({ error: `No ready-queue entry ${id}`, code: 'not_found' }, 404);
    if (result === 'launching') {
      return c.json({ error: `Entry ${id} is being started right now; try again in a few seconds`, code: 'launching' }, 409);
    }
    return c.json({ ok: true, id });
  });
}
