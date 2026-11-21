import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXIT_FAILED, EXIT_OK, EXIT_USER_ERROR, runAccountCli } from './kookr-account.js';

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
});
