import { describe, test, expect, vi, afterEach } from 'vitest';
import { Hono } from 'hono';
import {
  API_TOKEN_HEADER,
  SESSION_COOKIE_NAME,
  createApiAuthMiddleware,
  extractBearerToken,
  isAuthorizedUpgrade,
  isLoopbackHost,
  isUnauthenticatedRoute,
  parseCookieHeader,
  resolveActor,
  resolveApiAuth,
  resolveUpgradeIdentity,
  tokensMatch,
  type ApiAuthConfig,
  type ViewerTokenResolution,
} from './auth.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('isLoopbackHost', () => {
  test('treats loopback addresses and localhost as loopback', () => {
    for (const host of ['127.0.0.1', '127.0.0.5', '::1', '[::1]', 'localhost', 'LOCALHOST', '::ffff:127.0.0.1']) {
      expect(isLoopbackHost(host)).toBe(true);
    }
  });

  test('treats LAN / wildcard / hostnames as non-loopback', () => {
    for (const host of ['0.0.0.0', '::', '10.0.0.5', '192.168.1.20', 'kookr.local', '']) {
      expect(isLoopbackHost(host)).toBe(false);
    }
    expect(isLoopbackHost(undefined)).toBe(false);
    expect(isLoopbackHost(null)).toBe(false);
  });
});

describe('resolveApiAuth', () => {
  test('loopback bind requires no auth', () => {
    const res = resolveApiAuth({ host: '127.0.0.1', env: {} });
    expect(res.kind).toBe('loopback');
    expect(res.kind === 'loopback' && res.config.required).toBe(false);
  });

  test('non-loopback bind with KOOKR_API_TOKEN enforces the provided token', () => {
    const res = resolveApiAuth({ host: '0.0.0.0', env: { KOOKR_API_TOKEN: '  secret-token  ' } });
    expect(res.kind).toBe('token-provided');
    if (res.kind !== 'token-provided') throw new Error('unreachable');
    expect(res.config).toEqual({ required: true, token: 'secret-token' });
  });

  test('non-loopback bind with the opt-out auto-generates and enforces a token', () => {
    const res = resolveApiAuth({
      host: '10.0.0.5',
      env: { KOOKR_ALLOW_NON_LOOPBACK: 'true' },
      generateToken: () => 'generated-xyz',
    });
    expect(res.kind).toBe('token-generated');
    if (res.kind !== 'token-generated') throw new Error('unreachable');
    expect(res.token).toBe('generated-xyz');
    expect(res.config).toEqual({ required: true, token: 'generated-xyz' });
  });

  // The fail-closed start-up behavior: a non-loopback bind with neither a token
  // nor the explicit opt-out must refuse to start (the caller exits 1).
  test('non-loopback bind without token or opt-out is fail-closed', () => {
    const res = resolveApiAuth({ host: '0.0.0.0', env: {} });
    expect(res.kind).toBe('fail-closed');
    expect(res.kind === 'fail-closed' && res.reason).toMatch(/non-loopback/i);
  });

  test('an empty KOOKR_API_TOKEN does not count as provided', () => {
    expect(resolveApiAuth({ host: '0.0.0.0', env: { KOOKR_API_TOKEN: '   ' } }).kind).toBe('fail-closed');
  });
});

describe('extractBearerToken / tokensMatch', () => {
  test('parses the bearer scheme case-insensitively', () => {
    expect(extractBearerToken('Bearer abc123')).toBe('abc123');
    expect(extractBearerToken('bearer  abc123  ')).toBe('abc123');
    expect(extractBearerToken('Basic abc123')).toBeUndefined();
    expect(extractBearerToken(undefined)).toBeUndefined();
  });

  test('constant-time compare matches exact tokens only', () => {
    expect(tokensMatch('s3cret', 's3cret')).toBe(true);
    expect(tokensMatch('s3cret', 's3cre')).toBe(false);
    expect(tokensMatch('s3cret', 'wrongg')).toBe(false);
    expect(tokensMatch('s3cret', undefined)).toBe(false);
  });
});

describe('parseCookieHeader', () => {
  test('parses name=value pairs and decodes values', () => {
    expect(parseCookieHeader('a=1; b=two%20words; c=3')).toEqual({ a: '1', b: 'two words', c: '3' });
  });

  test('first occurrence of a name wins; malformed parts are skipped', () => {
    expect(parseCookieHeader('x=1; x=2; novalue; =orphan')).toEqual({ x: '1' });
  });

  test('empty / missing header is an empty object', () => {
    expect(parseCookieHeader(undefined)).toEqual({});
    expect(parseCookieHeader('')).toEqual({});
  });
});

describe('isUnauthenticatedRoute', () => {
  test('non-/api paths (static SPA assets + client routes) need no credential', () => {
    expect(isUnauthenticatedRoute('GET', '/')).toBe(true);
    expect(isUnauthenticatedRoute('GET', '/assets/app.js')).toBe(true);
    expect(isUnauthenticatedRoute('GET', '/some/spa/route')).toBe(true);
  });

  test('only POST /api/auth/session and GET /api/ready are allow-listed under /api', () => {
    expect(isUnauthenticatedRoute('POST', '/api/auth/session')).toBe(true);
    expect(isUnauthenticatedRoute('GET', '/api/ready')).toBe(true);
    // method matters — a GET on the session route or a POST to ready is not allow-listed
    expect(isUnauthenticatedRoute('GET', '/api/auth/session')).toBe(false);
    expect(isUnauthenticatedRoute('POST', '/api/ready')).toBe(false);
  });

  test('every other /api route requires a credential', () => {
    for (const path of ['/api/snapshot', '/api/health', '/api/tasks', '/api/files/raw', '/api']) {
      expect(isUnauthenticatedRoute('GET', path)).toBe(false);
    }
  });
});

describe('resolveActor', () => {
  const owner = (overrides: Partial<ApiAuthConfig> = {}): ApiAuthConfig => ({
    required: true,
    token: 'owner-secret',
    ...overrides,
  });

  test('loopback / auth-not-required ⇒ owner with no credential (R9)', () => {
    expect(resolveActor({ required: false }, { method: 'GET' } as never)).toEqual({ kind: 'owner' });
    expect(resolveActor(owner(), { host: '127.0.0.1' })).toEqual({ kind: 'owner' });
  });

  test('owner token via bearer ⇒ owner', () => {
    expect(resolveActor(owner(), { authorization: 'Bearer owner-secret' })).toEqual({ kind: 'owner' });
  });

  test('owner token via session cookie ⇒ owner', () => {
    expect(resolveActor(owner(), { cookies: { [SESSION_COOKIE_NAME]: 'owner-secret' } })).toEqual({
      kind: 'owner',
    });
  });

  test('owner token via the X-Kookr-Api-Token header (CLI parity) ⇒ owner', () => {
    expect(resolveActor(owner(), { apiTokenHeader: 'owner-secret' })).toEqual({ kind: 'owner' });
  });

  test('credential precedence: bearer wins over api-token header wins over cookie', () => {
    // A correct bearer with a garbage header/cookie still resolves to owner.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(
      resolveActor(owner(), {
        authorization: 'Bearer owner-secret',
        apiTokenHeader: 'nope',
        cookies: { [SESSION_COOKIE_NAME]: 'nope' },
      }),
    ).toEqual({ kind: 'owner' });
    // With no bearer, the api-token header is consulted before the cookie.
    expect(
      resolveActor(owner(), { apiTokenHeader: 'owner-secret', cookies: { [SESSION_COOKIE_NAME]: 'nope' } }),
    ).toEqual({ kind: 'owner' });
  });

  test('valid viewer grant ⇒ viewer + scope', () => {
    const resolveViewer = (token: string): ViewerTokenResolution =>
      token === 'viewer-tok'
        ? { kind: 'valid', grantId: 'g1', scope: { kind: 'all' } }
        : { kind: 'not-found' };
    expect(resolveActor(owner({ resolveViewer }), { authorization: 'Bearer viewer-tok' })).toEqual({
      kind: 'viewer',
      grantId: 'g1',
      scope: { kind: 'all' },
    });
  });

  test('revoked / expired / bad / missing credential ⇒ null (fail-closed)', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const resolveViewer = (token: string): ViewerTokenResolution => {
      if (token === 'revoked-tok') return { kind: 'revoked', grantId: 'g2' };
      if (token === 'expired-tok') return { kind: 'expired', grantId: 'g3' };
      return { kind: 'not-found' };
    };
    const cfg = owner({ resolveViewer });
    expect(resolveActor(cfg, { authorization: 'Bearer revoked-tok' })).toBeNull();
    expect(resolveActor(cfg, { authorization: 'Bearer expired-tok' })).toBeNull();
    expect(resolveActor(cfg, { authorization: 'Bearer garbage' })).toBeNull();
    expect(resolveActor(cfg, {})).toBeNull();
  });

  test('a non-owner credential with no viewer resolver ⇒ null (bad_token)', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveActor(owner(), { authorization: 'Bearer whatever' })).toBeNull();
  });

  test('emits a structured auth_rejected log with the reason and grantId (revoked)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const resolveViewer = (): ViewerTokenResolution => ({ kind: 'revoked', grantId: 'g9' });
    resolveActor(owner({ resolveViewer }), { authorization: 'Bearer x', remoteAddr: '10.0.0.9' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(warn.mock.calls[0][0] as string)).toEqual({
      event: 'auth_rejected',
      reason: 'revoked',
      remoteAddr: '10.0.0.9',
      grantId: 'g9',
    });
  });

  test('log shape: no_credential omits grantId and serializes remoteAddr as null when absent', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    resolveActor(owner(), {});
    expect(JSON.parse(warn.mock.calls[0][0] as string)).toEqual({
      event: 'auth_rejected',
      reason: 'no_credential',
      remoteAddr: null,
    });
  });

  test('log shape: a non-matching cookie present ⇒ reason cookie_missing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    resolveActor(owner(), { cookies: { some_other: 'x' }, remoteAddr: '10.0.0.2' });
    expect(JSON.parse(warn.mock.calls[0][0] as string)).toEqual({
      event: 'auth_rejected',
      reason: 'cookie_missing',
      remoteAddr: '10.0.0.2',
    });
  });

  test('log shape: an unknown credential ⇒ reason bad_token, no grantId', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    resolveActor(owner(), { authorization: 'Bearer nope' });
    expect(JSON.parse(warn.mock.calls[0][0] as string)).toEqual({
      event: 'auth_rejected',
      reason: 'bad_token',
      remoteAddr: null,
    });
  });
});

describe('createApiAuthMiddleware (actor-aware, R7)', () => {
  const VIEWER_TOKEN = 'viewer-tok';
  function mkApp(config: ApiAuthConfig): Hono {
    const app = new Hono();
    app.use('*', createApiAuthMiddleware(config));
    app.get('/api/snapshot', (c) => c.json({ ok: true }));
    app.get('/api/health', (c) => c.json({ ok: true }));
    app.get('/api/ready', (c) => c.json({ ready: true }));
    app.post('/api/auth/session', (c) => c.json({ established: true }));
    app.post('/api/tasks', (c) => c.json({ created: true }, 201));
    app.get('/index.html', (c) => c.text('spa'));
    return app;
  }
  function cfg(extra: Partial<ApiAuthConfig> = {}): ApiAuthConfig {
    return {
      required: true,
      token: 'secret',
      resolveViewer: (t) =>
        t === VIEWER_TOKEN ? { kind: 'valid', grantId: 'g1', scope: { kind: 'all' } } : { kind: 'not-found' },
      ...extra,
    };
  }

  test('loopback config (required:false) is a pass-through', async () => {
    const app = mkApp({ required: false });
    const res = await app.request('http://lan.example/api/tasks', { method: 'POST' });
    expect(res.status).toBe(201);
  });

  test('R7: a GET data route with no credential is rejected (401) — safe-method bypass removed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = mkApp(cfg());
    const res = await app.request('http://lan.example/api/snapshot');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  test('owner bearer token passes on both GET and POST', async () => {
    const app = mkApp(cfg());
    const get = await app.request('http://lan.example/api/snapshot', {
      headers: { authorization: 'Bearer secret' },
    });
    expect(get.status).toBe(200);
    const post = await app.request('http://lan.example/api/tasks', {
      method: 'POST',
      headers: { authorization: 'Bearer secret' },
    });
    expect(post.status).toBe(201);
  });

  test('owner via X-Kookr-Api-Token header still works', async () => {
    const app = mkApp(cfg());
    const res = await app.request('http://lan.example/api/tasks', {
      method: 'POST',
      headers: { [API_TOKEN_HEADER]: 'secret' },
    });
    expect(res.status).toBe(201);
  });

  test('owner via session cookie passes', async () => {
    const app = mkApp(cfg());
    const res = await app.request('http://lan.example/api/snapshot', {
      headers: { cookie: `${SESSION_COOKIE_NAME}=secret` },
    });
    expect(res.status).toBe(200);
  });

  test('viewer is denied (403) on every data route, including /api/health', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = mkApp(cfg());
    for (const path of ['/api/snapshot', '/api/health']) {
      const res = await app.request(`http://lan.example${path}`, {
        headers: { authorization: `Bearer ${VIEWER_TOKEN}` },
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'forbidden' });
    }
  });

  test('viewer 403 logs auth_rejected with reason viewer_route_denied + grantId', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = mkApp(cfg());
    await app.request('http://lan.example/api/health', {
      headers: { authorization: `Bearer ${VIEWER_TOKEN}` },
    });
    const record = JSON.parse(warn.mock.calls.at(-1)?.[0] as string);
    expect(record).toMatchObject({ event: 'auth_rejected', reason: 'viewer_route_denied', grantId: 'g1' });
  });

  test('a viewer credential is NOT 403d on POST /api/auth/session (its only HTTP endpoint)', async () => {
    const app = mkApp(cfg());
    // Send the actual viewer credential — it must reach the handler (200), not
    // be denied by the viewer data deny-list. (It passes via the unauthenticated
    // allow-list, which short-circuits before actor resolution; the assertion is
    // that a viewer is not blocked here, in contrast to the 403 on data routes.)
    const res = await app.request('http://lan.example/api/auth/session', {
      method: 'POST',
      headers: { authorization: `Bearer ${VIEWER_TOKEN}` },
    });
    expect(res.status).toBe(200);
  });

  test('GET /api/ready and static assets pass with no credential', async () => {
    const app = mkApp(cfg());
    expect((await app.request('http://lan.example/api/ready')).status).toBe(200);
    expect((await app.request('http://lan.example/index.html')).status).toBe(200);
  });
});

describe('resolveUpgradeIdentity / isAuthorizedUpgrade', () => {
  const cfg: ApiAuthConfig = {
    required: true,
    token: 'secret',
    resolveViewer: (t) =>
      t === 'viewer-tok' ? { kind: 'valid', grantId: 'g1', scope: { kind: 'all' } } : { kind: 'not-found' },
  };

  test('loopback config authorizes any upgrade as owner', () => {
    expect(resolveUpgradeIdentity({ required: false }, { headers: {} })).toEqual({ kind: 'owner' });
    expect(isAuthorizedUpgrade({ required: false }, { headers: {}, url: '/ws' })).toBe(true);
  });

  test('owner token via Authorization header ⇒ owner', () => {
    expect(resolveUpgradeIdentity(cfg, { headers: { authorization: 'Bearer secret' } })).toEqual({
      kind: 'owner',
    });
  });

  test('browser authenticates via the session cookie (no header)', () => {
    expect(
      resolveUpgradeIdentity(cfg, { headers: { cookie: `${SESSION_COOKIE_NAME}=secret` } }),
    ).toEqual({ kind: 'owner' });
    expect(
      resolveUpgradeIdentity(cfg, { headers: { cookie: `${SESSION_COOKIE_NAME}=viewer-tok` } }),
    ).toEqual({ kind: 'viewer', grantId: 'g1', scope: { kind: 'all' } });
  });

  test('no token ⇒ null / unauthorized', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveUpgradeIdentity(cfg, { headers: {} })).toBeNull();
    expect(isAuthorizedUpgrade(cfg, { headers: {}, url: '/ws' })).toBe(false);
  });

  test('the legacy ?token= query branch is removed — a URL token is ignored (F4)', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(isAuthorizedUpgrade(cfg, { headers: {}, url: '/ws?token=secret' })).toBe(false);
    expect(isAuthorizedUpgrade(cfg, { headers: {}, url: '/ws?api_token=secret' })).toBe(false);
  });

  test('shim parity: isAuthorizedUpgrade is true iff resolveUpgradeIdentity is non-null (header path)', () => {
    const cases: Array<{ headers: Record<string, string> }> = [
      { headers: { authorization: 'Bearer secret' } },
      { headers: { authorization: 'Bearer nope' } },
      { headers: { cookie: `${SESSION_COOKIE_NAME}=viewer-tok` } },
      { headers: {} },
    ];
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const req of cases) {
      expect(isAuthorizedUpgrade(cfg, req)).toBe(resolveUpgradeIdentity(cfg, req) !== null);
    }
  });
});
