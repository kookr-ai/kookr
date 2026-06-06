import { describe, test, expect } from 'vitest';
import { Hono } from 'hono';
import {
  API_TOKEN_HEADER,
  createApiAuthMiddleware,
  extractBearerToken,
  isAuthorizedUpgrade,
  isLoopbackHost,
  resolveApiAuth,
  tokensMatch,
  type ApiAuthConfig,
} from './auth.js';

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

describe('createApiAuthMiddleware', () => {
  function mkApp(config: ApiAuthConfig): Hono {
    const app = new Hono();
    app.use('*', createApiAuthMiddleware(config));
    app.get('/api/snapshot', (c) => c.json({ ok: true }));
    app.post('/api/tasks', (c) => c.json({ created: true }, 201));
    return app;
  }

  test('loopback config (required:false) is a pass-through for state-changing requests', async () => {
    const app = mkApp({ required: false });
    const res = await app.request('http://lan.example/api/tasks', { method: 'POST' });
    expect(res.status).toBe(201);
  });

  test('non-loopback config rejects a state-changing request with no token (401)', async () => {
    const app = mkApp({ required: true, token: 'secret' });
    const res = await app.request('http://lan.example/api/tasks', { method: 'POST' });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  test('non-loopback config rejects a wrong token (401)', async () => {
    const app = mkApp({ required: true, token: 'secret' });
    const res = await app.request('http://lan.example/api/tasks', {
      method: 'POST',
      headers: { authorization: 'Bearer nope' },
    });
    expect(res.status).toBe(401);
  });

  test('non-loopback config accepts the correct bearer token', async () => {
    const app = mkApp({ required: true, token: 'secret' });
    const res = await app.request('http://lan.example/api/tasks', {
      method: 'POST',
      headers: { authorization: 'Bearer secret' },
    });
    expect(res.status).toBe(201);
  });

  test('non-loopback config accepts the X-Kookr-Api-Token header', async () => {
    const app = mkApp({ required: true, token: 'secret' });
    const res = await app.request('http://lan.example/api/tasks', {
      method: 'POST',
      headers: { [API_TOKEN_HEADER]: 'secret' },
    });
    expect(res.status).toBe(201);
  });

  test('non-loopback config lets safe GET requests through without a token', async () => {
    const app = mkApp({ required: true, token: 'secret' });
    const res = await app.request('http://lan.example/api/snapshot');
    expect(res.status).toBe(200);
  });
});

describe('isAuthorizedUpgrade', () => {
  test('loopback config authorizes any upgrade', () => {
    expect(isAuthorizedUpgrade({ required: false }, { headers: {}, url: '/ws' })).toBe(true);
  });

  test('non-loopback rejects an upgrade with no token', () => {
    expect(isAuthorizedUpgrade({ required: true, token: 'secret' }, { headers: {}, url: '/ws' })).toBe(false);
  });

  test('non-loopback accepts a token via the Authorization header', () => {
    expect(
      isAuthorizedUpgrade(
        { required: true, token: 'secret' },
        { headers: { authorization: 'Bearer secret' }, url: '/ws' },
      ),
    ).toBe(true);
  });

  test('non-loopback accepts a token via the ?token= query param (browser WS)', () => {
    expect(
      isAuthorizedUpgrade({ required: true, token: 'secret' }, { headers: {}, url: '/ws?token=secret' }),
    ).toBe(true);
    expect(
      isAuthorizedUpgrade({ required: true, token: 'secret' }, { headers: {}, url: '/ws?api_token=secret' }),
    ).toBe(true);
  });

  test('non-loopback rejects a wrong query token', () => {
    expect(
      isAuthorizedUpgrade({ required: true, token: 'secret' }, { headers: {}, url: '/ws?token=nope' }),
    ).toBe(false);
  });
});
