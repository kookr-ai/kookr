import { describe, it, expect } from 'vitest';
import { createRoutes } from './routes.js';
import type { RouteDeps } from './routes/shared.js';
import type { ApiAuthConfig } from './auth.js';

// Issue #708: verify the API-token middleware is wired into `createRoutes` and
// gated on `apiAuth.required`. We exercise a non-existent `/api/*` path so the
// assertions never depend on a real route handler's deps: an unauthenticated
// mutating request is short-circuited to 401 by the middleware, while an
// authorized (or safe, or loopback) request falls through to the 404 notFound
// handler — proving the gate let it past.
function makeDeps(apiAuth?: ApiAuthConfig): RouteDeps {
  return { frontendDir: '/nonexistent-frontend', serverCwd: '/repo', serverPort: 4800, apiAuth } as unknown as RouteDeps;
}

describe('createRoutes API-token middleware install (issue #708)', () => {
  it('rejects an unauthenticated mutating request when apiAuth.required is true', async () => {
    const app = createRoutes(makeDeps({ required: true, token: 'secret' }));
    const res = await app.request('http://lan.example/api/does-not-exist', { method: 'POST' });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  it('lets an authorized mutating request through to the route layer (404, not 401)', async () => {
    const app = createRoutes(makeDeps({ required: true, token: 'secret' }));
    const res = await app.request('http://lan.example/api/does-not-exist', {
      method: 'POST',
      headers: { authorization: 'Bearer secret' },
    });
    expect(res.status).toBe(404);
  });

  it('lets safe GET requests through without a token', async () => {
    const app = createRoutes(makeDeps({ required: true, token: 'secret' }));
    const res = await app.request('http://lan.example/api/does-not-exist');
    expect(res.status).toBe(404);
  });

  it('does NOT install the gate on a loopback bind (apiAuth absent)', async () => {
    const app = createRoutes(makeDeps(undefined));
    const res = await app.request('http://localhost/api/does-not-exist', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('does NOT install the gate when apiAuth.required is false', async () => {
    const app = createRoutes(makeDeps({ required: false }));
    const res = await app.request('http://localhost/api/does-not-exist', { method: 'POST' });
    expect(res.status).toBe(404);
  });
});
