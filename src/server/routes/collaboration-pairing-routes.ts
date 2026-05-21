import type { Hono } from 'hono';

import { CollaborationPairingError, ContactIdentityStore } from '../contact-identity-store.js';
import { evaluateShareMutationGuard, SHARE_CSRF_HEADER } from './share-routes.js';
import type { RouteDeps } from './shared.js';

export function registerCollaborationPairingRoutes(app: Hono, deps: RouteDeps): void {
  app.get('/api/collaboration/diagnostics', async (c) => {
    if (!deps.collaborationDiagnostics) return c.json({ error: 'collaboration-diagnostics-not-configured' }, 404);
    return c.json(await deps.collaborationDiagnostics.get());
  });

  app.post('/api/collaboration/pairing/verify', async (c) => {
    const csrfToken = deps.remoteShare?.csrfToken;
    if (!csrfToken) return c.json({ error: 'share-csrf-not-configured' }, 500);
    const guard = evaluateShareMutationGuard({
      requestUrl: c.req.url,
      origin: c.req.header('Origin'),
      csrfHeader: c.req.header(SHARE_CSRF_HEADER),
      expectedCsrfToken: csrfToken,
    });
    if (!guard.ok) return c.json({ error: guard.error }, guard.status);

    try {
      const store = new ContactIdentityStore({ kookrDir: deps.kookrDir });
      await store.load();
      return c.json(await store.verifyAcceptedPairing(await c.req.json()), 201);
    } catch (err) {
      if (err instanceof CollaborationPairingError) return c.json({ error: err.code }, err.status as never);
      return c.json({ error: 'invalid-pairing-verification' }, 400);
    }
  });
}
