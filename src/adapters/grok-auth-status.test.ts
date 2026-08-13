import { describe, expect, it } from 'vitest';
import { GROK_DEFAULT_AUTH_SCOPE } from './grok-auth-preflight.js';
import { GROK_LOGIN_COMMAND } from '../shared/contracts/grok-auth-status.js';
import { buildGrokAuthStatusResponse } from './grok-auth-status.js';

const NOW = new Date('2026-06-01T00:00:00.000Z');

function credential(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    [GROK_DEFAULT_AUTH_SCOPE]: {
      key: 'not-a-real-access-token-value',
      auth_mode: 'oidc',
      create_time: '2026-05-01T00:00:00.000Z',
      user_id: 'user-1',
      refresh_token: 'not-a-real-refresh-token-value',
      ...overrides,
    },
  });
}

describe('buildGrokAuthStatusResponse', () => {
  it('reports ok without copying token fields', async () => {
    const body = await buildGrokAuthStatusResponse({
      authPath: '/tmp/grok/auth.json',
      now: NOW,
      inspect: async () => ({
        kind: 'ok',
        credentialCount: 1,
        authMode: 'oidc',
        expiresAt: '2026-07-01T00:00:00.000Z',
      }),
    });
    expect(body).toEqual({
      status: 'ok',
      loginCommand: GROK_LOGIN_COMMAND,
      message: null,
      launchWouldRefuse: false,
      roundRobinIndex: 0,
    });
    expect(JSON.stringify(body)).not.toMatch(/not-a-real|refresh_token|access_token|oidc/i);
  });

  it('maps expired preflight to a refuse + login command', async () => {
    const body = await buildGrokAuthStatusResponse({
      authPath: '/tmp/grok/auth.json',
      roundRobinIndex: 2,
      inspect: async () => ({ kind: 'expired', expiresAt: '2026-05-01T00:00:00.000Z' }),
    });
    expect(body.status).toBe('expired');
    expect(body.launchWouldRefuse).toBe(true);
    expect(body.roundRobinIndex).toBe(2);
    expect(body.message).toContain(GROK_LOGIN_COMMAND);
    expect(body.loginCommand).toBe(GROK_LOGIN_COMMAND);
  });

  it('maps missing and invalid the same way the adapter would refuse', async () => {
    const missing = await buildGrokAuthStatusResponse({
      authPath: '/tmp/grok/auth.json',
      inspect: async () => ({ kind: 'missing', reason: 'file_missing' }),
    });
    expect(missing.status).toBe('missing');
    expect(missing.launchWouldRefuse).toBe(true);
    expect(missing.message).toContain(GROK_LOGIN_COMMAND);

    const invalid = await buildGrokAuthStatusResponse({
      authPath: '/tmp/grok/auth.json',
      inspect: async () => ({ kind: 'invalid', reason: 'malformed_json' }),
    });
    expect(invalid.status).toBe('invalid');
    expect(invalid.launchWouldRefuse).toBe(true);
    expect(invalid.message).toContain(GROK_LOGIN_COMMAND);
  });

  it('does not echo credential JSON when inspecting a real-looking cache', async () => {
    const body = await buildGrokAuthStatusResponse({
      authPath: '/tmp/grok/auth.json',
      now: NOW,
      inspect: async () => {
        // Prove the builder never stringifies the raw cache: even if inspect
        // were to read this, the DTO still cannot contain the planted secrets.
        void credential();
        return { kind: 'missing', reason: 'no_usable_credential' };
      },
    });
    expect(JSON.stringify(body)).not.toContain('not-a-real-access-token-value');
    expect(JSON.stringify(body)).not.toContain('not-a-real-refresh-token-value');
  });
});
