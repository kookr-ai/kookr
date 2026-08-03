import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EXIT_NO_SERVER,
  EXIT_OK,
  EXIT_SERVER_ERROR,
  EXIT_USER_ERROR,
  formatGithubStatusLine,
  parseGithubArgs,
  parseGithubStatusBody,
  runGithubCli,
} from './kookr-github.js';

function captureConsole() {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    out: { log: (msg?: unknown) => logs.push(String(msg ?? '')) },
    err: { error: (msg?: unknown) => errors.push(String(msg ?? '')) },
    logs,
    errors,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(body === undefined ? '' : JSON.stringify(body), { status });
}

const SNAPSHOT = {
  active: true,
  stateFetchBackoffMs: 1500,
  repoHealthBackoffMs: 0,
  trackedRefCount: 4,
} as const;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseGithubArgs', () => {
  it('parses status with optional --json', () => {
    expect(parseGithubArgs(['status'])).toEqual({ verb: 'status', json: false, help: false });
    expect(parseGithubArgs(['status', '--json'])).toEqual({ verb: 'status', json: true, help: false });
    expect(parseGithubArgs(['--json', 'status'])).toEqual({ verb: 'status', json: true, help: false });
  });

  it('parses --help', () => {
    expect(parseGithubArgs(['--help']).help).toBe(true);
    expect(parseGithubArgs(['-h', 'status']).help).toBe(true);
  });

  it('rejects unknown options and verbs', () => {
    expect(parseGithubArgs(['status', '--nope']).error).toMatch(/unknown option/);
    expect(parseGithubArgs(['list']).error).toMatch(/unknown verb/);
    expect(parseGithubArgs(['status', 'extra']).error).toMatch(/unexpected argument/);
  });
});

describe('formatGithubStatusLine / parseGithubStatusBody', () => {
  it('renders a single human line', () => {
    expect(formatGithubStatusLine(SNAPSHOT)).toBe(
      'github scanner: active  state-fetch-backoff=1500ms  repo-health-backoff=0ms  tracked-refs=4',
    );
    expect(formatGithubStatusLine({ ...SNAPSHOT, active: false })).toContain('inactive');
  });

  it('parses a well-formed body and rejects malformed ones', () => {
    expect(parseGithubStatusBody(SNAPSHOT)).toEqual(SNAPSHOT);
    expect(parseGithubStatusBody({ active: true })).toBeNull();
    expect(parseGithubStatusBody(null)).toBeNull();
  });
});

describe('runGithubCli', () => {
  it('prints help and returns 0', async () => {
    const c = captureConsole();
    const code = await runGithubCli(['--help'], { env: {}, out: c.out, err: c.err });
    expect(code).toBe(EXIT_OK);
    expect(c.logs.join('\n')).toMatch(/kookr github/);
  });

  it('returns 2 when the verb is missing', async () => {
    const c = captureConsole();
    const code = await runGithubCli([], { env: {}, out: c.out, err: c.err });
    expect(code).toBe(EXIT_USER_ERROR);
    expect(c.errors.join('\n')).toMatch(/verb is required/);
  });

  it('returns 2 on invalid KOOKR_PORT', async () => {
    const c = captureConsole();
    const code = await runGithubCli(['status'], {
      env: { KOOKR_PORT: 'nope' },
      out: c.out,
      err: c.err,
    });
    expect(code).toBe(EXIT_USER_ERROR);
    expect(c.errors.join('\n')).toMatch(/KOOKR_PORT/);
  });

  it('returns 3 when no server is reachable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const c = captureConsole();
    const code = await runGithubCli(['status'], {
      env: {},
      out: c.out,
      err: c.err,
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(code).toBe(EXIT_NO_SERVER);
    expect(c.errors.join('\n')).toMatch(/no Kookr server reachable/);
  });

  it('prints a human line against a fake server', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/github/status')) return jsonResponse(SNAPSHOT);
      return jsonResponse({ error: 'not found' }, 404);
    });
    const c = captureConsole();
    const code = await runGithubCli(['status'], {
      env: { KOOKR_API_BASE_URL: 'http://127.0.0.1:4800' },
      out: c.out,
      err: c.err,
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(code).toBe(EXIT_OK);
    expect(c.logs).toEqual([formatGithubStatusLine(SNAPSHOT)]);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:4800/api/github/status');
    expect(init.method).toBe('GET');
  });

  it('prints a JSON envelope with --json', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(SNAPSHOT));
    const c = captureConsole();
    const code = await runGithubCli(['status', '--json'], {
      env: { KOOKR_API_BASE_URL: 'http://127.0.0.1:4800' },
      out: c.out,
      err: c.err,
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(code).toBe(EXIT_OK);
    expect(JSON.parse(c.logs[0])).toEqual({
      ok: true,
      code: 'OK',
      message: 'GitHub scanner status',
      details: SNAPSHOT,
    });
  });

  it('attaches KOOKR_API_TOKEN as Bearer auth', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(SNAPSHOT));
    const c = captureConsole();
    await runGithubCli(['status'], {
      env: { KOOKR_API_BASE_URL: 'http://127.0.0.1:4800', KOOKR_API_TOKEN: '  secret  ' },
      out: c.out,
      err: c.err,
      fetchImpl: fetchImpl as typeof fetch,
    });
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer secret');
  });

  it('returns 4 on non-2xx', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'boom' }, 500));
    const c = captureConsole();
    const code = await runGithubCli(['status'], {
      env: { KOOKR_API_BASE_URL: 'http://127.0.0.1:4800' },
      out: c.out,
      err: c.err,
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(code).toBe(EXIT_SERVER_ERROR);
    expect(c.errors.join('\n')).toMatch(/HTTP 500/);
  });

  it('returns 4 when the payload shape is wrong', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ active: true }));
    const c = captureConsole();
    const code = await runGithubCli(['status', '--json'], {
      env: { KOOKR_API_BASE_URL: 'http://127.0.0.1:4800' },
      out: c.out,
      err: c.err,
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(code).toBe(EXIT_SERVER_ERROR);
    const payload = JSON.parse(c.logs[0]!);
    expect(payload.ok).toBe(false);
    expect(payload.code).toBe('SERVER_ERROR');
  });
});
