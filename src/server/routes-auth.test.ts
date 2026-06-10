import { describe, it, expect, vi } from 'vitest';
import { createRoutes } from './routes.js';
import type { RouteDeps } from './routes/shared.js';
import type { ApiAuthConfig } from './auth.js';
import { SESSION_COOKIE_NAME } from './auth.js';
import {
  CSRF_HEADER,
  computeCsrfToken,
  generateCsrfSecret,
  type SessionAuthConfig,
} from './auth-session.js';

// Issue #708 + #802 (R7): verify the actor-aware API middleware is wired into
// `createRoutes` and gated on `apiAuth.required`. We exercise a non-existent
// `/api/*` path so the assertions never depend on a real route handler's deps:
// an unauthenticated request is short-circuited to 401 by the middleware, while
// an authorized (or loopback) request falls through to the 404 notFound handler
// — proving the gate let it past. Note (#802): the safe-method GET bypass is
// removed — an unauthenticated GET on a data route is now 401, not a pass.
function makeDeps(apiAuth?: ApiAuthConfig, sessionAuth?: SessionAuthConfig): RouteDeps {
  return {
    frontendDir: '/nonexistent-frontend',
    serverCwd: '/repo',
    serverPort: 4800,
    apiAuth,
    sessionAuth,
  } as unknown as RouteDeps;
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

  it('keeps headerless loopback mutations token-free when apiAuth.required is false', async () => {
    const app = createRoutes(makeDeps({ required: false }));
    const res = await app.request('http://localhost/api/does-not-exist', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('rejects a browser-origin-crossing loopback mutation when apiAuth.required is false', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = createRoutes(makeDeps({ required: false }));
    const res = await app.request('http://127.0.0.1:4800/api/does-not-exist', {
      method: 'POST',
      headers: { origin: 'http://evil.example' },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'cross-origin' });
  });

  it('allows a same-origin loopback mutation when apiAuth.required is false', async () => {
    const app = createRoutes(makeDeps({ required: false }));
    const res = await app.request('http://127.0.0.1:4800/api/does-not-exist', {
      method: 'POST',
      headers: { host: '127.0.0.1:4800', origin: 'http://127.0.0.1:4800' },
    });
    expect(res.status).toBe(404);
  });
});

// Issue #804: verify the cookie-exchange route + CSRF guard are wired into
// `createRoutes` and reachable past the actor gate.
describe('createRoutes session-auth wiring (issue #804)', () => {
  const OWNER = 'secret';
  function sessionAuth(): SessionAuthConfig {
    return { csrfSecret: generateCsrfSecret(), transport: { mode: 'trusted-tunnel' } };
  }

  it('POST /api/auth/session is reachable past the actor gate and sets the cookie', async () => {
    const app = createRoutes(makeDeps({ required: true, token: OWNER }, sessionAuth()));
    const res = await app.request('http://lan.example/api/auth/session', {
      method: 'POST',
      headers: { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: JSON.stringify({ token: OWNER }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie') ?? '').toContain(`${SESSION_COOKIE_NAME}=${OWNER}`);
  });

  it('session route 503s when the session feature is unconfigured (no sessionAuth)', async () => {
    const app = createRoutes(makeDeps({ required: true, token: OWNER }));
    const res = await app.request('http://lan.example/api/auth/session', {
      method: 'POST',
      headers: { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: JSON.stringify({ token: OWNER }),
    });
    expect(res.status).toBe(503);
  });

  it('installs the CSRF guard: cookie-authed mutation without a nonce ⇒ 403', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sa = sessionAuth();
    const app = createRoutes(makeDeps({ required: true, token: OWNER }, sa));
    const res = await app.request('http://lan.example/api/does-not-exist', {
      method: 'POST',
      headers: { cookie: `${SESSION_COOKIE_NAME}=${OWNER}` },
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('csrf-failed');
  });

  it('CSRF guard passes a cookie-authed mutation carrying a valid nonce (404, past the guard)', async () => {
    const sa = sessionAuth();
    const app = createRoutes(makeDeps({ required: true, token: OWNER }, sa));
    const res = await app.request('http://lan.example/api/does-not-exist', {
      method: 'POST',
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${OWNER}`,
        [CSRF_HEADER]: computeCsrfToken(sa.csrfSecret, OWNER),
      },
    });
    expect(res.status).toBe(404);
  });
});
