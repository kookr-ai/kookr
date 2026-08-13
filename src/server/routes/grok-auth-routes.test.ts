import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { GROK_DEFAULT_AUTH_SCOPE } from '../../adapters/grok-auth-preflight.js';
import { GROK_AUTH_STATUS_PATH, GROK_LOGIN_COMMAND } from '../../shared/contracts/grok-auth-status.js';
import { registerGrokAuthRoutes } from './grok-auth-routes.js';

const NOW_ISO = '2026-06-01T00:00:00.000Z';

function mkApp(homedir: string, roundRobinIndex = 0): Hono {
  const app = new Hono();
  registerGrokAuthRoutes(app, {
    homedir,
    settings: { get: () => ({ roundRobinIndex }) },
  });
  return app;
}

function writeAuth(home: string, body: unknown): void {
  const grokDir = join(home, '.grok');
  mkdirSync(grokDir, { recursive: true });
  writeFileSync(join(grokDir, 'auth.json'), JSON.stringify(body), 'utf8');
}

describe('GET /api/grok-auth-status', () => {
  const homes: string[] = [];

  afterEach(() => {
    for (const home of homes.splice(0)) {
      rmSync(home, { recursive: true, force: true });
    }
  });

  function tempHome(): string {
    const home = mkdtempSync(join(tmpdir(), 'kookr-grok-auth-status-'));
    homes.push(home);
    return home;
  }

  it('reports missing when the shared credential file is absent', async () => {
    const res = await mkApp(tempHome(), 3).request(GROK_AUTH_STATUS_PATH);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.status).toBe('missing');
    expect(body.launchWouldRefuse).toBe(true);
    expect(body.loginCommand).toBe(GROK_LOGIN_COMMAND);
    expect(String(body.message)).toContain(GROK_LOGIN_COMMAND);
    expect(body.roundRobinIndex).toBe(3);
    expect(body).not.toHaveProperty('access_token');
    expect(body).not.toHaveProperty('refresh_token');
    expect(body).not.toHaveProperty('key');
    expect(JSON.stringify(body)).not.toMatch(/sk-|xai-/);
  });

  it('reports expired for a stale cache without echoing tokens', async () => {
    const home = tempHome();
    writeAuth(home, {
      [GROK_DEFAULT_AUTH_SCOPE]: {
        key: 'planted-access-token-should-not-leak',
        auth_mode: 'oidc',
        create_time: '2020-01-01T00:00:00.000Z',
        expires_at: '2020-01-02T00:00:00.000Z',
        user_id: 'user-1',
        refresh_token: 'planted-refresh-token-should-not-leak',
      },
    });

    const res = await mkApp(home).request(GROK_AUTH_STATUS_PATH);
    expect(res.status).toBe(200);
    const raw = await res.text();
    const body = JSON.parse(raw) as Record<string, unknown>;
    expect(body.status).toBe('expired');
    expect(body.launchWouldRefuse).toBe(true);
    expect(String(body.message)).toContain(GROK_LOGIN_COMMAND);
    expect(raw).not.toContain('planted-access-token-should-not-leak');
    expect(raw).not.toContain('planted-refresh-token-should-not-leak');
    expect(body).not.toHaveProperty('authMode');
    expect(body).not.toHaveProperty('email');
  });

  it('reports ok for a usable cache and still omits secrets', async () => {
    const home = tempHome();
    writeAuth(home, {
      [GROK_DEFAULT_AUTH_SCOPE]: {
        key: 'planted-access-token-should-not-leak',
        auth_mode: 'oidc',
        create_time: NOW_ISO,
        expires_at: '2027-01-01T00:00:00.000Z',
        user_id: 'user-1',
        refresh_token: 'planted-refresh-token-should-not-leak',
      },
    });

    const res = await mkApp(home, 1).request(GROK_AUTH_STATUS_PATH);
    expect(res.status).toBe(200);
    const raw = await res.text();
    const body = JSON.parse(raw) as Record<string, unknown>;
    expect(body.status).toBe('ok');
    expect(body.launchWouldRefuse).toBe(false);
    expect(body.message).toBeNull();
    expect(body.roundRobinIndex).toBe(1);
    expect(raw).not.toContain('planted-access-token-should-not-leak');
    expect(raw).not.toContain('planted-refresh-token-should-not-leak');
  });

  it('reports invalid for malformed JSON', async () => {
    const home = tempHome();
    mkdirSync(join(home, '.grok'), { recursive: true });
    writeFileSync(join(home, '.grok', 'auth.json'), '{not-json', 'utf8');

    const res = await mkApp(home).request(GROK_AUTH_STATUS_PATH);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.status).toBe('invalid');
    expect(body.launchWouldRefuse).toBe(true);
    expect(String(body.message)).toContain(GROK_LOGIN_COMMAND);
  });
});
