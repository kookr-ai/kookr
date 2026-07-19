import { describe, expect, it } from 'vitest';
import { isSecretFieldName, redactSecrets } from './redact-secrets.js';

/** Split so secret scanners do not treat the assembled fixture as a live credential. */
const secretFixture = (...parts: string[]): string => parts.join('');

describe('redactSecrets', () => {
  it.each([
    ['OpenAI-style key', 'use sk-abcdefghijklmnop1234 here'],
    ['sk-ant key', 'key sk-ant-abcdefghijklmnop1234 end'],
    ['AWS access key', 'AKIAIOSFODNN7EXAMPLE leak'],
    ['GitHub classic PAT', 'token ghp_0123456789abcdefghij done'],
    ['GitHub fine-grained PAT', secretFixture('note github', '_pat_11AABBCCDDEEFFGGHHIIJJKKLLMMNNOOPP')],
    ['GitHub OAuth token', secretFixture('gho', '_0123456789abcdefghij')],
    ['GitHub server-to-server token', secretFixture('ghs', '_0123456789abcdefghij')],
    ['GitHub refresh token', secretFixture('ghr', '_0123456789abcdefghij')],
    ['GitLab PAT', 'glpat-0123456789abcdefghij'],
    ['Slack bot token', 'xoxb-0123456789-abcdefghij'],
    ['Slack user token', secretFixture('xoxp', '-0123456789-abcdefghij')],
    ['Slack app token', secretFixture('xapp', '-1-A0123456789-abcdefghij')],
    ['Google API key', secretFixture('AIza', 'SyABcdEFGHijKLmnOPqrSTuvWXyz0123456')],
    ['Telegram bot token', secretFixture('123456789', ':AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawX')],
    ['HuggingFace token', 'hf_0123456789abcdefghij'],
    ['npm token', 'npm_0123456789abcdefghij'],
    ['Google OAuth', 'ya29.abcdEFGH_ijklMNOP'],
  ])('redacts a %s', (_label, input) => {
    const out = redactSecrets(input);
    expect(out).toContain('[REDACTED]');
    // The literal secret token must not survive.
    expect(out).not.toMatch(
      /sk-ant-abcdefghijklmnop1234|ghp_0123456789abcdefghij|github_pat_11AABBCCDDEEFFGGHHIIJJKKLLMMNNOOPP|gho_0123456789abcdefghij|ghs_0123456789abcdefghij|ghr_0123456789abcdefghij|AKIAIOSFODNN7EXAMPLE|glpat-0123456789abcdefghij|xoxb-0123456789|xoxp-0123456789|xapp-1-A0123456789|AIzaSyABcdEFGHijKLmnOPqrSTuvWXyz0123456|123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawX|hf_0123456789abcdefghij|npm_0123456789abcdefghij|ya29\.abcdEFGH/,
    );
  });

  it.each([
    ['GitHub path lookalike', 'check github_path_to_file in the tree'],
    ['short gho prefix', 'gho_tooshort'],
    ['short AIza prefix', 'AIzaSyShort'],
    ['short xoxp prefix', 'xoxp-short'],
    ['telegram-like id without token body', 'bot 123456789:shortid'],
  ])('does not over-redact %s', (_label, input) => {
    expect(redactSecrets(input)).toBe(input);
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
