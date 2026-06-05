import { describe, expect, it, vi } from 'vitest';
import {
  parseArgs,
  resolveTaskId,
  main,
} from '../../bin/kookr-signal.js';

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

  it('exits 2 on unknown kind', async () => {
    const { err } = mkConsole();
    const exit = vi.fn();
    await main({ argv: ['bogus'], env: { KOOKR_TASK_ID: 't-1' }, out: { log: () => {} }, err, exit });
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
});
