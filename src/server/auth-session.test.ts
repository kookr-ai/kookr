import { describe, test, expect, vi, afterEach } from 'vitest';
import { Hono } from 'hono';
import {
  CSRF_HEADER,
  computeCsrfToken,
  createCsrfMiddleware,
  describeSessionTransport,
  generateCsrfSecret,
  isSameOriginRequest,
  registerAuthSessionRoutes,
  resolveSessionTransport,
  serializeSessionCookie,
  verifyCsrfToken,
  type SessionAuthConfig,
} from './auth-session.js';
import {
  SESSION_COOKIE_NAME,
  parseCookieHeader,
  type ApiAuthConfig,
  type ViewerTokenResolution,
} from './auth.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveSessionTransport', () => {
  test('loopback bind ⇒ loopback mode (feature inert)', () => {
    expect(resolveSessionTransport({ host: '127.0.0.1', env: {} }).mode).toBe('loopback');
    expect(resolveSessionTransport({ host: 'localhost', env: {} }).mode).toBe('loopback');
  });

  test('non-loopback + KOOKR_TRUSTED_TUNNEL=true ⇒ trusted-tunnel', () => {
    expect(
      resolveSessionTransport({ host: '10.0.0.5', env: { KOOKR_TRUSTED_TUNNEL: 'true' } }).mode,
    ).toBe('trusted-tunnel');
    // case/space tolerant
    expect(
      resolveSessionTransport({ host: '10.0.0.5', env: { KOOKR_TRUSTED_TUNNEL: '  TRUE ' } }).mode,
    ).toBe('trusted-tunnel');
  });

  test('non-loopback without HTTPS/tunnel assertion ⇒ https-required (fail-closed)', () => {
    expect(resolveSessionTransport({ host: '192.168.1.20', env: {} }).mode).toBe('https-required');
    expect(
      resolveSessionTransport({ host: '192.168.1.20', env: { KOOKR_TRUSTED_TUNNEL: 'false' } }).mode,
    ).toBe('https-required');
  });

  test('describeSessionTransport: https-required carries the fail-closed notice', () => {
    const msg = describeSessionTransport({ mode: 'https-required' }, '10.0.0.5');
    expect(msg).toMatch(/REFUSED/);
    expect(msg).toMatch(/KOOKR_TRUSTED_TUNNEL/);
  });

  test('describeSessionTransport: loopback + trusted-tunnel messages', () => {
    expect(describeSessionTransport({ mode: 'loopback' }, '127.0.0.1')).toMatch(/Loopback/);
    const tunnel = describeSessionTransport({ mode: 'trusted-tunnel' }, '10.0.0.5');
    expect(tunnel).toMatch(/KOOKR_TRUSTED_TUNNEL=true/);
    expect(tunnel).toMatch(/non-Secure/);
  });
});

describe('CSRF nonce', () => {
  test('computeCsrfToken is per-session (token-bound) and stable', () => {
    const secret = generateCsrfSecret();
    const a = computeCsrfToken(secret, 'token-A');
    const b = computeCsrfToken(secret, 'token-B');
    expect(a).not.toBe(b);
    expect(computeCsrfToken(secret, 'token-A')).toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  test('verifyCsrfToken accepts the matching nonce, rejects others', () => {
    const secret = generateCsrfSecret();
    const token = 'session-token';
    const nonce = computeCsrfToken(secret, token);
    expect(verifyCsrfToken(secret, token, nonce)).toBe(true);
    expect(verifyCsrfToken(secret, token, 'deadbeef')).toBe(false);
    expect(verifyCsrfToken(secret, token, undefined)).toBe(false);
    expect(verifyCsrfToken(secret, token, '')).toBe(false);
    expect(verifyCsrfToken(secret, token, 'not-hex-zz')).toBe(false);
    // wrong secret ⇒ reject
    expect(verifyCsrfToken(generateCsrfSecret(), token, nonce)).toBe(false);
    // wrong session token ⇒ reject
    expect(verifyCsrfToken(secret, 'other', nonce)).toBe(false);
  });
});

describe('isSameOriginRequest', () => {
  test('Sec-Fetch-Site: same-origin ⇒ accepted; others rejected', () => {
    expect(isSameOriginRequest({ secFetchSite: 'same-origin' })).toBe(true);
    expect(isSameOriginRequest({ secFetchSite: 'same-site' })).toBe(false);
    expect(isSameOriginRequest({ secFetchSite: 'cross-site' })).toBe(false);
    expect(isSameOriginRequest({ secFetchSite: 'none' })).toBe(false);
  });

  test('falls back to Origin vs Host when Sec-Fetch-Site absent', () => {
    expect(isSameOriginRequest({ origin: 'http://lan.example:4800', host: 'lan.example:4800' })).toBe(true);
    expect(isSameOriginRequest({ origin: 'http://evil.example', host: 'lan.example:4800' })).toBe(false);
  });

  test('fail-closed: no provenance signal ⇒ rejected', () => {
    expect(isSameOriginRequest({})).toBe(false);
    expect(isSameOriginRequest({ host: 'lan.example' })).toBe(false);
  });
});

describe('serializeSessionCookie', () => {
  test('always HttpOnly; SameSite=Strict; Path=/, Secure iff requested', () => {
    const insecure = serializeSessionCookie({ value: 'abc', secure: false });
    expect(insecure).toContain(`${SESSION_COOKIE_NAME}=abc`);
    expect(insecure).toContain('HttpOnly');
    expect(insecure).toContain('SameSite=Strict');
    expect(insecure).toContain('Path=/');
    expect(insecure).not.toContain('Secure');

    const secure = serializeSessionCookie({ value: 'abc', secure: true });
    expect(secure).toContain('Secure');
  });

  test('URL-encodes the value (round-trips through parseCookieHeader)', () => {
    const raw = 'tok+en/with=special;chars';
    const cookie = serializeSessionCookie({ value: raw, secure: false });
    // The serialized value must be percent-encoded (no raw `;`/`=` that would
    // corrupt cookie parsing).
    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=${encodeURIComponent(raw)}`);
    expect(cookie).not.toContain('with=special;chars');
    // And it decodes back to the original token.
    const cookieValue = cookie.split(';', 1)[0].slice(SESSION_COOKIE_NAME.length + 1);
    expect(parseCookieHeader(`${SESSION_COOKIE_NAME}=${cookieValue}`)[SESSION_COOKIE_NAME]).toBe(raw);
  });
});

// --- POST /api/auth/session route ---

function makeApp(opts: {
  apiAuth?: ApiAuthConfig;
  sessionAuth?: SessionAuthConfig;
  auditLog?: { append: (input: unknown) => Promise<boolean> };
}): Hono {
  const app = new Hono();
  registerAuthSessionRoutes(app, {
    apiAuth: opts.apiAuth,
    sessionAuth: opts.sessionAuth,
    auditLog: opts.auditLog as never,
  });
  return app;
}

const OWNER_TOKEN = 'owner-secret-token';

function ownerSessionAuth(transport: SessionAuthConfig['transport']): SessionAuthConfig {
  return { csrfSecret: generateCsrfSecret(), transport };
}

describe('POST /api/auth/session', () => {
  test('owner token over HTTPS ⇒ Set-Cookie (HttpOnly/SameSite/Path=/, Secure) + CSRF nonce', async () => {
    const sessionAuth = ownerSessionAuth({ mode: 'https-required' });
    const app = makeApp({ apiAuth: { required: true, token: OWNER_TOKEN }, sessionAuth });
    const res = await app.request('https://lan.example/api/auth/session', {
      method: 'POST',
      headers: { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: JSON.stringify({ token: OWNER_TOKEN }),
    });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=${OWNER_TOKEN}`);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toContain('Secure');
    const body = (await res.json()) as { ok: boolean; actor: string; csrfToken: string };
    expect(body.ok).toBe(true);
    expect(body.actor).toBe('owner');
    expect(verifyCsrfToken(sessionAuth.csrfSecret, OWNER_TOKEN, body.csrfToken)).toBe(true);
  });

  test('owner token on a trusted tunnel (plain HTTP) ⇒ non-Secure cookie', async () => {
    const app = makeApp({
      apiAuth: { required: true, token: OWNER_TOKEN },
      sessionAuth: ownerSessionAuth({ mode: 'trusted-tunnel' }),
    });
    const res = await app.request('http://lan.example/api/auth/session', {
      method: 'POST',
      headers: { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: JSON.stringify({ token: OWNER_TOKEN }),
    });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=${OWNER_TOKEN}`);
    expect(setCookie).not.toContain('Secure');
  });

  test('cross-origin POST ⇒ 403 (login-CSRF / session-fixation defense)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = makeApp({
      apiAuth: { required: true, token: OWNER_TOKEN },
      sessionAuth: ownerSessionAuth({ mode: 'trusted-tunnel' }),
    });
    const res = await app.request('http://lan.example/api/auth/session', {
      method: 'POST',
      headers: { 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' },
      body: JSON.stringify({ token: OWNER_TOKEN }),
    });
    expect(res.status).toBe(403);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  test('plain HTTP + https-required posture ⇒ 400 insecure-transport (fail-closed)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = makeApp({
      apiAuth: { required: true, token: OWNER_TOKEN },
      sessionAuth: ownerSessionAuth({ mode: 'https-required' }),
    });
    const res = await app.request('http://lan.example/api/auth/session', {
      method: 'POST',
      headers: { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: JSON.stringify({ token: OWNER_TOKEN }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('insecure-transport');
  });

  test('https-required posture still accepts an HTTPS request (X-Forwarded-Proto)', async () => {
    const app = makeApp({
      apiAuth: { required: true, token: OWNER_TOKEN },
      sessionAuth: ownerSessionAuth({ mode: 'https-required' }),
    });
    const res = await app.request('http://lan.example/api/auth/session', {
      method: 'POST',
      headers: {
        'sec-fetch-site': 'same-origin',
        'x-forwarded-proto': 'https',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ token: OWNER_TOKEN }),
    });
    expect(res.status).toBe(200);
    // Behind a TLS terminator the original request is HTTPS ⇒ Secure cookie.
    expect(res.headers.get('set-cookie') ?? '').toContain('Secure');
  });

  test('invalid token ⇒ 401, no cookie', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = makeApp({
      apiAuth: { required: true, token: OWNER_TOKEN },
      sessionAuth: ownerSessionAuth({ mode: 'trusted-tunnel' }),
    });
    const res = await app.request('http://lan.example/api/auth/session', {
      method: 'POST',
      headers: { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'wrong' }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  test('valid viewer token (resolveViewer wired) ⇒ cookie carries viewer token + viewer-bound nonce', async () => {
    const resolveViewer = (token: string): ViewerTokenResolution =>
      token === 'viewer-token'
        ? { kind: 'valid', grantId: 'g1', scope: { kind: 'all' } }
        : { kind: 'not-found' };
    const sessionAuth = ownerSessionAuth({ mode: 'trusted-tunnel' });
    const app = makeApp({
      apiAuth: { required: true, token: OWNER_TOKEN, resolveViewer },
      sessionAuth,
    });
    const res = await app.request('http://lan.example/api/auth/session', {
      method: 'POST',
      headers: { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'viewer-token' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { actor: string; csrfToken: string };
    expect(body.actor).toBe('viewer');
    // The cookie must carry the viewer's token (not the owner token), and the
    // nonce must be bound to the viewer token.
    expect(res.headers.get('set-cookie') ?? '').toContain(`${SESSION_COOKIE_NAME}=viewer-token`);
    expect(verifyCsrfToken(sessionAuth.csrfSecret, 'viewer-token', body.csrfToken)).toBe(true);
    expect(verifyCsrfToken(sessionAuth.csrfSecret, OWNER_TOKEN, body.csrfToken)).toBe(false);
  });

  test('viewer cookie exchange writes a viewer-grant.session-established audit event (#808)', async () => {
    const resolveViewer = (token: string): ViewerTokenResolution =>
      token === 'viewer-token'
        ? { kind: 'valid', grantId: 'g42', scope: { kind: 'all' } }
        : { kind: 'not-found' };
    const append = vi.fn(async () => true);
    const app = makeApp({
      apiAuth: { required: true, token: OWNER_TOKEN, resolveViewer },
      sessionAuth: ownerSessionAuth({ mode: 'trusted-tunnel' }),
      auditLog: { append },
    });
    const res = await app.request('http://lan.example/api/auth/session', {
      method: 'POST',
      headers: { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'viewer-token' }),
    });
    expect(res.status).toBe(200);
    // The append is fire-and-forget; drain the task queue so this asserts the
    // call happened rather than racing a deferred implementation.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(append).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledWith({
      actor: { kind: 'viewer', grantId: 'g42' },
      event: 'viewer-grant.session-established',
      grantId: 'g42',
    });
  });

  test('an owner cookie exchange writes no audit event (only viewers are audited)', async () => {
    const append = vi.fn(async () => true);
    const app = makeApp({
      apiAuth: { required: true, token: OWNER_TOKEN },
      sessionAuth: ownerSessionAuth({ mode: 'trusted-tunnel' }),
      auditLog: { append },
    });
    const res = await app.request('http://lan.example/api/auth/session', {
      method: 'POST',
      headers: { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: JSON.stringify({ token: OWNER_TOKEN }),
    });
    expect(res.status).toBe(200);
    expect(append).not.toHaveBeenCalled();
  });

  test('unconfigured session feature ⇒ 503 session-feature-disabled', async () => {
    const app = makeApp({ apiAuth: { required: true, token: OWNER_TOKEN } });
    const res = await app.request('http://lan.example/api/auth/session', {
      method: 'POST',
      headers: { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: JSON.stringify({ token: OWNER_TOKEN }),
    });
    expect(res.status).toBe(503);
  });

  test('missing token key ⇒ 400 missing-token', async () => {
    const app = makeApp({
      apiAuth: { required: true, token: OWNER_TOKEN },
      sessionAuth: ownerSessionAuth({ mode: 'trusted-tunnel' }),
    });
    const res = await app.request('http://lan.example/api/auth/session', {
      method: 'POST',
      headers: { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('missing-token');
  });

  test('malformed JSON body ⇒ 400 invalid-body', async () => {
    const app = makeApp({
      apiAuth: { required: true, token: OWNER_TOKEN },
      sessionAuth: ownerSessionAuth({ mode: 'trusted-tunnel' }),
    });
    const res = await app.request('http://lan.example/api/auth/session', {
      method: 'POST',
      headers: { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: 'not-json',
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid-body');
  });
});

// --- CSRF middleware ---

function makeCsrfApp(sessionAuth: SessionAuthConfig): Hono {
  const app = new Hono();
  const apiAuth: ApiAuthConfig = { required: true, token: OWNER_TOKEN };
  app.use('*', createCsrfMiddleware({ apiAuth, csrfSecret: sessionAuth.csrfSecret }));
  app.post('/api/tasks', (c) => c.json({ ok: true }));
  app.get('/api/snapshot', (c) => c.json({ ok: true }));
  return app;
}

function cookieHeader(token: string): string {
  return `${SESSION_COOKIE_NAME}=${token}`;
}

describe('createCsrfMiddleware', () => {
  test('cookie-authed owner mutation WITHOUT X-Kookr-CSRF ⇒ 403', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sessionAuth = ownerSessionAuth({ mode: 'trusted-tunnel' });
    const app = makeCsrfApp(sessionAuth);
    const res = await app.request('http://lan.example/api/tasks', {
      method: 'POST',
      headers: { cookie: cookieHeader(OWNER_TOKEN) },
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('csrf-failed');
  });

  test('cookie-authed owner mutation WITH a valid nonce ⇒ passes', async () => {
    const sessionAuth = ownerSessionAuth({ mode: 'trusted-tunnel' });
    const app = makeCsrfApp(sessionAuth);
    const nonce = computeCsrfToken(sessionAuth.csrfSecret, OWNER_TOKEN);
    const res = await app.request('http://lan.example/api/tasks', {
      method: 'POST',
      headers: { cookie: cookieHeader(OWNER_TOKEN), [CSRF_HEADER]: nonce },
    });
    expect(res.status).toBe(200);
  });

  test('header-authenticated (CLI) mutation is exempt from CSRF', async () => {
    const sessionAuth = ownerSessionAuth({ mode: 'trusted-tunnel' });
    const app = makeCsrfApp(sessionAuth);
    const res = await app.request('http://lan.example/api/tasks', {
      method: 'POST',
      headers: { authorization: `Bearer ${OWNER_TOKEN}` },
    });
    expect(res.status).toBe(200);
  });

  test('safe methods (GET) are never CSRF-gated', async () => {
    const sessionAuth = ownerSessionAuth({ mode: 'trusted-tunnel' });
    const app = makeCsrfApp(sessionAuth);
    const res = await app.request('http://lan.example/api/snapshot', {
      headers: { cookie: cookieHeader(OWNER_TOKEN) },
    });
    expect(res.status).toBe(200);
  });

  test('loopback (auth not required) ⇒ CSRF middleware is a pass-through', async () => {
    const app = new Hono();
    app.use('*', createCsrfMiddleware({ apiAuth: { required: false }, csrfSecret: generateCsrfSecret() }));
    app.post('/api/tasks', (c) => c.json({ ok: true }));
    const res = await app.request('http://localhost/api/tasks', { method: 'POST' });
    expect(res.status).toBe(200);
  });

  test('isExempt routes skip the session-CSRF check (relay share self-guards)', async () => {
    const sessionAuth = ownerSessionAuth({ mode: 'trusted-tunnel' });
    const app = new Hono();
    app.use(
      '*',
      createCsrfMiddleware({
        apiAuth: { required: true, token: OWNER_TOKEN },
        csrfSecret: sessionAuth.csrfSecret,
        isExempt: (path) => path.startsWith('/api/share/'),
      }),
    );
    app.post('/api/share/task', (c) => c.json({ ok: true }));
    // Cookie-authed mutation with NO session nonce on an exempt route ⇒ passes
    // (the route enforces its own CSRF downstream).
    const res = await app.request('http://lan.example/api/share/task', {
      method: 'POST',
      headers: { cookie: cookieHeader(OWNER_TOKEN) },
    });
    expect(res.status).toBe(200);
  });
});
