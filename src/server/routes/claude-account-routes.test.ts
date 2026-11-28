import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadClaudeAccounts, saveClaudeAccounts } from '../../core/claude-accounts.js';
import { registerClaudeAccountRoutes } from './claude-account-routes.js';
import type { ClaudeProbeResult } from '../../adapters/claude-account-test.js';

const TOKEN = 'sk-ant-oat01-' + 'q'.repeat(36) + 'WXYZ';
const TOKEN_2 = 'sk-ant-oat01-' + 'r'.repeat(36) + 'ABCD';

let dir: string;
let file: string;
let auditLogPath: string;
let runProbe: ReturnType<typeof vi.fn<(...a: unknown[]) => Promise<ClaudeProbeResult>>>;
let actorKind: 'owner' | 'viewer' | undefined;
let app: Hono;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'claude-account-routes-'));
  file = join(dir, 'accounts.json');
  auditLogPath = join(dir, 'audit.jsonl');
  runProbe = vi.fn(async () => ({ status: 0, stdout: 'OK', stderr: '' }));
  actorKind = undefined;
  app = new Hono();
  app.use('*', async (c, next) => {
    if (actorKind === 'owner') c.set('actor', { kind: 'owner' });
    if (actorKind === 'viewer') c.set('actor', { kind: 'viewer', grantId: 'g', scope: { kind: 'all' } } as never);
    await next();
  });
  registerClaudeAccountRoutes(app, {
    auditLogPath,
    claudeAccounts: {
      load: () => loadClaudeAccounts(file),
      save: (r) => saveClaudeAccounts(r, file),
      runProbe: runProbe as never,
    },
  });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const send = (method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Kookr-Actor': 'dashboard' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const add = (body: unknown) => send('POST', '/api/claude-accounts', body);

describe('claude account routes', () => {
  test('GET on an empty registry lists host as the default', async () => {
    const res = await send('GET', '/api/claude-accounts');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accounts: [{ name: 'host', isDefault: true }], default: 'host' });
  });

  test('POST adds an account from pasted setup-token output; no response or file read-back leaks the token via the API', async () => {
    const res = await add({ name: 'work', token: `Your OAuth token:\n${TOKEN}\nStore it safely.`, label: ' me@work.com ', makeDefault: true });
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text).not.toContain(TOKEN);
    const body = JSON.parse(text);
    expect(body.default).toBe('work');
    expect(body.accounts[1]).toMatchObject({ name: 'work', label: 'me@work.com', isDefault: true, tokenHint: '…WXYZ' });
    expect(loadClaudeAccounts(file).accounts.work?.token).toBe(TOKEN);
    const list = await (await send('GET', '/api/claude-accounts')).text();
    expect(list).not.toContain(TOKEN);
  });

  test('re-adding replaces the token and keeps the label when none is sent', async () => {
    await add({ name: 'work', token: TOKEN, label: 'first' });
    await add({ name: 'work', token: TOKEN_2 });
    const record = loadClaudeAccounts(file).accounts.work;
    expect(record).toMatchObject({ token: TOKEN_2, label: 'first' });
  });

  test.each([
    [{ name: 'Bad Name', token: TOKEN }, 'invalid_name'],
    [{ name: 'host', token: TOKEN }, 'reserved_name'],
    [{ name: 'work', token: 'not a token' }, 'invalid_token'],
    [{ name: 'work', token: TOKEN, label: 'x'.repeat(121) }, 'invalid_label'],
    [{ name: 'work', token: TOKEN, label: 'a\nb' }, 'invalid_label'],
    [{ name: 'work' }, 'invalid_body'],
    [{ name: 5, token: TOKEN }, 'invalid_body'],
    [{ name: 'work', token: TOKEN, makeDefault: 'yes' }, 'invalid_body'],
  ])('POST %j is 400 %s and never echoes the token', async (body, code) => {
    const res = await add(body);
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(JSON.parse(text).code).toBe(code);
    expect(text).not.toContain(TOKEN);
    expect(existsSync(file)).toBe(false);
  });

  test('an invalid name that is itself a token is not echoed', async () => {
    const res = await add({ name: TOKEN, token: TOKEN });
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain(TOKEN);
  });

  test('POST with a non-JSON body is invalid_body', async () => {
    const res = await app.request('/api/claude-accounts', { method: 'POST', body: 'nope' });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('invalid_body');
  });

  test('DELETE removes an account, 404s an unknown one and refuses host', async () => {
    await add({ name: 'work', token: TOKEN, makeDefault: true });
    const ok = await send('DELETE', '/api/claude-accounts/work');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ accounts: [{ name: 'host', isDefault: true }], default: 'host' });
    const missing = await send('DELETE', '/api/claude-accounts/work');
    expect(missing.status).toBe(404);
    expect((await missing.json()).code).toBe('unknown_account');
    const host = await send('DELETE', '/api/claude-accounts/host');
    expect(host.status).toBe(400);
    expect((await host.json()).code).toBe('reserved_name');
  });

  test('PUT default accepts host and registered names, refuses unknown ones with 400', async () => {
    await add({ name: 'work', token: TOKEN });
    const set = await send('PUT', '/api/claude-accounts/default', { name: 'work' });
    expect(set.status).toBe(200);
    expect((await set.json()).default).toBe('work');
    const host = await send('PUT', '/api/claude-accounts/default', { name: 'host' });
    expect((await host.json()).default).toBe('host');
    const unknown = await send('PUT', '/api/claude-accounts/default', { name: 'ghost' });
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).code).toBe('unknown_account');
    expect((await send('PUT', '/api/claude-accounts/default', {})).status).toBe(400);
  });

  test('test route reports the classified outcome and 404s unknown accounts', async () => {
    await add({ name: 'work', token: TOKEN });
    const ok = await send('POST', '/api/claude-accounts/work/test');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ name: 'work', outcome: 'ok', message: 'OK' });

    runProbe.mockResolvedValueOnce({ status: 1, stdout: `Claude usage limit reached for ${TOKEN}`, stderr: '' });
    const limited = await send('POST', '/api/claude-accounts/work/test');
    const text = await limited.text();
    expect(JSON.parse(text).outcome).toBe('usage_limited');
    expect(text).not.toContain(TOKEN);
    expect(JSON.parse(text).testedAt).toMatch(/^\d{4}-/);

    expect((await send('POST', '/api/claude-accounts/ghost/test')).status).toBe(404);
  });

  test('test route returns the quota the probe measured, and omits it when none was reported', async () => {
    await add({ name: 'work', token: TOKEN });
    const stdout = [
      JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: {
        five_hour: { utilization: 0.56, resetsAt: 1795395000, status: 'allowed' },
        seven_day: { utilization: 0.22, resetsAt: 1795770000, status: 'allowed' },
      } } }),
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'OK' }),
    ].join('\n');
    runProbe.mockResolvedValueOnce({ status: 0, stdout, stderr: '' });
    const body = await (await send('POST', '/api/claude-accounts/work/test')).json();
    expect(body).toMatchObject({
      outcome: 'ok',
      quota: {
        fiveHour: { utilization: 56, resetsAt: new Date(1795395000 * 1000).toISOString(), status: 'allowed' },
        sevenDay: { utilization: 22, resetsAt: new Date(1795770000 * 1000).toISOString(), status: 'allowed' },
      },
    });
    const plain = await (await send('POST', '/api/claude-accounts/work/test')).json();
    expect(plain).not.toHaveProperty('quota');
  });

  test('concurrent test requests for one account run a single probe', async () => {
    await add({ name: 'work', token: TOKEN });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    runProbe.mockImplementation(async () => { await gate; return { status: 0, stdout: 'OK', stderr: '' }; });
    const a = send('POST', '/api/claude-accounts/work/test');
    const b = send('POST', '/api/claude-accounts/work/test');
    await vi.waitFor(() => expect(runProbe).toHaveBeenCalled());
    release();
    expect((await a).status).toBe(200);
    expect((await b).status).toBe(200);
    expect(runProbe).toHaveBeenCalledTimes(1);
  });

  test('a malformed registry is a 500 on GET and mutations refuse to overwrite it', async () => {
    writeFileSync(file, '{ not json');
    const get = await send('GET', '/api/claude-accounts');
    expect(get.status).toBe(500);
    expect((await get.json()).code).toBe('malformed_registry');
    expect((await add({ name: 'work', token: TOKEN })).status).toBe(500);
    expect((await send('DELETE', '/api/claude-accounts/work')).status).toBe(500);
    expect((await send('PUT', '/api/claude-accounts/default', { name: 'host' })).status).toBe(500);
    expect((await send('POST', '/api/claude-accounts/host/test')).status).toBe(500);
    expect(readFileSync(file, 'utf-8')).toBe('{ not json');
  });

  test('mutations write audit rows attributed to the caller, never holding the token', async () => {
    await add({ name: 'work', token: TOKEN, label: 'me@work.com', makeDefault: true });
    await send('PUT', '/api/claude-accounts/default', { name: 'host' });
    await send('DELETE', '/api/claude-accounts/work');
    const raw = readFileSync(auditLogPath, 'utf-8');
    expect(raw).not.toContain(TOKEN);
    const rows = raw.trim().split('\n').map((l) => JSON.parse(l));
    expect(rows.map((r) => r.action)).toEqual(['add', 'set-default', 'remove']);
    expect(rows[0]).toMatchObject({ type: 'claude-account.mutation', actor: { source: 'api', actorId: 'dashboard' }, account: 'work', label: 'me@work.com', makeDefault: true });
  });

  test('a non-owner actor is refused on mutations and tests (403) but not on GET', async () => {
    await add({ name: 'work', token: TOKEN });
    actorKind = 'viewer';
    expect((await add({ name: 'x', token: TOKEN })).status).toBe(403);
    expect((await send('DELETE', '/api/claude-accounts/work')).status).toBe(403);
    expect((await send('PUT', '/api/claude-accounts/default', { name: 'work' })).status).toBe(403);
    expect((await send('POST', '/api/claude-accounts/work/test')).status).toBe(403);
    expect(runProbe).not.toHaveBeenCalled();
    actorKind = 'owner';
    expect((await send('POST', '/api/claude-accounts/work/test')).status).toBe(200);
  });
});
