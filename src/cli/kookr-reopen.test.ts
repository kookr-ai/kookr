import { describe, expect, it, vi } from 'vitest';

import { parseReopenArgs, runReopenCli } from './kookr-reopen.js';
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
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const BASE_ENV = { KOOKR_API_BASE_URL: 'http://127.0.0.1:4800' } as NodeJS.ProcessEnv;

function reopened(resume: unknown, status = 'inProgress') {
  return { ok: true, task: { id: 't-1', status, name: 'demo' }, resume };
}

describe('parseReopenArgs', () => {
  it('takes one positional task id and --json in any order', () => {
    expect(parseReopenArgs(['--json', 't-1'])).toEqual({ taskId: 't-1', json: true, help: false });
  });

  it('rejects a second task id', () => {
    expect(parseReopenArgs(['t-1', 't-2']).error).toMatch(/one <taskId>/);
  });

  it('rejects an unknown option', () => {
    expect(parseReopenArgs(['--force', 't-1']).error).toBe('unknown option: --force');
  });
});

describe('runReopenCli', () => {
  it('POSTs to the reopen route and prints that the task resumes its conversation', async () => {
    const io = captureConsole();
    const fetchImpl = vi.fn(async () => jsonResponse(reopened({ mode: 'resume', conversationId: 'sess-1' })));

    const code = await runReopenCli(['t-1'], { env: BASE_ENV, ...io, fetchImpl: fetchImpl as never });

    expect(code).toBe(0);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:4800/api/tasks/t-1/reopen');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)[SUPERVISOR_ACTOR_HEADER]).toBe('cli');
    expect(io.logs.join('\n')).toContain('Reopened task t-1 (now inProgress).');
    expect(io.logs.join('\n')).toContain('Conversation: resumes sess-1');
  });

  it('prints an opencode resume as a best effort, with its caveat', async () => {
    const io = captureConsole();
    const fetchImpl = vi.fn(async () =>
      jsonResponse(reopened({ mode: 'resume', conversationId: 'ses_1', caveat: 'starts fresh if it is gone' })),
    );
    expect(await runReopenCli(['t-1'], { env: BASE_ENV, ...io, fetchImpl: fetchImpl as never })).toBe(0);
    expect(io.logs.join('\n')).toContain('Conversation: tries to resume ses_1 (starts fresh if it is gone)');
  });

  it('says when the task is not resumable, with the reason', async () => {
    const io = captureConsole();
    const fetchImpl = vi.fn(async () =>
      jsonResponse(reopened({ mode: 'not_resumable', reason: 'no session recorded a provider conversation id' }, 'pending')),
    );

    const code = await runReopenCli(['t-1'], { env: BASE_ENV, ...io, fetchImpl: fetchImpl as never });

    expect(code).toBe(0);
    const text = io.logs.join('\n');
    expect(text).toContain('queued as pending');
    expect(text).toContain('not resumable — no session recorded a provider conversation id');
    expect(text).toContain('Relaunching from the original prompt');
  });

  it('--json emits one envelope carrying the resume report', async () => {
    const io = captureConsole();
    const resume = { mode: 'fresh', reason: 'active Ralph loop: every iteration starts a fresh context' };
    const fetchImpl = vi.fn(async () => jsonResponse(reopened(resume)));

    const code = await runReopenCli(['t-1', '--json'], { env: BASE_ENV, ...io, fetchImpl: fetchImpl as never });

    expect(code).toBe(0);
    expect(io.logs).toHaveLength(1);
    const env = JSON.parse(io.logs[0]!);
    expect(env).toMatchObject({ ok: true, code: 'OK', details: { taskId: 't-1', status: 'inProgress', resume } });
  });

  it('url-encodes the task id', async () => {
    const io = captureConsole();
    const fetchImpl = vi.fn(async () => jsonResponse(reopened({ mode: 'resume', conversationId: 's' })));
    await runReopenCli(['a/b'], { env: BASE_ENV, ...io, fetchImpl: fetchImpl as never });
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe('http://127.0.0.1:4800/api/tasks/a%2Fb/reopen');
  });

  it('forwards KOOKR_SUPERVISOR_TOKEN as a bearer token', async () => {
    const io = captureConsole();
    const fetchImpl = vi.fn(async () => jsonResponse(reopened({ mode: 'resume', conversationId: 's' })));
    await runReopenCli(['t-1'], {
      env: { ...BASE_ENV, KOOKR_SUPERVISOR_TOKEN: 'sup3r' },
      ...io,
      fetchImpl: fetchImpl as never,
    });
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sup3r');
  });

  it('a missing task id is a user error (exit 2) and sends nothing', async () => {
    const io = captureConsole();
    const fetchImpl = vi.fn();
    expect(await runReopenCli([], { env: BASE_ENV, ...io, fetchImpl: fetchImpl as never })).toBe(2);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('404 → NOT_FOUND, exit 2', async () => {
    const io = captureConsole();
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'Task not found' }, 404));
    const code = await runReopenCli(['t-1', '--json'], { env: BASE_ENV, ...io, fetchImpl: fetchImpl as never });
    expect(code).toBe(2);
    expect(JSON.parse(io.logs[0]!)).toMatchObject({ ok: false, code: 'NOT_FOUND' });
  });

  it('409 task_not_terminal → TASK_NOT_TERMINAL, exit 2, with the server message', async () => {
    const io = captureConsole();
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: 'Task t-1 is inProgress; only a completed, terminated, or cancelled task can be reopened', code: 'task_not_terminal' }, 409),
    );
    const code = await runReopenCli(['t-1'], { env: BASE_ENV, ...io, fetchImpl: fetchImpl as never });
    expect(code).toBe(2);
    expect(io.errors.join('\n')).toContain('Task t-1 is inProgress');
  });

  it('409 reopen_launch_failed → SERVER_ERROR, exit 4, keeping the server code', async () => {
    const io = captureConsole();
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: 'Task t-1 was reopened but its relaunch failed: boom', code: 'reopen_launch_failed' }, 409),
    );
    const code = await runReopenCli(['t-1', '--json'], { env: BASE_ENV, ...io, fetchImpl: fetchImpl as never });
    expect(code).toBe(4);
    expect(JSON.parse(io.logs[0]!)).toMatchObject({
      ok: false,
      code: 'SERVER_ERROR',
      message: 'Task t-1 was reopened but its relaunch failed: boom',
      details: { serverCode: 'reopen_launch_failed', status: 409 },
    });
  });

  it('a 2xx body without a resume report is an unexpected response, exit 4', async () => {
    const io = captureConsole();
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true, task: { id: 't-1', status: 'pending' } }));
    expect(await runReopenCli(['t-1'], { env: BASE_ENV, ...io, fetchImpl: fetchImpl as never })).toBe(4);
  });

  it('an unreachable server is exit 3', async () => {
    const io = captureConsole();
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    expect(await runReopenCli(['t-1'], { env: BASE_ENV, ...io, fetchImpl: fetchImpl as never })).toBe(3);
  });

  it('a timeout is exit 4 and tells the caller to check the task before retrying', async () => {
    const io = captureConsole();
    const fetchImpl = vi.fn(async () => {
      const e = new Error('timed out');
      e.name = 'TimeoutError';
      throw e;
    });
    expect(await runReopenCli(['t-1'], { env: BASE_ENV, ...io, fetchImpl: fetchImpl as never })).toBe(4);
    expect(io.errors.join('\n')).toContain('kookr peek t-1');
  });

  describe('server discovery (no KOOKR_API_BASE_URL)', () => {
    /** Health probes answer only on `upPorts`; the reopen POST always succeeds. */
    function probeFetch(upPorts: number[]) {
      return vi.fn(async (url: string) => {
        const port = Number(new URL(url).port);
        if (url.endsWith('/api/health')) {
          if (upPorts.includes(port)) return jsonResponse({ ok: true });
          throw new TypeError('fetch failed');
        }
        return jsonResponse(reopened({ mode: 'resume', conversationId: 's' }));
      });
    }

    it('a non-numeric KOOKR_PORT is a user error, exit 2', async () => {
      const io = captureConsole();
      const fetchImpl = probeFetch([]);
      const code = await runReopenCli(['t-1', '--json'], { env: { KOOKR_PORT: 'abc' }, ...io, fetchImpl: fetchImpl as never });
      expect(code).toBe(2);
      expect(JSON.parse(io.logs[0]!)).toMatchObject({ ok: false, code: 'USER_ERROR' });
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('two reachable instances is ambiguous, exit 5, and nothing is reopened', async () => {
      const io = captureConsole();
      const fetchImpl = probeFetch([4800, 4801]);
      const code = await runReopenCli(['t-1', '--json'], { env: {}, ...io, fetchImpl: fetchImpl as never });
      expect(code).toBe(5);
      expect(JSON.parse(io.logs[0]!)).toMatchObject({ ok: false, code: 'AMBIGUOUS_PORT', details: { ports: [4800, 4801] } });
      expect(fetchImpl.mock.calls.some(([u]) => String(u).endsWith('/reopen'))).toBe(false);
    });

    it('no reachable instance is exit 3', async () => {
      const io = captureConsole();
      const code = await runReopenCli(['t-1'], { env: {}, ...io, fetchImpl: probeFetch([]) as never });
      expect(code).toBe(3);
      expect(io.errors.join('\n')).toContain('no Kookr server reachable');
    });

    it('a single reachable instance is used', async () => {
      const io = captureConsole();
      const fetchImpl = probeFetch([4801]);
      expect(await runReopenCli(['t-1'], { env: {}, ...io, fetchImpl: fetchImpl as never })).toBe(0);
      expect(fetchImpl.mock.calls.map(([u]) => String(u))).toContain('http://127.0.0.1:4801/api/tasks/t-1/reopen');
    });
  });
});
