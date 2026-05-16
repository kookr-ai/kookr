import type { Context, Hono } from 'hono';
import type { RelayConnectionStatusResponse } from '../../shared/contracts/relay-connection.js';
import type { RouteDeps } from './shared.js';
import { evaluateShareMutationGuard, SHARE_CSRF_HEADER } from './share-routes.js';

function guardRelayMutation(c: Context, deps: RouteDeps) {
  const remoteShare = deps.remoteShare;
  if (!remoteShare) return { ok: false as const, status: 500 as const, error: 'share-csrf-not-configured' };
  return evaluateShareMutationGuard({
    requestUrl: c.req.url,
    origin: c.req.header('Origin'),
    csrfHeader: c.req.header(SHARE_CSRF_HEADER),
    expectedCsrfToken: remoteShare.csrfToken,
  });
}

export function registerRelayConnectionRoutes(app: Hono, deps: RouteDeps): void {
  app.get('/api/relay-connection', (c) => {
    if (!deps.relayConnection) return c.json({ error: 'relay-connection-not-configured' }, 500);
    const response: RelayConnectionStatusResponse = { status: deps.relayConnection.status() };
    return c.json(response);
  });

  app.post('/api/relay-connection/connect', async (c) => {
    if (!deps.relayConnection) return c.json({ error: 'relay-connection-not-configured' }, 500);
    const guard = guardRelayMutation(c, deps);
    if (!guard.ok) return c.json({ error: guard.error }, guard.status);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid-json-body' }, 400);
    }
    try {
      const status = await deps.relayConnection.connect(body as never);
      const response: RelayConnectionStatusResponse = { status };
      return c.json(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'relay connect failed';
      return c.json({ error: message }, 400);
    }
  });

  app.post('/api/relay-connection/disconnect', async (c) => {
    if (!deps.relayConnection) return c.json({ error: 'relay-connection-not-configured' }, 500);
    const guard = guardRelayMutation(c, deps);
    if (!guard.ok) return c.json({ error: guard.error }, guard.status);
    const response: RelayConnectionStatusResponse = { status: await deps.relayConnection.disconnect() };
    return c.json(response);
  });

  app.delete('/api/relay-connection/credentials', async (c) => {
    if (!deps.relayConnection) return c.json({ error: 'relay-connection-not-configured' }, 500);
    const guard = guardRelayMutation(c, deps);
    if (!guard.ok) return c.json({ error: guard.error }, guard.status);
    const response: RelayConnectionStatusResponse = { status: await deps.relayConnection.forget() };
    return c.json(response);
  });
}
