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

// Shapes captured from Claude Code 2.1.332 run with `--output-format stream-json --verbose`
// (fields the classifier ignores trimmed; the real `system/init` line is ~16 KB).
const INIT = JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', tools: ['Bash'], model: 'claude-haiku' });
const OK_ASSISTANT = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'OK' }] } });
const rateLimitEvent = (unifiedWindows: Record<string, unknown>, status = 'allowed') => JSON.stringify({
  type: 'rate_limit_event',
  rate_limit_info: { status, resetsAt: 1796126400, rateLimitType: 'seven_day', overageStatus: 'rejected', isUsingOverage: false, unifiedWindows },
});
const OK_RESULT = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'OK', terminal_reason: 'completed', api_error_status: null });
const AUTH_ASSISTANT = JSON.stringify({
  type: 'assistant', error: 'authentication_failed', api_error_status: 401, api_error_type: 'authentication_error', is_api_error_message: true,
  message: { model: '<synthetic>', content: [{ type: 'text', text: 'Failed to authenticate. API Error: 401 OAuth access token is invalid.' }] },
});
const AUTH_RESULT = JSON.stringify({
  type: 'result', subtype: 'success', is_error: true, result: 'Failed to authenticate. API Error: 401 OAuth access token is invalid.',
  terminal_reason: 'api_error', api_error_status: 401, api_error_type: 'authentication_error',
});
const BOTH_WINDOWS = {
  five_hour: { utilization: 0.56, resetsAt: 1795395000, status: 'allowed' },
  seven_day: { utilization: 0.99, resetsAt: 1795770000, status: 'allowed_warning' },
};
const stream = (...lines: string[]) => `${lines.join('\n')}\n`;

describe('classifyClaudeProbe on stream-json', () => {
  test('ok from the result line, with both windows in percent and ISO time', () => {
    const res = classifyClaudeProbe(probe(0, stream(INIT, OK_ASSISTANT, rateLimitEvent(BOTH_WINDOWS), OK_RESULT)));
    expect(res).toEqual({
      outcome: 'ok',
      message: 'OK',
      quota: {
        fiveHour: { utilization: 56, resetsAt: new Date(1795395000 * 1000).toISOString(), status: 'allowed' },
        sevenDay: { utilization: 99, resetsAt: new Date(1795770000 * 1000).toISOString(), status: 'allowed_warning' },
      },
    });
  });

  test('a single window (as the host login reports) gives only that window', () => {
    const res = classifyClaudeProbe(probe(0, stream(INIT, OK_ASSISTANT, rateLimitEvent({ seven_day: { utilization: 0.73, resetsAt: 1796126400, status: 'allowed' } }), OK_RESULT)));
    expect(res.quota).toEqual({ sevenDay: { utilization: 73, resetsAt: new Date(1796126400 * 1000).toISOString(), status: 'allowed' } });
  });

  test('the last rate_limit_event wins', () => {
    const first = rateLimitEvent({ five_hour: { utilization: 0.1, resetsAt: 1795395000, status: 'allowed' } });
    const last = rateLimitEvent({ five_hour: { utilization: 0.2, resetsAt: 1795395000, status: 'allowed' } });
    expect(classifyClaudeProbe(probe(0, stream(INIT, first, OK_ASSISTANT, last, OK_RESULT))).quota?.fiveHour?.utilization).toBe(20);
  });

  test('no rate_limit_event: still classified, no quota field', () => {
    expect(classifyClaudeProbe(probe(0, stream(INIT, OK_ASSISTANT, OK_RESULT)))).toEqual({ outcome: 'ok', message: 'OK' });
  });

  test('malformed windows are dropped instead of rendering bogus bars', () => {
    const res = classifyClaudeProbe(probe(0, stream(
      rateLimitEvent({ five_hour: { utilization: 'high', resetsAt: 1795395000 }, seven_day: { utilization: 0.5 } }),
      OK_RESULT,
    )));
    expect(res).toEqual({ outcome: 'ok', message: 'OK' });
  });

  test('auth_failed from the structured error fields (is_error with subtype success)', () => {
    expect(classifyClaudeProbe(probe(1, stream(INIT, AUTH_ASSISTANT, AUTH_RESULT)))).toEqual({
      outcome: 'auth_failed',
      message: 'Failed to authenticate. API Error: 401 OAuth access token is invalid.',
    });
  });

  test('usage_limited from the assistant rate_limit error, keeping the quota it measured', () => {
    const assistant = JSON.stringify({ type: 'assistant', error: 'rate_limit', message: { content: [{ type: 'text', text: 'x' }] } });
    const result = JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: "You've hit your limit · resets 3pm" });
    const full = { five_hour: { utilization: 1, resetsAt: 1795395000, status: 'rejected' } };
    const res = classifyClaudeProbe(probe(1, stream(INIT, rateLimitEvent(full, 'rejected'), assistant, result)));
    expect(res.outcome).toBe('usage_limited');
    expect(res.message).toBe("You've hit your limit · resets 3pm");
    expect(res.quota?.fiveHour).toMatchObject({ utilization: 100, status: 'rejected' });
  });

  test('usage_limited from a rejected rate_limit_event alone, and from the result text', () => {
    const failed = JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'request failed' });
    expect(classifyClaudeProbe(probe(1, stream(rateLimitEvent({}, 'rejected'), failed))).outcome).toBe('usage_limited');
    const textOnly = JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Claude AI usage limit reached|1760000000' });
    expect(classifyClaudeProbe(probe(1, stream(textOnly))).outcome).toBe('usage_limited');
  });

  test('billing is an error even with a rate-limit word in the text', () => {
    const assistant = JSON.stringify({ type: 'assistant', error: 'billing_error', message: { content: [] } });
    const result = JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Credit balance is too low' });
    expect(classifyClaudeProbe(probe(1, stream(assistant, result))).outcome).toBe('error');
  });

  test('an API error on the assistant line is not ok, even when the result says is_error false', () => {
    const assistant = JSON.stringify({ type: 'assistant', error: 'rate_limit', message: { content: [] } });
    const result = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Claude AI usage limit reached' });
    expect(classifyClaudeProbe(probe(0, stream(INIT, assistant, result))).outcome).toBe('usage_limited');
    const flagged = JSON.stringify({ type: 'assistant', is_api_error_message: true, message: { content: [] } });
    expect(classifyClaudeProbe(probe(0, stream(INIT, flagged, OK_RESULT))).outcome).toBe('error');
  });

  test('a non-success subtype is an error, even with is_error false', () => {
    const result = JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: false });
    expect(classifyClaudeProbe(probe(0, stream(INIT, result)))).toEqual({ outcome: 'error', message: 'error_max_turns' });
  });

  test('JSON stream without a result line takes its message from stderr, not a JSON blob', () => {
    const res = classifyClaudeProbe(probe(null, stream(INIT, OK_ASSISTANT), 'timed out after 120s'));
    expect(res).toEqual({ outcome: 'error', message: 'timed out after 120s' });
    expect(classifyClaudeProbe(probe(1, stream(INIT))).message).toBe('exit status 1');
  });

  test('a stdout whose head was cut mid-line still classifies on its tail', () => {
    const cut = stream(INIT, OK_ASSISTANT, rateLimitEvent(BOTH_WINDOWS), OK_RESULT).slice(20);
    expect(classifyClaudeProbe(probe(0, cut)).outcome).toBe('ok');
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
    expect(args.slice(args.indexOf('--output-format'), args.indexOf('--output-format') + 2)).toEqual(['--output-format', 'stream-json']);
    expect(args).toContain('--verbose');
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN);
    expect(env.CLAUDE_CODE_CHILD_SESSION).toBeUndefined();
  });

  test('runs the probe with hooks disabled so a blocking Stop hook cannot fail it', async () => {
    const run = vi.fn(async () => probe(0, 'OK'));
    await testClaudeAccount(registry, 'host', { env: { PATH: '/bin' }, run });
    const args = (run.mock.calls[0] as unknown as [string, string[]])[1];
    const settings = args[args.indexOf('--settings') + 1];
    expect(args).toContain('--settings');
    expect(JSON.parse(settings)).toEqual({ disableAllHooks: true });
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
