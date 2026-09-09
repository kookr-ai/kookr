import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  EXIT_OK,
  EXIT_USER_ERROR,
  EXIT_NO_SERVER,
  EXIT_SERVER_ERROR,
  EXIT_AMBIGUOUS,
  parseStopArgs,
  formatStopResults,
  resolveStopBaseUrl,
  runStopCli,
  type BatchAbortResult,
} from './kookr-stop.js';
import { MAX_BATCH_ABORT_TASKS } from '../shared/contracts/messages.js';
import { SUPERVISOR_ACTOR_HEADER } from '../shared/contracts/supervisor-actions.js';

function captureConsole() {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    out: { log: (...a: unknown[]) => logs.push(a.map(String).join(' ')) },
    err: { error: (...a: unknown[]) => errors.push(a.map(String).join(' ')) },
    logs,
    errors,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const BASE_ENV = { KOOKR_API_BASE_URL: 'http://127.0.0.1:4800' } as NodeJS.ProcessEnv;

function abortResult(overrides: Partial<BatchAbortResult> = {}): BatchAbortResult {
  return {
    results: [{ taskId: 't-1', outcome: 'aborted', status: 'cancelled' }],
    summary: { total: 1, aborted: 1, already_terminal: 0, not_found: 0, failed: 0 },
    ...overrides,
  };
}

afterEach(() => vi.restoreAllMocks());

describe('parseStopArgs', () => {
  it('collects positional task ids', () => {
    const a = parseStopArgs(['t-1', 't-2', 't-3']);
    expect(a.taskIds).toEqual(['t-1', 't-2', 't-3']);
    expect(a.error).toBeUndefined();
  });

  it('parses --reason and --json in any order', () => {
    const a = parseStopArgs(['--json', 't-1', '--reason', 'runaway agent']);
    expect(a.taskIds).toEqual(['t-1']);
    expect(a.reason).toBe('runaway agent');
    expect(a.json).toBe(true);
  });

  it('parses --reason=value form', () => {
    expect(parseStopArgs(['t-1', '--reason=stuck']).reason).toBe('stuck');
  });

  it('rejects a missing --reason value', () => {
    expect(parseStopArgs(['t-1', '--reason']).error).toMatch(/requires a value/);
  });

  it('rejects an unknown option', () => {
    expect(parseStopArgs(['t-1', '--frob']).error).toMatch(/unknown option/);
  });

  it('treats tokens after `--` as task ids', () => {
    const a = parseStopArgs(['--', '--weird-id']);
    expect(a.taskIds).toEqual(['--weird-id']);
    expect(a.error).toBeUndefined();
  });

  it('sets help', () => {
    expect(parseStopArgs(['-h']).help).toBe(true);
    expect(parseStopArgs(['--help']).help).toBe(true);
  });
});

describe('formatStopResults', () => {
  it('renders a per-task table and a summary line', () => {
    const text = formatStopResults({
      results: [
        { taskId: 't-1', outcome: 'aborted', status: 'cancelled' },
        { taskId: 't-2', outcome: 'already_terminal', status: 'completed' },
        { taskId: 't-3', outcome: 'not_found' },
        { taskId: 't-4', outcome: 'failed', error: 'boom' },
      ],
      summary: { total: 4, aborted: 1, already_terminal: 1, not_found: 1, failed: 1 },
    });
    expect(text).toContain('Aborted 1 of 4 task(s).');
    expect(text).toContain('t-1');
    expect(text).toContain('cancelled');
    expect(text).toContain('not_found');
    expect(text).toContain('— boom');
    expect(text).toContain('aborted=1  already_terminal=1  not_found=1  failed=1');
  });
});

describe('resolveStopBaseUrl', () => {
  it('uses KOOKR_API_BASE_URL verbatim (trailing slash trimmed)', async () => {
    const r = await resolveStopBaseUrl({
      env: { KOOKR_API_BASE_URL: 'http://127.0.0.1:4800/' } as NodeJS.ProcessEnv,
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });
    expect(r).toEqual({ kind: 'ok', baseUrl: 'http://127.0.0.1:4800' });
  });

  it('rejects an invalid KOOKR_PORT', async () => {
    const r = await resolveStopBaseUrl({
      env: { KOOKR_PORT: 'abc' } as NodeJS.ProcessEnv,
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });
    expect(r).toEqual({ kind: 'invalid_port', raw: 'abc' });
  });

  it('reports ambiguous when both ports respond', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    const r = await resolveStopBaseUrl({ env: {} as NodeJS.ProcessEnv, fetchImpl });
    expect(r).toEqual({ kind: 'ambiguous', ports: [4800, 4801] });
  });

  it('picks the single reachable port', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes('4801')
        ? new Response('{}', { status: 200 })
        : Promise.reject(new Error('ECONNREFUSED')),
    ) as unknown as typeof fetch;
    const r = await resolveStopBaseUrl({ env: {} as NodeJS.ProcessEnv, fetchImpl });
    expect(r).toEqual({ kind: 'ok', baseUrl: 'http://127.0.0.1:4801' });
  });

  it('returns none when no port responds', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    const r = await resolveStopBaseUrl({ env: {} as NodeJS.ProcessEnv, fetchImpl });
    expect(r).toEqual({ kind: 'none' });
  });
});

describe('runStopCli', () => {
  it('prints help and exits OK', async () => {
    const io = captureConsole();
    const code = await runStopCli(['--help'], { env: BASE_ENV, out: io.out, err: io.err });
    expect(code).toBe(EXIT_OK);
    expect(io.logs.join('\n')).toContain('kookr stop');
  });

  it('requires at least one task id', async () => {
    const io = captureConsole();
    const fetchImpl = vi.fn();
    const code = await runStopCli([], {
      env: BASE_ENV, out: io.out, err: io.err, fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(code).toBe(EXIT_USER_ERROR);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('POSTs { taskIds, reason } and prints the per-task table', async () => {
    const io = captureConsole();
    // Capture the request and assert AFTER the call: an expect() thrown inside the
    // mock is swallowed by runStopCli's own try/catch (it would surface as a
    // misleading NO_SERVER exit), so the body/URL/method checks must live outside.
    let captured: { url: string; init?: RequestInit } | undefined;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      captured = { url, init };
      return jsonResponse(
        abortResult({
          results: [
            { taskId: 't-1', outcome: 'aborted', status: 'cancelled' },
            { taskId: 't-2', outcome: 'already_terminal', status: 'completed' },
          ],
          summary: { total: 2, aborted: 1, already_terminal: 1, not_found: 0, failed: 0 },
        }),
      );
    }) as unknown as typeof fetch;

    const code = await runStopCli(['t-1', 't-2', '--reason', 'stuck'], {
      env: BASE_ENV, out: io.out, err: io.err, fetchImpl,
    });
    expect(code).toBe(EXIT_OK);
    expect(captured?.url).toBe('http://127.0.0.1:4800/api/tasks/abort');
    expect(captured?.init?.method).toBe('POST');
    expect(JSON.parse(String(captured?.init?.body))).toEqual({ taskIds: ['t-1', 't-2'], reason: 'stuck' });
    expect(io.logs.join('\n')).toContain('Aborted 1 of 2 task(s).');
  });

  it('omits reason from the POST body when --reason is not given', async () => {
    let captured: RequestInit | undefined;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      captured = init;
      return jsonResponse(abortResult());
    }) as unknown as typeof fetch;
    const io = captureConsole();
    const code = await runStopCli(['t-1'], { env: BASE_ENV, out: io.out, err: io.err, fetchImpl });
    expect(code).toBe(EXIT_OK);
    expect(JSON.parse(String(captured?.body))).toEqual({ taskIds: ['t-1'] });
  });

  it('forwards the supervisor token as the Authorization header (with the cli actor) when set', async () => {
    let headers: Record<string, string> | undefined;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      headers = init?.headers as Record<string, string>;
      return jsonResponse(abortResult());
    }) as unknown as typeof fetch;

    const io = captureConsole();
    const code = await runStopCli(['t-1'], {
      env: { ...BASE_ENV, KOOKR_SUPERVISOR_TOKEN: 'super-secret' } as NodeJS.ProcessEnv,
      out: io.out, err: io.err, fetchImpl,
    });
    expect(code).toBe(EXIT_OK);
    expect(headers?.Authorization).toBe('Bearer super-secret');
    expect(headers?.[SUPERVISOR_ACTOR_HEADER]).toBe('cli');
  });

  it('falls back to KOOKR_API_TOKEN for the Authorization header when no supervisor token is set', async () => {
    let headers: Record<string, string> | undefined;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      headers = init?.headers as Record<string, string>;
      return jsonResponse(abortResult());
    }) as unknown as typeof fetch;
    const io = captureConsole();
    const code = await runStopCli(['t-1'], {
      env: { ...BASE_ENV, KOOKR_API_TOKEN: 'api-tok' } as NodeJS.ProcessEnv,
      out: io.out, err: io.err, fetchImpl,
    });
    expect(code).toBe(EXIT_OK);
    expect(headers?.Authorization).toBe('Bearer api-tok');
  });

  it('prefers the supervisor token over KOOKR_API_TOKEN when both are set', async () => {
    let headers: Record<string, string> | undefined;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      headers = init?.headers as Record<string, string>;
      return jsonResponse(abortResult());
    }) as unknown as typeof fetch;
    const io = captureConsole();
    const code = await runStopCli(['t-1'], {
      env: { ...BASE_ENV, KOOKR_SUPERVISOR_TOKEN: 'super', KOOKR_API_TOKEN: 'api-tok' } as NodeJS.ProcessEnv,
      out: io.out, err: io.err, fetchImpl,
    });
    expect(code).toBe(EXIT_OK);
    expect(headers?.Authorization).toBe('Bearer super');
  });

  it('omits the Authorization header when no token is set', async () => {
    let headers: Record<string, string> | undefined;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      headers = init?.headers as Record<string, string>;
      return jsonResponse(abortResult());
    }) as unknown as typeof fetch;

    const io = captureConsole();
    const code = await runStopCli(['t-1'], { env: BASE_ENV, out: io.out, err: io.err, fetchImpl });
    expect(code).toBe(EXIT_OK);
    expect(headers?.Authorization).toBeUndefined();
  });

  it('emits a structured --json envelope on success', async () => {
    const io = captureConsole();
    const result = abortResult();
    const fetchImpl = vi.fn(async () => jsonResponse(result)) as unknown as typeof fetch;
    const code = await runStopCli(['t-1', '--json'], { env: BASE_ENV, out: io.out, err: io.err, fetchImpl });
    expect(code).toBe(EXIT_OK);
    const envelope = JSON.parse(io.logs[0]);
    expect(envelope).toMatchObject({ ok: true, code: 'OK', details: result });
  });

  it('exits SERVER_ERROR and flags ok:false when a task fails to abort', async () => {
    const io = captureConsole();
    const result = abortResult({
      results: [{ taskId: 't-1', outcome: 'failed', error: 'session kill timed out' }],
      summary: { total: 1, aborted: 0, already_terminal: 0, not_found: 0, failed: 1 },
    });
    const fetchImpl = vi.fn(async () => jsonResponse(result)) as unknown as typeof fetch;
    const code = await runStopCli(['t-1', '--json'], { env: BASE_ENV, out: io.out, err: io.err, fetchImpl });
    expect(code).toBe(EXIT_SERVER_ERROR);
    expect(JSON.parse(io.logs[0])).toMatchObject({ ok: false, code: 'ABORT_PARTIAL_FAILURE' });
  });

  it('surfaces an HTTP error (e.g. 401 supervisor-unauthorized) as SERVER_ERROR', async () => {
    const io = captureConsole();
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'supervisor-unauthorized' }, 401)) as unknown as typeof fetch;
    const code = await runStopCli(['t-1'], { env: BASE_ENV, out: io.out, err: io.err, fetchImpl });
    expect(code).toBe(EXIT_SERVER_ERROR);
    expect(io.errors.join('\n')).toContain('supervisor-unauthorized');
  });

  it('reports no server reachable when the request throws', async () => {
    const io = captureConsole();
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    const code = await runStopCli(['t-1'], { env: BASE_ENV, out: io.out, err: io.err, fetchImpl });
    expect(code).toBe(EXIT_NO_SERVER);
  });

  it('reports ambiguous-port as its own exit code', async () => {
    const io = captureConsole();
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    const code = await runStopCli(['t-1', '--json'], {
      env: {} as NodeJS.ProcessEnv, out: io.out, err: io.err, fetchImpl,
    });
    expect(code).toBe(EXIT_AMBIGUOUS);
    expect(JSON.parse(io.logs[0])).toMatchObject({ ok: false, code: 'AMBIGUOUS_PORT', details: { ports: [4800, 4801] } });
  });

  it('rejects an invalid KOOKR_PORT as a user error', async () => {
    const io = captureConsole();
    const fetchImpl = vi.fn();
    const code = await runStopCli(['t-1'], {
      env: { KOOKR_PORT: 'nope' } as NodeJS.ProcessEnv,
      out: io.out, err: io.err, fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(code).toBe(EXIT_USER_ERROR);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a batch larger than MAX_BATCH_ABORT_TASKS without sending a request', async () => {
    const io = captureConsole();
    const fetchImpl = vi.fn();
    const taskIds = Array.from({ length: MAX_BATCH_ABORT_TASKS + 1 }, (_, i) => `t-${i}`);
    const code = await runStopCli(taskIds, {
      env: BASE_ENV, out: io.out, err: io.err, fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(code).toBe(EXIT_USER_ERROR);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(io.errors.join('\n')).toContain(String(MAX_BATCH_ABORT_TASKS));
  });

  it('reports NO_SERVER when every default port probe fails (no explicit target)', async () => {
    const io = captureConsole();
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    const code = await runStopCli(['t-1', '--json'], {
      env: {} as NodeJS.ProcessEnv, out: io.out, err: io.err, fetchImpl,
    });
    expect(code).toBe(EXIT_NO_SERVER);
    expect(JSON.parse(io.logs[0])).toMatchObject({ ok: false, code: 'NO_SERVER' });
  });

  it('treats a malformed 2xx body (missing summary counts) as a server error, not a silent success', async () => {
    const io = captureConsole();
    // results present but summary omits the numeric fields — the guard must reject it
    // rather than let `summary.failed > 0` read undefined as a clean success.
    const fetchImpl = vi.fn(async () => jsonResponse({ results: [], summary: {} })) as unknown as typeof fetch;
    const code = await runStopCli(['t-1'], { env: BASE_ENV, out: io.out, err: io.err, fetchImpl });
    expect(code).toBe(EXIT_SERVER_ERROR);
    expect(io.errors.join('\n')).toContain('unexpected');
  });

  it('classifies a request timeout as a server-side condition (exit 4), not NO_SERVER', async () => {
    const io = captureConsole();
    const fetchImpl = vi.fn(async () => {
      // AbortSignal.timeout rejects with a DOMException named 'TimeoutError'.
      const err = new Error('The operation timed out.');
      err.name = 'TimeoutError';
      throw err;
    }) as unknown as typeof fetch;
    const code = await runStopCli(['t-1', '--json'], { env: BASE_ENV, out: io.out, err: io.err, fetchImpl });
    expect(code).toBe(EXIT_SERVER_ERROR);
    expect(JSON.parse(io.logs[0])).toMatchObject({ ok: false, code: 'TIMEOUT', details: { taskIds: ['t-1'] } });
  });
});
