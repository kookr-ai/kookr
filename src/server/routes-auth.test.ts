import { describe, it, expect } from 'vitest';
import { createRoutes } from './routes.js';
import type { RouteDeps } from './routes/shared.js';
import type { ApiAuthConfig } from './auth.js';

// Issue #708 + #802 (R7): verify the actor-aware API middleware is wired into
// `createRoutes` and gated on `apiAuth.required`. We exercise a non-existent
// `/api/*` path so the assertions never depend on a real route handler's deps:
// an unauthenticated request is short-circuited to 401 by the middleware, while
// an authorized (or loopback) request falls through to the 404 notFound handler
// — proving the gate let it past. Note (#802): the safe-method GET bypass is
// removed — an unauthenticated GET on a data route is now 401, not a pass.
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

  it('R7: rejects an unauthenticated GET data request (401, with body) — safe-method bypass removed', async () => {
    const app = createRoutes(makeDeps({ required: true, token: 'secret' }));
    const res = await app.request('http://lan.example/api/does-not-exist');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  it('lets an authorized GET data request through to the route layer (404, not 401)', async () => {
    const app = createRoutes(makeDeps({ required: true, token: 'secret' }));
    const res = await app.request('http://lan.example/api/does-not-exist', {
      headers: { authorization: 'Bearer secret' },
    });
    expect(res.status).toBe(404);
  });

  it('GET /api/ready stays reachable without a credential (unauthenticated probe allow-list)', async () => {
    const app = createRoutes(makeDeps({ required: true, token: 'secret' }));
    const res = await app.request('http://lan.example/api/ready');
    // The real liveness probe handler runs (200 or 503 depending on its checks);
    // the assertion is that the auth gate did NOT short-circuit it to 401.
    expect(res.status).not.toBe(401);
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
