import { describe, expect, test, vi } from 'vitest';
import { emptyClaudeAccountRegistry, withAccount, ClaudeAccountError } from '../core/claude-accounts.js';
import { classifyClaudeProbe, testClaudeAccount, type ClaudeProbeResult } from './claude-account-test.js';

const TOKEN = 'sk-ant-oat01-' + 'k'.repeat(40);
const registry = withAccount(emptyClaudeAccountRegistry(), 'work', TOKEN);
const probe = (status: number | null, stdout: string, stderr = ''): ClaudeProbeResult => ({ status, stdout, stderr });

describe('classifyClaudeProbe', () => {
  test('ok when the CLI exits 0 with an answer', () => {
    expect(classifyClaudeProbe(probe(0, 'OK'))).toEqual({ outcome: 'ok', message: 'OK' });
  });

  test.each([
    'Claude AI usage limit reached|1760000000',
    "5-hour limit reached ∙ resets 3pm",
    "You've hit your weekly limit · resets Mon 9am",
    'Your limit will reset at 4:00 PM',
    'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit."}}',
  ])('usage_limited: %s', (line) => {
    expect(classifyClaudeProbe(probe(1, line)).outcome).toBe('usage_limited');
  });

  test.each([
    'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired"}}',
    'API Error: 403 Forbidden',
    'Invalid API key · Please run /login',
    'invalid token',
  ])('auth_failed: %s', (line) => {
    expect(classifyClaudeProbe(probe(1, line)).outcome).toBe('auth_failed');
  });

  test('billing and credit wording is an error, not usage_limited', () => {
    expect(classifyClaudeProbe(probe(1, 'Credit balance is too low to access the API')).outcome).toBe('error');
    expect(classifyClaudeProbe(probe(1, 'billing_error: rate limit on payment method')).outcome).toBe('error');
  });

  test('anything else is an error', () => {
    expect(classifyClaudeProbe(probe(null, '', 'spawn claude ENOENT')).outcome).toBe('error');
    expect(classifyClaudeProbe(probe(1, 'something odd')).outcome).toBe('error');
  });

  test('message is the first non-empty line, redacted and capped at 300 characters', () => {
    const res = classifyClaudeProbe(probe(1, `\n\n  Failed to authenticate with ${TOKEN} ${'x'.repeat(400)}\nsecond line`));
    expect(res.message).not.toContain(TOKEN);
    expect(res.message).not.toContain('second line');
    expect(res.message.length).toBeLessThanOrEqual(300);
  });
});

describe('testClaudeAccount', () => {
  test('runs claude -p with the account token and without inherited account env', async () => {
    const run = vi.fn(async () => probe(0, 'OK'));
    const res = await testClaudeAccount(registry, 'work', {
      env: { KOOKR_AGENT_BIN: '/bin/fake-claude', CLAUDE_CODE_CHILD_SESSION: '1', PATH: '/bin' },
      run,
    });
    expect(res.outcome).toBe('ok');
    const [bin, args, env] = run.mock.calls[0] as unknown as [string, string[], NodeJS.ProcessEnv];
    expect(bin).toBe('/bin/fake-claude');
    expect(args).toContain('-p');
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN);
    expect(env.CLAUDE_CODE_CHILD_SESSION).toBeUndefined();
  });

  test('host gets no token', async () => {
    const run = vi.fn(async () => probe(0, 'OK'));
    await testClaudeAccount(registry, 'host', { env: { PATH: '/bin' }, run });
    expect((run.mock.calls[0] as unknown as [string, string[], NodeJS.ProcessEnv])[2].CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  test('an unknown account throws unknown_account', () => {
    expect(() => testClaudeAccount(registry, 'nope', { run: async () => probe(0, 'OK') })).toThrow(ClaudeAccountError);
  });

  test('a throwing runner becomes an error outcome', async () => {
    const res = await testClaudeAccount(registry, 'work', { run: async () => { throw new Error('boom'); } });
    expect(res).toEqual({ outcome: 'error', message: 'boom' });
  });

  test('concurrent tests of one account share a single probe', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const run = vi.fn(async () => { await gate; return probe(0, 'OK'); });
    const a = testClaudeAccount(registry, 'work', { run });
    const b = testClaudeAccount(registry, 'work', { run });
    release();
    expect(await a).toEqual(await b);
    expect(run).toHaveBeenCalledTimes(1);
    await testClaudeAccount(registry, 'work', { run });
    expect(run).toHaveBeenCalledTimes(2);
  });
});
