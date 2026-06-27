import { describe, expect, it } from 'vitest';
import { isSecretFieldName, redactSecrets } from './redact-secrets.js';

describe('redactSecrets', () => {
  it.each([
    ['OpenAI-style key', 'use sk-abcdefghijklmnop1234 here'],
    ['sk-ant key', 'key sk-ant-abcdefghijklmnop1234 end'],
    ['AWS access key', 'AKIAIOSFODNN7EXAMPLE leak'],
    ['GitHub PAT', 'token ghp_0123456789abcdefghij done'],
    ['GitLab PAT', 'glpat-0123456789abcdefghij'],
    ['Slack bot token', 'xoxb-0123456789-abcdefghij'],
    ['HuggingFace token', 'hf_0123456789abcdefghij'],
    ['npm token', 'npm_0123456789abcdefghij'],
    ['Google OAuth', 'ya29.abcdEFGH_ijklMNOP'],
  ])('redacts a %s', (_label, input) => {
    const out = redactSecrets(input);
    expect(out).toContain('[REDACTED]');
    // The literal secret token must not survive.
    expect(out).not.toMatch(/sk-ant-abcdefghijklmnop1234|ghp_0123456789abcdefghij|AKIAIOSFODNN7EXAMPLE|glpat-0123456789abcdefghij|xoxb-0123456789|hf_0123456789abcdefghij|npm_0123456789abcdefghij|ya29\.abcdEFGH/);
  });

  it('redacts a JWT', () => {
    const jwt = 'eyJhbGciOi.eyJzdWIiOi.SflKxwRJSM';
    expect(redactSecrets(`auth ${jwt}`)).toBe('auth [REDACTED]');
  });

  it('redacts a PEM block spanning multiple lines', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIBVwIBADANBg\n-----END PRIVATE KEY-----';
    expect(redactSecrets(`key:\n${pem}`)).toBe('key:\n[REDACTED]');
  });

  it.each([
    'token=abc123',
    'password:super-secret',
    'api_key=abc123',
    'access_token=abc123',
    'client_secret=super-secret',
    'secret:abc123',
  ])('redacts key-value credential text: %s', (input) => {
    expect(redactSecrets(`run with ${input} now`)).toBe('run with [REDACTED] now');
  });

  it.each(['token', 'access_token', 'client_secret', 'api-key', 'password'])('detects secret field names: %s', (field) => {
    expect(isSecretFieldName(field)).toBe(true);
  });

  it.each(['file_path', 'command', 'prompt', 'url'])('does not treat ordinary descriptor fields as secret fields: %s', (field) => {
    expect(isSecretFieldName(field)).toBe(false);
  });

  it('leaves ordinary text untouched', () => {
    const text = 'tests green, PR #812 opened, ready for review';
    expect(redactSecrets(text)).toBe(text);
  });

  it('does NOT catch a bare password (best-effort, documented limitation)', () => {
    const text = 'db password is hunter2';
    expect(redactSecrets(text)).toBe(text);
  });
});
