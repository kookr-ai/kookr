import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXIT_FAILED, EXIT_OK, EXIT_USER_ERROR, quotaSuffix, runAccountCli } from './kookr-account.js';

const TOKEN = 'sk-ant-oat01-' + 'z'.repeat(36) + 'WXYZ';

let dir: string;
let env: NodeJS.ProcessEnv;
let logs: string[];
let errors: string[];
const io = (extra: Parameters<typeof runAccountCli>[1] = {}) => ({
  env,
  out: { log: (...a: unknown[]) => logs.push(a.join(' ')) },
  err: { error: (...a: unknown[]) => errors.push(a.join(' ')) },
  ...extra,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kookr-account-cli-'));
  env = { KOOKR_CLAUDE_ACCOUNTS_FILE: join(dir, 'accounts.json'), KOOKR_PORT: '4999' };
  logs = [];
  errors = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('kookr account', () => {
  test('add takes the token from setup-token output, list never prints it', async () => {
    const readSecret = async () => `Your OAuth token:\n${TOKEN}\n`;
    expect(await runAccountCli(['add', 'work', '--default'], io({ readSecret }))).toBe(EXIT_OK);
    expect(readFileSync(env.KOOKR_CLAUDE_ACCOUNTS_FILE!, 'utf-8')).toContain(TOKEN);

    logs = [];
    expect(await runAccountCli(['list', '--json'], io())).toBe(EXIT_OK);
    const envelope = JSON.parse(logs[0]!);
    expect(envelope.details.accounts).toEqual([
      { name: 'host', isDefault: false },
      expect.objectContaining({ name: 'work', isDefault: true, tokenHint: '…WXYZ' }),
    ]);
    expect(logs.join('\n')).not.toContain(TOKEN);
  });

  test('add refuses input without a token, and a token on the command line is not an option', async () => {
    expect(await runAccountCli(['add', 'work'], io({ readSecret: async () => 'hello' }))).toBe(EXIT_USER_ERROR);
    expect(await runAccountCli(['add', 'work', TOKEN], io({ readSecret: async () => TOKEN }))).toBe(EXIT_USER_ERROR);
  });

  test('test reports an account that does not authenticate', async () => {
    await runAccountCli(['add', 'work'], io({ readSecret: async () => TOKEN }));
    const runClaude = vi.fn(() => ({ status: 1, stdout: 'Failed to authenticate. API Error: 401 OAuth access token is invalid.', stderr: '' }));
    expect(await runAccountCli(['test', 'work'], io({ runClaude }))).toBe(EXIT_FAILED);
    const [, , childEnv] = runClaude.mock.calls[0] as unknown as [string, string[], NodeJS.ProcessEnv];
    expect(childEnv.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN);
    expect(errors.join('\n')).toMatch(/401/);
  });

  test('switch posts the account to the task route and explains the outcome', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href.endsWith('/api/health')) return new Response('{}', { status: 200 });
      expect(href).toBe('http://127.0.0.1:4999/api/tasks/t-1/claude-account');
      expect(JSON.parse(String(init?.body))).toEqual({ account: 'work' });
      return new Response(JSON.stringify({ ok: true, outcome: 'relaunched', from: 'host', to: 'work', task: {} }), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await runAccountCli(['switch', 't-1', 'work'], io({ fetchImpl }))).toBe(EXIT_OK);
    expect(logs.join('\n')).toMatch(/moved from "host" to "work" and was relaunched/);
  });

  test('switch maps a refused switch to a user error with the server code', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/api/health')) return new Response('{}', { status: 200 });
      return new Response(JSON.stringify({ error: 'no conversation yet', code: 'not_resumable' }), { status: 409 });
    }) as unknown as typeof fetch;
    expect(await runAccountCli(['switch', 't-1', 'work', '--json'], io({ fetchImpl }))).toBe(EXIT_USER_ERROR);
    expect(JSON.parse(logs[0]!)).toMatchObject({ ok: false, code: 'NOT_RESUMABLE' });
  });

  test('add --label stores the label and list shows it', async () => {
    const readSecret = async () => TOKEN;
    expect(await runAccountCli(['add', 'work', '--label', 'me@work.com'], io({ readSecret }))).toBe(EXIT_OK);
    expect(await runAccountCli(['add', 'alt', '--label=Alt plan'], io({ readSecret }))).toBe(EXIT_OK);
    logs = [];
    expect(await runAccountCli(['list'], io())).toBe(EXIT_OK);
    expect(logs[0]).toContain('me@work.com, token');
    expect(logs[0]).toContain('Alt plan, token');
  });

  test('add --label with a bad or missing value is a user error', async () => {
    const readSecret = async () => TOKEN;
    expect(await runAccountCli(['add', 'work', '--label'], io({ readSecret }))).toBe(EXIT_USER_ERROR);
    expect(await runAccountCli(['add', 'work', '--label', 'x'.repeat(121)], io({ readSecret }))).toBe(EXIT_USER_ERROR);
  });

  test('test reports an out-of-quota account clearly', async () => {
    await runAccountCli(['add', 'work'], io({ readSecret: async () => TOKEN }));
    const runClaude = vi.fn(async () => ({ status: 1, stdout: "You've hit your limit - resets 3pm", stderr: '' }));
    expect(await runAccountCli(['test', 'work'], io({ runClaude }))).toBe(EXIT_FAILED);
    expect(errors.join('\n')).toContain('Claude account "work" is out of quota: You\'ve hit your limit - resets 3pm');
  });
  test('test adds the measured 5h/7d usage to its one line', async () => {
    await runAccountCli(['add', 'work'], io({ readSecret: async () => TOKEN }));
    const windows = {
      five_hour: { utilization: 0.56, resetsAt: 1795395000, status: 'allowed' },
      seven_day: { utilization: 0.99, resetsAt: 1795770000, status: 'allowed_warning' },
    };
    const stdout = [
      JSON.stringify({ type: 'system', subtype: 'init' }),
      JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: windows } }),
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'OK' }),
    ].join('\n');
    const runClaude = vi.fn(async () => ({ status: 0, stdout, stderr: '' }));
    logs = [];
    expect(await runAccountCli(['test', 'work'], io({ runClaude }))).toBe(EXIT_OK);
    const out = logs.join('\n');
    expect(out).toContain('Claude account "work" works. (5h 56%, 7d 99% near limit)');
    expect(out.trim().split('\n')).toHaveLength(1);
  });

  test('quotaSuffix shows only the windows Claude Code reported', () => {
    expect(quotaSuffix(undefined)).toBe('');
    expect(quotaSuffix({})).toBe('');
    expect(quotaSuffix({ sevenDay: { utilization: 73, resetsAt: '2026-12-01T00:00:00.000Z', status: 'allowed' } })).toBe(' (7d 73%)');
    expect(quotaSuffix({ fiveHour: { utilization: 100, resetsAt: '2026-12-01T00:00:00.000Z', status: 'rejected' } })).toBe(' (5h 100% limit reached)');
  });
});
