import { vi } from 'vitest';
import type {
  ClaudeAccountQuota,
  ClaudeAccountsResponse,
  ClaudeAccountTestOutcome,
  ClaudeAccountView,
} from '../../shared/contracts/claude-accounts.js';

/** Test-only fake of the `/api/claude-accounts` routes behind a stubbed `fetch`. */
export interface FakeAccountsServer {
  accounts: ClaudeAccountView[];
  defaultName: string;
  /** Outcome returned by `POST /:name/test`, by account name (default `ok`). */
  testOutcomes: Record<string, ClaudeAccountTestOutcome>;
  /** Usage returned by `POST /:name/test`, by account name (default none). Such a test is dated now. */
  testQuotas: Record<string, ClaudeAccountQuota>;
  /** When set, `POST /api/claude-accounts` refuses with this body. */
  addError?: { error: string; code: string };
  /** When set, `POST /api/tasks/:id/claude-account` refuses with this body (409). */
  switchError?: { error: string; code: string };
  calls: Array<{ method: string; url: string; body: unknown }>;
}

export function makeAccount(name: string, extra: Partial<ClaudeAccountView> = {}): ClaudeAccountView {
  return {
    name,
    isDefault: false,
    ...(name === 'host' ? {} : { tokenHint: 'wxyz', addedAt: '2026-01-01T00:00:00.000Z' }),
    ...extra,
  };
}

export function installFakeAccountsServer(
  registered: string[] = [],
  defaultName = 'host',
): FakeAccountsServer {
  const server: FakeAccountsServer = {
    accounts: [],
    defaultName,
    testOutcomes: {},
    testQuotas: {},
    calls: [],
  };
  server.accounts = ['host', ...registered].map((name) => makeAccount(name));
  const snapshot = (): ClaudeAccountsResponse => ({
    accounts: server.accounts.map((a) => ({ ...a, isDefault: a.name === server.defaultName })),
    default: server.defaultName,
  });
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    server.calls.push({ method, url, body });
    if (url === '/api/claude-accounts' && method === 'GET') return json(200, snapshot());
    if (url === '/api/claude-accounts' && method === 'POST') {
      if (server.addError) return json(400, server.addError);
      const name = String(body?.name);
      server.accounts = [...server.accounts.filter((a) => a.name !== name), makeAccount(name, { label: body?.label as string | undefined })];
      return json(201, snapshot());
    }
    if (url === '/api/claude-accounts/default' && method === 'PUT') {
      server.defaultName = String(body?.name);
      return json(200, snapshot());
    }
    const test = /^\/api\/claude-accounts\/([^/]+)\/test$/.exec(url);
    if (test && method === 'POST') {
      const name = decodeURIComponent(test[1]);
      const outcome = server.testOutcomes[name] ?? 'ok';
      const quota = server.testQuotas[name];
      return json(200, {
        name,
        outcome,
        message: `${name} says ${outcome}`,
        testedAt: quota ? new Date().toISOString() : '2026-01-01T00:00:00.000Z',
        ...(quota ? { quota } : {}),
      });
    }
    const del = /^\/api\/claude-accounts\/([^/]+)$/.exec(url);
    if (del && method === 'DELETE') {
      const name = decodeURIComponent(del[1]);
      server.accounts = server.accounts.filter((a) => a.name !== name);
      if (server.defaultName === name) server.defaultName = 'host';
      return json(200, snapshot());
    }
    const sw = /^\/api\/tasks\/([^/]+)\/claude-account$/.exec(url);
    if (sw && method === 'POST') {
      if (server.switchError) return json(409, server.switchError);
      return json(200, { ok: true, outcome: 'restarted', from: 'host', to: body?.account, task: {} });
    }
    return json(404, { error: `unrouted ${method} ${url}` });
  }));
  return server;
}
