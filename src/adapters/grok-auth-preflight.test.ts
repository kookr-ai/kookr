import { describe, expect, test } from 'vitest';
import {
  formatGrokAuthPreflightFailure,
  GROK_DEFAULT_AUTH_SCOPE,
  inspectGrokAuthFile,
  type GrokAuthPreflightFs,
} from './grok-auth-preflight.js';

const AUTH_SCOPE = GROK_DEFAULT_AUTH_SCOPE;
const LEGACY_SCOPE = 'https://accounts.x.ai/sign-in';
const FIXED_NOW = new Date('2026-07-17T22:00:00.000Z');

function authRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: 'access-token-that-must-not-be-reported',
    auth_mode: 'oidc',
    create_time: '2026-07-01T00:00:00Z',
    user_id: 'test-user',
    expires_at: '2026-07-18T00:00:00Z',
    refresh_token: 'refresh-token-that-must-not-be-reported',
    ...overrides,
  };
}

function fsReturning(contents: string): GrokAuthPreflightFs {
  return { readFile: async () => contents };
}

describe('inspectGrokAuthFile', () => {
  test('accepts a future-valid OIDC credential without returning secret material', async () => {
    const result = await inspectGrokAuthFile('/tmp/grok/auth.json', {
      fs: fsReturning(JSON.stringify({ [AUTH_SCOPE]: authRecord() })),
      now: FIXED_NOW,
    });

    expect(result).toMatchObject({ kind: 'ok', authMode: 'oidc', credentialCount: 1 });
    expect(JSON.stringify(result)).not.toContain('access-token-that-must-not-be-reported');
    expect(JSON.stringify(result)).not.toContain('refresh-token-that-must-not-be-reported');
  });

  test('reports a missing file with a supported re-authentication action', async () => {
    const missing = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const fs: GrokAuthPreflightFs = { readFile: async () => { throw missing; } };
    const result = await inspectGrokAuthFile('/tmp/grok/auth.json', { fs, now: FIXED_NOW });
    const message = formatGrokAuthPreflightFailure('/tmp/grok/auth.json', result);

    expect(result).toEqual({ kind: 'missing', reason: 'file_missing' });
    expect(message).toContain('grok login --device-code');
    expect(message).not.toContain('ENOENT');
  });

  test('reports malformed JSON without echoing the credential-bearing input', async () => {
    const secret = 'malformed-secret-must-not-be-echoed';
    const result = await inspectGrokAuthFile('/tmp/grok/auth.json', {
      fs: fsReturning(`{"token":"${secret}`),
      now: FIXED_NOW,
    });
    const message = formatGrokAuthPreflightFailure('/tmp/grok/auth.json', result);

    expect(result).toEqual({ kind: 'invalid', reason: 'malformed_json' });
    expect(message).toContain('could not be parsed');
    expect(message).not.toContain(secret);
  });

  test('reports an expired credential before a session is created', async () => {
    const result = await inspectGrokAuthFile('/tmp/grok/auth.json', {
      fs: fsReturning(JSON.stringify({ [AUTH_SCOPE]: authRecord({ expires_at: '2026-07-17T21:59:59Z' }) })),
      now: FIXED_NOW,
    });
    const message = formatGrokAuthPreflightFailure('/tmp/grok/auth.json', result);

    expect(result).toMatchObject({ kind: 'expired', expiresAt: '2026-07-17T21:59:59Z' });
    expect(message).toContain('Grok authentication expired');
    expect(message).toContain('grok login --device-code');
  });

  test('treats a credential inside Grok’s five-minute early-invalidation window as expired', async () => {
    const result = await inspectGrokAuthFile('/tmp/grok/auth.json', {
      fs: fsReturning(JSON.stringify({ [AUTH_SCOPE]: authRecord({ expires_at: '2026-07-17T22:04:00Z' }) })),
      now: FIXED_NOW,
    });

    expect(result).toMatchObject({ kind: 'expired', expiresAt: '2026-07-17T22:04:00Z' });
  });

  test('uses Grok’s thirty-day TTL when expires_at is absent', async () => {
    const result = await inspectGrokAuthFile('/tmp/grok/auth.json', {
      fs: fsReturning(JSON.stringify({ [AUTH_SCOPE]: authRecord({ expires_at: undefined }) })),
      now: FIXED_NOW,
    });

    expect(result).toMatchObject({ kind: 'ok', expiresAt: '2026-07-31T00:00:00.000Z' });
  });

  test('ignores legacy web-login entries because Grok does not use them for lookup', async () => {
    const result = await inspectGrokAuthFile('/tmp/grok/auth.json', {
      fs: fsReturning(JSON.stringify({ [AUTH_SCOPE]: authRecord({ auth_mode: 'web_login' }) })),
      now: FIXED_NOW,
    });

    expect(result).toEqual({ kind: 'missing', reason: 'no_usable_credential' });
  });

  test('accepts when one cached credential is expired but another remains valid', async () => {
    const result = await inspectGrokAuthFile('/tmp/grok/auth.json', {
      fs: fsReturning(JSON.stringify({
        [AUTH_SCOPE]: authRecord({ expires_at: '2026-07-18T00:00:00Z' }),
        [LEGACY_SCOPE]: authRecord({ expires_at: '2026-07-01T00:00:00Z' }),
      })),
      now: FIXED_NOW,
    });

    expect(result).toMatchObject({ kind: 'ok', credentialCount: 1, authMode: 'oidc' });
  });

  test('falls back to the legacy scope when the configured scope is absent', async () => {
    const result = await inspectGrokAuthFile('/tmp/grok/auth.json', {
      fs: fsReturning(JSON.stringify({ [LEGACY_SCOPE]: authRecord() })),
      now: FIXED_NOW,
    });

    expect(result).toMatchObject({ kind: 'ok', authMode: 'oidc' });
  });

  test('does not accept a valid credential stored under an unrelated scope', async () => {
    const result = await inspectGrokAuthFile('/tmp/grok/auth.json', {
      fs: fsReturning(JSON.stringify({ 'https://auth.x.ai::other-client': authRecord() })),
      now: FIXED_NOW,
    });

    expect(result).toEqual({ kind: 'missing', reason: 'no_usable_credential' });
  });

  test('rejects a credential record with an invalid expiry instead of guessing', async () => {
    const result = await inspectGrokAuthFile('/tmp/grok/auth.json', {
      fs: fsReturning(JSON.stringify({ [AUTH_SCOPE]: authRecord({ expires_at: 'not-a-date' }) })),
      now: FIXED_NOW,
    });

    expect(result).toEqual({ kind: 'invalid', reason: 'invalid_record' });
  });

  test('requires Grok-compatible RFC 3339 timestamps instead of Date.parse guesses', async () => {
    for (const expiresAt of [
      '2026-07-18',
      '2026-07-18 00:00:00Z',
      '2026-02-30T00:00:00Z',
      '2026-07-18T00:00:00.1234567890Z',
    ]) {
      const result = await inspectGrokAuthFile('/tmp/grok/auth.json', {
        fs: fsReturning(JSON.stringify({ [AUTH_SCOPE]: authRecord({ expires_at: expiresAt }) })),
        now: FIXED_NOW,
      });

      expect(result, expiresAt).toEqual({ kind: 'invalid', reason: 'invalid_record' });
    }
  });

  test('rejects malformed optional fields that Grok would fail to deserialize', async () => {
    const result = await inspectGrokAuthFile('/tmp/grok/auth.json', {
      fs: fsReturning(JSON.stringify({ [AUTH_SCOPE]: authRecord({ team_blocked_reasons: 'not-an-array' }) })),
      now: FIXED_NOW,
    });

    expect(result).toEqual({ kind: 'invalid', reason: 'invalid_record' });
  });
});
