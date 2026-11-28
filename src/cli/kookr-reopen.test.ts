import { describe, expect, it, vi } from 'vitest';

import { REOPEN_HELP_TEXT, parseReopenArgs, runReopenCli } from './kookr-reopen.js';
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

  it('takes --note <text> and --note=<text>, trimmed (issue #4227)', () => {
    expect(parseReopenArgs(['t-1', '--note', ' Do not merge. '])).toEqual({ taskId: 't-1', note: 'Do not merge.', json: false, help: false });
    expect(parseReopenArgs(['--note=--force is forbidden', 't-1']).note).toBe('--force is forbidden');
  });

  it('rejects --note without a value or with a blank one', () => {
    expect(parseReopenArgs(['t-1', '--note']).error).toBe('--note requires a value');
    expect(parseReopenArgs(['t-1', '--note', '--json']).error).toBe('--note requires a value');
    expect(parseReopenArgs(['t-1', '--note', '  ']).error).toBe('--note must not be empty');
    expect(parseReopenArgs(['t-1', '--note=']).error).toBe('--note must not be empty');
  });
});

describe('runReopenCli --note and the not_resumable warning (issue #4227)', () => {
  const NOT_RESUMABLE = { mode: 'not_resumable', reason: 'agent type codex-cli does not support resume' };
  const withNote = (resume: unknown, reopenNote?: string) => ({
    ok: true,
    task: { id: 't-1', status: 'pending', ...(reopenNote !== undefined ? { reopenNote } : {}) },
    resume,
  });

  it('sends the note as a JSON body', async () => {
    const io = captureConsole();
    const fetchImpl = vi.fn(async () => jsonResponse(withNote(NOT_RESUMABLE, 'Do not merge.')));

    expect(await runReopenCli(['t-1', '--note', 'Do not merge.'], { env: BASE_ENV, ...io, fetchImpl: fetchImpl as never })).toBe(0);

    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(init.body as string)).toEqual({ note: 'Do not merge.' });
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    const text = io.logs.join('\n');
    expect(text).toContain('Note: the relaunch carries the reopen note');
    expect(text).not.toContain('Warning:');
  });

  it('sends no body without --note', async () => {
    const io = captureConsole();
    const fetchImpl = vi.fn(async () => jsonResponse(withNote({ mode: 'resume', conversationId: 's' })));
    await runReopenCli(['t-1'], { env: BASE_ENV, ...io, fetchImpl: fetchImpl as never });
    expect((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body).toBeUndefined();
  });

  it('warns when a not_resumable task restarts with no note', async () => {
    const io = captureConsole();
    const fetchImpl = vi.fn(async () => jsonResponse(withNote(NOT_RESUMABLE)));

    expect(await runReopenCli(['t-1'], { env: BASE_ENV, ...io, fetchImpl: fetchImpl as never })).toBe(0);

    const text = io.logs.join('\n');
    expect(text).toMatch(/Warning: the task restarts from its original prompt unchanged/);
    expect(text).toContain('kookr reply t-1');
    expect(text).toContain('--note');
  });

  it('--json carries the warning in details.warnings', async () => {
    const io = captureConsole();
    const fetchImpl = vi.fn(async () => jsonResponse(withNote(NOT_RESUMABLE)));

    expect(await runReopenCli(['t-1', '--json'], { env: BASE_ENV, ...io, fetchImpl: fetchImpl as never })).toBe(0);

    expect(io.logs).toHaveLength(1);
    const env = JSON.parse(io.logs[0]!);
    expect(env.details.warnings).toHaveLength(1);
    expect(env.details.warnings[0]).toMatch(/restarts from its original prompt unchanged/);
    expect(env.details.note).toBeUndefined();
  });

  it('does not warn when the task resumes, or already carries a note', async () => {
    for (const body of [withNote({ mode: 'resume', conversationId: 's' }), withNote(NOT_RESUMABLE, 'kept from an earlier reopen')]) {
      const io = captureConsole();
      const fetchImpl = vi.fn(async () => jsonResponse(body));
      await runReopenCli(['t-1', '--json'], { env: BASE_ENV, ...io, fetchImpl: fetchImpl as never });
      expect(JSON.parse(io.logs[0]!).details.warnings).toEqual([]);
    }
  });

  it('--json reports the stored note', async () => {
    const io = captureConsole();
    const fetchImpl = vi.fn(async () => jsonResponse(withNote(NOT_RESUMABLE, 'Do not merge.')));
    await runReopenCli(['t-1', '--json', '--note', 'Do not merge.'], { env: BASE_ENV, ...io, fetchImpl: fetchImpl as never });
    const env = JSON.parse(io.logs[0]!);
    expect(env.details).toMatchObject({ note: 'Do not merge.', warnings: [] });
  });

  it('warns when the server did not store the note it was sent (an older server)', async () => {
    const io = captureConsole();
    const fetchImpl = vi.fn(async () => jsonResponse(withNote({ mode: 'resume', conversationId: 's' })));
    await runReopenCli(['t-1', '--json', '--note', 'Do not merge.'], { env: BASE_ENV, ...io, fetchImpl: fetchImpl as never });
    const env = JSON.parse(io.logs[0]!);
    expect(env.details.warnings).toEqual([expect.stringMatching(/did not store the --note/)]);
  });

  it('a note the server refuses is a user error (exit 2, INVALID_NOTE), not a server error', async () => {
    const io = captureConsole();
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: 'note is longer than 8000 characters', code: 'invalid_reopen_note' }, 400),
    );

    const code = await runReopenCli(['t-1', '--json', '--note', 'x'.repeat(9000)], { env: BASE_ENV, ...io, fetchImpl: fetchImpl as never });

    expect(code).toBe(2);
    expect(JSON.parse(io.logs[0]!)).toMatchObject({ ok: false, code: 'INVALID_NOTE', details: { serverCode: 'invalid_reopen_note', status: 400 } });
  });

  it('documents --note and --clear-note in the help text', () => {
    expect(REOPEN_HELP_TEXT).toContain('kookr reopen <taskId> [--note "<text>" | --clear-note] [--json]');
    expect(REOPEN_HELP_TEXT).toMatch(/--note <text>/);
    expect(REOPEN_HELP_TEXT).toMatch(/--clear-note {4}Remove the note/);
  });
});

describe('kookr reopen --clear-note (issue #4265)', () => {
  const NOT_RESUMABLE = { mode: 'not_resumable', reason: 'agent type codex-cli does not support resume' };
  const RESUME = { mode: 'resume', conversationId: 's' };
  const body = (resume: unknown, reopenNote?: string) => ({
    ok: true,
    task: { id: 't-1', status: 'pending', ...(reopenNote !== undefined ? { reopenNote } : {}) },
    resume,
  });

  it('parses --clear-note in any position', () => {
    expect(parseReopenArgs(['t-1', '--clear-note'])).toEqual({ taskId: 't-1', clearNote: true, json: false, help: false });
    expect(parseReopenArgs(['--clear-note', '--json', 't-1'])).toEqual({ taskId: 't-1', clearNote: true, json: true, help: false });
  });

  it('refuses --note together with --clear-note, in either order', () => {
    expect(parseReopenArgs(['t-1', '--note', 'x', '--clear-note']).error).toBe('--note and --clear-note cannot be used together');
    expect(parseReopenArgs(['t-1', '--clear-note', '--note=x']).error).toBe('--note and --clear-note cannot be used together');
  });

  it('exits 2 without calling the server when both are given', async () => {
    const io = captureConsole();
    const fetchImpl = vi.fn(async () => jsonResponse(body(RESUME)));
    expect(await runReopenCli(['t-1', '--note', 'x', '--clear-note'], { env: BASE_ENV, ...io, fetchImpl: fetchImpl as never })).toBe(2);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('sends { "note": null } as a JSON body and reports the note cleared', async () => {
    const io = captureConsole();
    const fetchImpl = vi.fn(async () => jsonResponse(body(RESUME)));

    expect(await runReopenCli(['t-1', '--clear-note'], { env: BASE_ENV, ...io, fetchImpl: fetchImpl as never })).toBe(0);

    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.body).toBe('{"note":null}');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    const text = io.logs.join('\n');
    expect(text).toContain('Note: the reopen note was cleared; the relaunch carries none.');
    expect(text).not.toContain('Warning:');
  });

  it('--json reports noteCleared and no note', async () => {
    const io = captureConsole();
    const fetchImpl = vi.fn(async () => jsonResponse(body(RESUME)));
    await runReopenCli(['t-1', '--json', '--clear-note'], { env: BASE_ENV, ...io, fetchImpl: fetchImpl as never });
    const env = JSON.parse(io.logs[0]!);
    expect(env.details).toMatchObject({ noteCleared: true, warnings: [] });
    expect(env.details.note).toBeUndefined();
  });

  it('a reopen without --clear-note does not report a cleared note', async () => {
    const io = captureConsole();
    const fetchImpl = vi.fn(async () => jsonResponse(body(RESUME)));
    await runReopenCli(['t-1', '--json'], { env: BASE_ENV, ...io, fetchImpl: fetchImpl as never });
    expect(JSON.parse(io.logs[0]!).details.noteCleared).toBeUndefined();
  });

  it('still warns that a not_resumable task replays its original prompt unchanged', async () => {
    const io = captureConsole();
    const fetchImpl = vi.fn(async () => jsonResponse(body(NOT_RESUMABLE)));
    await runReopenCli(['t-1', '--json', '--clear-note'], { env: BASE_ENV, ...io, fetchImpl: fetchImpl as never });
    const env = JSON.parse(io.logs[0]!);
    expect(env.details.noteCleared).toBe(true);
    expect(env.details.warnings).toEqual([expect.stringMatching(/restarts from its original prompt unchanged/)]);
  });

  it('warns when the server still reports a note after --clear-note', async () => {
    const io = captureConsole();
    const fetchImpl = vi.fn(async () => jsonResponse(body(RESUME, 'Do not merge.')));
    await runReopenCli(['t-1', '--json', '--clear-note'], { env: BASE_ENV, ...io, fetchImpl: fetchImpl as never });
    const env = JSON.parse(io.logs[0]!);
    expect(env.details.noteCleared).toBeUndefined();
    expect(env.details.warnings).toEqual([expect.stringMatching(/did not clear the stored note/)]);
  });

  it('a server that refuses null (older than --clear-note) is a user error with a hint', async () => {
    const io = captureConsole();
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: 'note must be a non-empty string', code: 'invalid_reopen_note' }, 400),
    );
    expect(await runReopenCli(['t-1', '--json', '--clear-note'], { env: BASE_ENV, ...io, fetchImpl: fetchImpl as never })).toBe(2);
    const env = JSON.parse(io.logs[0]!);
    expect(env).toMatchObject({ ok: false, code: 'INVALID_NOTE' });
    expect(env.message).toMatch(/may predate --clear-note/);
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

  it('--json: an unreachable server is NO_SERVER and names the task', async () => {
    const io = captureConsole();
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    expect(await runReopenCli(['t-1', '--json'], { env: BASE_ENV, ...io, fetchImpl: fetchImpl as never })).toBe(3);
    expect(JSON.parse(io.logs[0]!)).toMatchObject({
      ok: false,
      code: 'NO_SERVER',
      details: { subcommand: 'reopen', taskId: 't-1' },
    });
  });

  it('--json --help prints the help inside one envelope and sends nothing', async () => {
    const io = captureConsole();
    const fetchImpl = vi.fn();
    expect(await runReopenCli(['--json', '--help'], { env: BASE_ENV, ...io, fetchImpl: fetchImpl as never })).toBe(0);
    expect(io.logs).toHaveLength(1);
    expect(JSON.parse(io.logs[0]!)).toEqual({
      ok: true,
      code: 'OK',
      message: 'Help',
      details: { subcommand: 'reopen', help: REOPEN_HELP_TEXT },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('--help without --json prints the plain help text', async () => {
    const io = captureConsole();
    expect(await runReopenCli(['--help'], { env: BASE_ENV, ...io })).toBe(0);
    expect(io.logs).toEqual([REOPEN_HELP_TEXT]);
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

    it('--json: no reachable instance is NO_SERVER, exit 3', async () => {
      const io = captureConsole();
      const code = await runReopenCli(['t-1', '--json'], { env: {}, ...io, fetchImpl: probeFetch([]) as never });
      expect(code).toBe(3);
      expect(JSON.parse(io.logs[0]!)).toMatchObject({ ok: false, code: 'NO_SERVER' });
    });

    it('a single reachable instance is used', async () => {
      const io = captureConsole();
      const fetchImpl = probeFetch([4801]);
      expect(await runReopenCli(['t-1'], { env: {}, ...io, fetchImpl: fetchImpl as never })).toBe(0);
      expect(fetchImpl.mock.calls.map(([u]) => String(u))).toContain('http://127.0.0.1:4801/api/tasks/t-1/reopen');
    });
  });
});
