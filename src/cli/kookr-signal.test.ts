import { describe, expect, it, vi } from 'vitest';
import {
  parseArgs,
  resolveTaskId,
  main,
} from '../../bin/kookr-signal.js';
import { MAX_AGENT_SIGNAL_NOTE_LENGTH } from '../shared/contracts/agent-signal.js';

const EXIT_OK = 0;
const EXIT_USER_ERROR = 2;
const EXIT_NO_SERVER = 3;
const EXIT_SERVER_ERROR = 4;

function mkConsole() {
  const logs: string[] = [];
  const errs: string[] = [];
  return {
    out: { log: (m?: unknown) => logs.push(String(m)) },
    err: { error: (m?: unknown) => errs.push(String(m)) },
    logs,
    errs,
  };
}

describe('kookr signal parseArgs', () => {
  it('parses kind, note and task-id', () => {
    expect(parseArgs(['completion-ready', '--note', 'hi', '--task-id', 't-1'])).toEqual({
      kind: 'completion-ready',
      note: 'hi',
      taskId: 't-1',
      json: false,
      help: false,
    });
  });

  it('supports --note= and --task-id= forms', () => {
    expect(parseArgs(['completion-ready', '--note=done', '--task-id=t-2'])).toMatchObject({
      kind: 'completion-ready',
      note: 'done',
      taskId: 't-2',
    });
  });

  it('parses --json', () => {
    expect(parseArgs(['completion-ready', '--json'])).toMatchObject({
      kind: 'completion-ready',
      json: true,
    });
  });

  it('throws on unknown option and extra positional', () => {
    expect(() => parseArgs(['completion-ready', '--bogus'])).toThrow();
    expect(() => parseArgs(['completion-ready', 'extra'])).toThrow();
  });
});

describe('kookr signal resolveTaskId', () => {
  it('prefers --task-id over env', () => {
    expect(resolveTaskId({ args: { taskId: 't-flag' }, env: { KOOKR_TASK_ID: 't-env' } })).toBe('t-flag');
  });
  it('falls back to KOOKR_TASK_ID', () => {
    expect(resolveTaskId({ args: { taskId: null }, env: { KOOKR_TASK_ID: 't-env' } })).toBe('t-env');
  });
  it('returns null when neither is set', () => {
    expect(resolveTaskId({ args: { taskId: null }, env: {} })).toBeNull();
  });
});

describe('kookr signal main', () => {
  it('exits 2 when no task id is available', async () => {
    const { out, err } = mkConsole();
    const exit = vi.fn();
    await main({ argv: ['completion-ready'], env: {}, out, err, exit });
    expect(exit).toHaveBeenCalledWith(EXIT_USER_ERROR);
  });

  it('emits a JSON envelope on user error when requested', async () => {
    const { out, err, logs, errs } = mkConsole();
    const exit = vi.fn();
    await main({ argv: ['completion-ready', '--json'], env: {}, out, err, exit });
    expect(exit).toHaveBeenCalledWith(EXIT_USER_ERROR);
    expect(errs).toEqual([]);
    expect(JSON.parse(logs[0] ?? '{}')).toEqual({
      ok: false,
      code: 'USER_ERROR',
      message: 'no task id. Set KOOKR_TASK_ID (auto-injected into managed tasks) or pass --task-id.',
      details: { subcommand: 'signal' },
    });
  });

  it('exits 2 on unknown kind', async () => {
    const { err } = mkConsole();
    const exit = vi.fn();
    await main({ argv: ['bogus'], env: { KOOKR_TASK_ID: 't-1' }, out: { log: () => {} }, err, exit });
    expect(exit).toHaveBeenCalledWith(EXIT_USER_ERROR);
  });

  it('prints help and exits 0', async () => {
    const { out, logs } = mkConsole();
    const exit = vi.fn();
    await main({ argv: ['--help'], env: {}, out, err: { error: () => {} }, exit });
    expect(exit).toHaveBeenCalledWith(EXIT_OK);
    expect(logs.join('\n')).toContain('kookr signal');
  });

  it('emits a JSON envelope for help when requested', async () => {
    const { out, logs } = mkConsole();
    const exit = vi.fn();
    await main({ argv: ['--json', '--help'], env: {}, out, err: { error: () => {} }, exit });
    expect(exit).toHaveBeenCalledWith(EXIT_OK);
    expect(JSON.parse(logs[0] ?? '{}')).toMatchObject({
      ok: true,
      code: 'OK',
      message: 'Help',
      details: { help: expect.stringContaining('kookr signal') },
    });
  });

  it('exits 2 on an invalid KOOKR_PORT', async () => {
    const exit = vi.fn();
    await main({
      argv: ['completion-ready'],
      env: { KOOKR_TASK_ID: 't-1', KOOKR_PORT: 'nope' },
      out: { log: () => {} },
      err: { error: () => {} },
      exit,
    });
    expect(exit).toHaveBeenCalledWith(EXIT_USER_ERROR);
  });

  it('exits 0 and POSTs the signal on success', async () => {
    const { out } = mkConsole();
    const exit = vi.fn();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await main({
        argv: ['completion-ready', '--note', 'tests green'],
        env: { KOOKR_TASK_ID: 't-1', KOOKR_API_BASE_URL: 'http://127.0.0.1:4800' },
        out,
        err: { error: () => {} },
        exit,
      });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(exit).toHaveBeenCalledWith(EXIT_OK);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('http://127.0.0.1:4800/api/tasks/t-1/signal');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ kind: 'completion_ready', note: 'tests green' });
  });

  it('emits a success JSON envelope with server truncation state', async () => {
    const { out, err, logs, errs } = mkConsole();
    const exit = vi.fn();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, truncated: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await main({
        argv: ['completion-ready', '--json'],
        env: { KOOKR_TASK_ID: 't-1', KOOKR_API_BASE_URL: 'http://127.0.0.1:4800' },
        out,
        err,
        exit,
      });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(exit).toHaveBeenCalledWith(EXIT_OK);
    expect(errs).toEqual([]);
    expect(JSON.parse(logs[0] ?? '{}')).toEqual({
      ok: true,
      code: 'OK',
      message: 'Signal raised.',
      details: { truncated: true },
    });
  });

  it('does not truncate notes before POSTing and reports server truncation', async () => {
    const { out, logs } = mkConsole();
    const exit = vi.fn();
    const note = `${'progress '.repeat(Math.ceil(MAX_AGENT_SIGNAL_NOTE_LENGTH / 'progress '.length))}final ask preserved`;
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, truncated: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await main({
        argv: ['completion-ready', '--note', note],
        env: { KOOKR_TASK_ID: 't-1', KOOKR_API_BASE_URL: 'http://127.0.0.1:4800' },
        out,
        err: { error: () => {} },
        exit,
      });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(exit).toHaveBeenCalledWith(EXIT_OK);
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ kind: 'completion_ready', note });
    expect(logs.join('\n')).toContain('Note was truncated by the server');
  });

  it('exits 4 (advisory-distinct) when the server rejects the signal', async () => {
    const exit = vi.fn();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'Task not found' }), { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await main({
        argv: ['completion-ready'],
        env: { KOOKR_TASK_ID: 'missing', KOOKR_API_BASE_URL: 'http://127.0.0.1:4800' },
        out: { log: () => {} },
        err: { error: () => {} },
        exit,
      });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(exit).toHaveBeenCalledWith(EXIT_SERVER_ERROR);
  });

  it('emits a JSON envelope when the server rejects the signal', async () => {
    const { out, err, logs, errs } = mkConsole();
    const exit = vi.fn();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'Task not found' }), { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await main({
        argv: ['completion-ready', '--json'],
        env: { KOOKR_TASK_ID: 'missing', KOOKR_API_BASE_URL: 'http://127.0.0.1:4800' },
        out,
        err,
        exit,
      });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(exit).toHaveBeenCalledWith(EXIT_SERVER_ERROR);
    expect(errs).toEqual([]);
    expect(JSON.parse(logs[0] ?? '{}')).toEqual({
      ok: false,
      code: 'SERVER_ERROR',
      message: 'server rejected the signal (HTTP 404): Task not found',
      details: { status: 404 },
    });
  });

  it('exits 3 (advisory) when no server is reachable', async () => {
    const exit = vi.fn();
    const fetchMock = vi.fn(async () => {
      throw new Error('connection refused');
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      await main({
        argv: ['completion-ready'],
        env: { KOOKR_TASK_ID: 't-1', KOOKR_API_BASE_URL: 'http://127.0.0.1:4800' },
        out: { log: () => {} },
        err: { error: () => {} },
        exit,
      });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(exit).toHaveBeenCalledWith(EXIT_NO_SERVER);
  });

  it('emits a JSON envelope when no server is reachable', async () => {
    const { out, err, logs, errs } = mkConsole();
    const exit = vi.fn();
    const fetchMock = vi.fn(async () => {
      throw new Error('connection refused');
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      await main({
        argv: ['completion-ready', '--json'],
        env: { KOOKR_TASK_ID: 't-1', KOOKR_API_BASE_URL: 'http://127.0.0.1:4800' },
        out,
        err,
        exit,
      });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(exit).toHaveBeenCalledWith(EXIT_NO_SERVER);
    expect(errs).toEqual([]);
    expect(JSON.parse(logs[0] ?? '{}')).toEqual({
      ok: false,
      code: 'NO_SERVER',
      message: 'request failed: connection refused (advisory)',
      details: { subcommand: 'signal' },
    });
  });
});
