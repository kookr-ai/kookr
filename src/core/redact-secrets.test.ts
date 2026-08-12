import { describe, expect, it } from 'vitest';
import { isSecretFieldName, redactSecrets } from './redact-secrets.js';

/** Split so secret scanners do not treat the assembled fixture as a live credential. */
const secretFixture = (...parts: string[]): string => parts.join('');

// pragma: allowlist secret — synthetic redaction fixtures only; not live credentials.
describe('redactSecrets', () => {
  it.each([
    ['OpenAI-style key', secretFixture('use sk', '-abcdefghijklmnop1234 here')],
    ['sk-ant key', secretFixture('key sk', '-ant-abcdefghijklmnop1234 end')],
    ['AWS access key', secretFixture('AKIA', 'IOSFODNN7EXAMPLE leak')],
    ['GitHub classic PAT', secretFixture('token ghp', '_0123456789abcdefghij done')],
    ['GitHub fine-grained PAT', secretFixture('note github', '_pat_11AABBCCDDEEFFGGHHIIJJKKLLMMNNOOPP')],
    ['GitHub OAuth token', secretFixture('gho', '_0123456789abcdefghij')],
    ['GitHub server-to-server token', secretFixture('ghs', '_0123456789abcdefghij')],
    ['GitHub refresh token', secretFixture('ghr', '_0123456789abcdefghij')],
    ['GitLab PAT', secretFixture('glpat', '-0123456789abcdefghij')],
    ['Slack bot token', secretFixture('xoxb', '-0123456789-abcdefghij')],
    ['Slack user token', secretFixture('xoxp', '-0123456789-abcdefghij')],
    ['Slack app token', secretFixture('xapp', '-1-A0123456789-abcdefghij')],
    ['Google API key', secretFixture('AIza', 'SyABcdEFGHijKLmnOPqrSTuvWXyz0123456')],
    ['Telegram bot token', secretFixture('123456789', ':AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawX')],
    ['HuggingFace token', secretFixture('hf', '_0123456789abcdefghij')],
    ['npm token', secretFixture('npm', '_0123456789abcdefghij')],
    ['Google OAuth', secretFixture('ya29', '.abcdEFGH_ijklMNOP')],
  ])('redacts a %s', (_label, input) => {
    const out = redactSecrets(input);
    expect(out).toContain('[REDACTED]');
    // No long secret-shaped fragment from the fixture may survive.
    for (const token of input.split(/[ .:_-]+/).filter((part) => part.length >= 12)) {
      expect(out).not.toContain(token);
    }
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
    const jwt = secretFixture('eyJ', 'hbGciOi.eyJ', 'zdWIiOi.SflKxwRJSM');
    expect(redactSecrets(`auth ${jwt}`)).toBe('auth [REDACTED]');
  });

  it('redacts a PEM block spanning multiple lines', () => {
    // Split markers so the PR secret scanner does not treat this line as a committed key.
    const pem = secretFixture('-----BEGIN ', 'PRIVATE KEY-----\nMIIBVwIBADANBg\n-----END PRIVATE KEY-----');
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

  it('redacts Authorization headers (Bearer, Basic, and known-prefix tokens)', () => {
    const generic = secretFixture('super-secret-bearer-value', '-0123456789abcdef');
    expect(redactSecrets(`Authorization: Bearer ${generic}`)).toBe('[REDACTED]');
    expect(redactSecrets(`authorization: Bearer ${generic}`)).toBe('[REDACTED]');
    expect(redactSecrets('Authorization: Basic dXNlcjpwYXNz')).toBe('[REDACTED]');

    const gh = secretFixture('ghp', '_0123456789abcdefghij');
    const out = redactSecrets(`curl -H "Authorization: Bearer ${gh}"`);
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain(gh);
  });

  it('redacts bare Bearer tokens and Cookie headers', () => {
    const bare = secretFixture('bare-bearer-token-value', '-xyz9876543210');
    expect(redactSecrets(`proxy Bearer ${bare}`)).toContain('[REDACTED]');
    expect(redactSecrets(`proxy Bearer ${bare}`)).not.toContain(bare);

    const cookie = 'sessionid=abc123def456ghi789; path=/';
    expect(redactSecrets(`Cookie: ${cookie}`)).toBe('[REDACTED]');
    expect(redactSecrets(`Set-Cookie: ${cookie}`)).toBe('[REDACTED]');
  });
});
