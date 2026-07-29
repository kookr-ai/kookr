import type { Hono } from 'hono';
import type { EnvironmentBlockerRegistry } from '../../core/environment-blocker-registry.js';

export interface EnvironmentBlockerRouteDeps {
  registry: EnvironmentBlockerRegistry;
}

const ENVIRONMENT_BLOCKERS_PATH = '/api/environment-blockers';

/**
 * Validate the `type`/`scope` identity fields shared by every write endpoint.
 * Both must be non-empty strings and must not contain the `:` character: the
 * registry keys blockers as `${type}:${scope}`, so a `:` in either field would
 * let two semantically distinct blockers collide onto one key. Returns an error
 * message to send as a 400, or `null` when both fields are valid.
 */
function validateTypeScope(body: Record<string, unknown>): string | null {
  for (const field of ['type', 'scope'] as const) {
    const value = body[field];
    if (typeof value !== 'string' || value.length === 0) {
      return `${field} is required and must be a non-empty string`;
    }
    if (value.includes(':')) {
      return `${field} must not contain ':' (reserved as the blocker key delimiter)`;
    }
  }
  return null;
}

/**
 * Environment-blocker registry routes (issue #1690), following the
 * `registerXRoutes(app, deps)` convention (see `issue-claim-routes.ts`).
 *
 * - `GET  /api/environment-blockers` — list active blockers, or
 *   consult one via `?type=&scope=` (returns a `blocked_external` disposition).
 * - `POST /api/environment-blockers` — register-once. Body:
 *   `{ type, scope, detectedBy?, probe?, reason? }`. Returns `{ blocker, newlyRegistered }`.
 * - `POST /api/environment-blockers/probe` — record a probe outcome. Body:
 *   `{ type, scope, success }`. A success auto-clears the blocker.
 * - `DELETE /api/environment-blockers` — manual clear. Body: `{ type, scope }`.
 */
export function registerEnvironmentBlockerRoutes(app: Hono, deps: EnvironmentBlockerRouteDeps): void {
  app.get(ENVIRONMENT_BLOCKERS_PATH, (c) => {
    const type = c.req.query('type');
    const scope = c.req.query('scope');
    if (type !== undefined || scope !== undefined) {
      if (!type || !scope) {
        return c.json({ error: 'both type and scope are required to consult a blocker' }, 400);
      }
      return c.json(deps.registry.consult(type, scope));
    }
    return c.json(deps.registry.list());
  });

  app.post(ENVIRONMENT_BLOCKERS_PATH, async (c) => {
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const validationError = validateTypeScope(body);
    if (validationError) {
      return c.json({ error: validationError }, 400);
    }
    const type = body.type as string;
    const scope = body.scope as string;
    const result = await deps.registry.register({
      type,
      scope,
      ...(typeof body.detectedBy === 'string' ? { detectedBy: body.detectedBy } : {}),
      ...(typeof body.probe === 'string' ? { probe: body.probe } : {}),
      ...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
    });
    return c.json(result);
  });

  app.post(`${ENVIRONMENT_BLOCKERS_PATH}/probe`, async (c) => {
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const validationError = validateTypeScope(body);
    if (validationError) {
      return c.json({ error: validationError }, 400);
    }
    const success = body.success;
    if (typeof success !== 'boolean') {
      return c.json({ error: 'success is required and must be a boolean' }, 400);
    }
    const result = await deps.registry.recordProbeResult(body.type as string, body.scope as string, success);
    return c.json(result);
  });

  app.delete(ENVIRONMENT_BLOCKERS_PATH, async (c) => {
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const validationError = validateTypeScope(body);
    if (validationError) {
      return c.json({ error: validationError }, 400);
    }
    const result = await deps.registry.clear(body.type as string, body.scope as string);
    return c.json(result);
  });
}
