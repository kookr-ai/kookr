import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { GROK_DEFAULT_AUTH_SCOPE, type GrokAuthPreflightResult } from '../../adapters/grok-auth-preflight.js';
import {
  filterLaunchableAgentTypes,
  GrokAuthAvailabilityCache,
} from '../../adapters/grok-auth-availability.js';
import { GROK_LOGIN_COMMAND } from '../../shared/contracts/grok-auth-status.js';

const GROK_AUTH_STATUS_PATH = '/api/grok-auth-status';
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

describe('GET /api/grok-auth-status parity with launch-time verdict (#2537)', () => {
  const OK: GrokAuthPreflightResult = {
    kind: 'ok',
    credentialCount: 1,
    authMode: 'oidc',
    expiresAt: '2027-01-01T00:00:00.000Z',
  };
  const EXPIRED: GrokAuthPreflightResult = { kind: 'expired', expiresAt: '2020-01-01T00:00:00.000Z' };

  /** Build an endpoint that shares one cache with the (simulated) launch path. */
  function harness() {
    let nowMs = 1_000_000;
    let diskResult: GrokAuthPreflightResult = OK;
    const cache = new GrokAuthAvailabilityCache({
      resolveAuthPath: () => '/tmp/ignored/auth.json',
      inspect: async () => diskResult,
      now: () => nowMs,
    });
    const app = new Hono();
    registerGrokAuthRoutes(app, { grokAuthAvailability: cache, settings: { get: () => ({ roundRobinIndex: 0 }) } });

    async function endpointVerdict(): Promise<boolean> {
      const res = await app.request(GROK_AUTH_STATUS_PATH);
      const body = await res.json() as { launchWouldRefuse: boolean };
      return body.launchWouldRefuse;
    }
    // What the launch path would compute right now: refresh the shared cache
    // (as launch-service does before selection) then read `isUsable()`.
    async function launchWouldStripGrok(): Promise<boolean> {
      await cache.ensureFresh();
      const launchable = filterLaunchableAgentTypes(['claude-code', 'grok-build'], {
        grokAuthUsable: cache.isUsable(),
      });
      return !launchable.includes('grok-build');
    }

    return {
      cache,
      endpointVerdict,
      launchWouldStripGrok,
      advance: (ms: number) => { nowMs += ms; },
      setDisk: (r: GrokAuthPreflightResult) => { diskResult = r; },
    };
  }

  it('endpoint launchWouldRefuse tracks the shared cache verdict, not fresh disk, within the TTL', async () => {
    const h = harness();

    // T0: credentials usable — endpoint and launch agree, grok is launchable.
    expect(await h.endpointVerdict()).toBe(false);
    expect(await h.launchWouldStripGrok()).toBe(false);
    expect(h.cache.isUsable()).toBe(true);

    // Credentials expire on disk, but we are still inside the cache TTL (~30s).
    // The OLD endpoint re-read disk and would flip to refuse; the launch path,
    // reusing the cached "usable" verdict, would still resolve grok. The fix
    // makes the endpoint report the SAME cached verdict as launch.
    h.setDisk(EXPIRED);
    h.advance(10_000); // < GROK_AUTH_AVAILABILITY_TTL_MS (30_000)
    const endpointInTtl = await h.endpointVerdict();
    expect(endpointInTtl).toBe(false); // matches the still-cached usable verdict
    expect(await h.launchWouldStripGrok()).toBe(false);
    expect(endpointInTtl).toBe(await h.launchWouldStripGrok());

    // Past the TTL: the shared cache refreshes and both converge on refuse.
    h.advance(30_001);
    const endpointPastTtl = await h.endpointVerdict();
    expect(endpointPastTtl).toBe(true);
    expect(await h.launchWouldStripGrok()).toBe(true);
    expect(endpointPastTtl).toBe(await h.launchWouldStripGrok());
    expect(h.cache.isUsable()).toBe(false);
  });

  it('agrees on the inverse transition (re-login) within the same TTL window', async () => {
    const h = harness();
    h.setDisk(EXPIRED);
    // Prime the cache with the expired verdict.
    expect(await h.endpointVerdict()).toBe(true);
    expect(await h.launchWouldStripGrok()).toBe(true);

    // Operator re-logs in on disk, still inside the TTL: endpoint keeps reporting
    // the cached "refuse" verdict, exactly as the launch path would.
    h.setDisk(OK);
    h.advance(5_000);
    expect(await h.endpointVerdict()).toBe(true);
    expect(await h.launchWouldStripGrok()).toBe(true);

    // After the TTL both pick up the re-login together.
    h.advance(30_001);
    expect(await h.endpointVerdict()).toBe(false);
    expect(await h.launchWouldStripGrok()).toBe(false);
  });
});
