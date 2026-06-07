import { createServer, type IncomingMessage, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EXIT_NO_SERVER,
  EXIT_OK,
  EXIT_SERVER_ERROR,
  EXIT_USER_ERROR,
  UsageError,
  main,
  parseRalphArgs,
  renderRalphStatus,
  requestRalphControl,
  requestRalphStatus,
} from '../../bin/kookr-ralph.js';

function makeConsoleCapture() {
  const logs: string[] = [];
  const errors: string[] = [];
  const io = {
    log: (msg: string) => { logs.push(String(msg)); },
    error: (msg: string) => { errors.push(String(msg)); },
  };
  return { io, logs, errors };
}

function makeExitCapture() {
  const codes: number[] = [];
  const exit = ((code: number) => {
    codes.push(code);
    return undefined as unknown as never;
  }) as (code: number) => never | void;
  return { codes, exit };
}

describe('kookr ralph parseRalphArgs', () => {
  it('parses status/pause/resume/cancel commands', () => {
    expect(parseRalphArgs(['status', 'task-1'])).toEqual({ help: false, command: 'status', taskId: 'task-1' });
    expect(parseRalphArgs(['pause', 'task-1'])).toEqual({ help: false, command: 'pause', taskId: 'task-1' });
    expect(parseRalphArgs(['resume', 'task-1'])).toEqual({ help: false, command: 'resume', taskId: 'task-1' });
    expect(parseRalphArgs(['cancel', 'task-1'])).toEqual({ help: false, command: 'cancel', taskId: 'task-1' });
  });

  it('parses help', () => {
    expect(parseRalphArgs([])).toEqual({ help: true });
    expect(parseRalphArgs(['--help'])).toEqual({ help: true });
  });

  it('rejects invalid shapes', () => {
    expect(() => parseRalphArgs(['frobnicate', 'task-1'])).toThrow(UsageError);
    expect(() => parseRalphArgs(['pause'])).toThrow(UsageError);
    expect(() => parseRalphArgs(['pause', 'task-1', 'extra'])).toThrow(UsageError);
  });
});

describe('kookr ralph API calls', () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (server) await closeServer(server);
    server = null;
  });

  it('reads Ralph status from GET /api/tasks', async () => {
    const api = await startFakeApi((req) => {
      if (req.method === 'GET' && req.url === '/api/tasks') {
        return {
          status: 200,
          body: JSON.stringify([
            {
              id: 'task-1',
              ralphLoop: {
                status: 'paused',
                currentIteration: 3,
                iterationCap: 10,
                cumulativeIterations: 8,
                stopPredicate: 'test -f DONE',
              },
            },
          ]),
        };
      }
      return { status: 404, body: '{}' };
    });
    server = api.server;

    const result = await requestRalphStatus({ baseUrl: api.baseUrl, taskId: 'task-1' });

    expect(result).toMatchObject({ kind: 'status', taskId: 'task-1' });
    expect(renderRalphStatus(result)).toContain('status=paused');
    expect(renderRalphStatus(result)).toContain('iteration=3/10');
  });

  it('calls the pause/resume/cancel endpoints with the expected HTTP methods', async () => {
    const seen: Array<{ method?: string; url?: string }> = [];
    const api = await startFakeApi((req) => {
      seen.push({ method: req.method, url: req.url });
      return { status: 200, body: JSON.stringify({ ok: true, status: 'paused' }) };
    });
    server = api.server;

    await requestRalphControl({ baseUrl: api.baseUrl, command: 'pause', taskId: 'task-1' });
    await requestRalphControl({ baseUrl: api.baseUrl, command: 'resume', taskId: 'task-1' });
    await requestRalphControl({ baseUrl: api.baseUrl, command: 'cancel', taskId: 'task-1' });

    expect(seen).toEqual([
      { method: 'POST', url: '/api/tasks/task-1/ralph-loop/pause' },
      { method: 'POST', url: '/api/tasks/task-1/ralph-loop/resume' },
      { method: 'DELETE', url: '/api/tasks/task-1/ralph-loop' },
    ]);
  });

  it('surfaces server errors from control endpoints', async () => {
    const api = await startFakeApi(() => ({
      status: 409,
      body: JSON.stringify({ error: 'conversation context is lost' }),
    }));
    server = api.server;

    const result = await requestRalphControl({ baseUrl: api.baseUrl, command: 'resume', taskId: 'task-1' });

    expect(result).toEqual({
      kind: 'server_error',
      status: 409,
      message: 'conversation context is lost',
    });
  });
});

describe('kookr ralph main', () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (server) await closeServer(server);
    server = null;
  });

  it('prints help and exits 0', async () => {
    const { io, logs } = makeConsoleCapture();
    const { codes, exit } = makeExitCapture();
    await main({ argv: ['--help'], env: {}, out: io, err: io, exit });
    expect(codes).toEqual([EXIT_OK]);
    expect(logs.join('\n')).toContain('kookr ralph status <taskId>');
  });

  it('exits 2 on invalid command shape', async () => {
    const out = makeConsoleCapture();
    const err = makeConsoleCapture();
    const { codes, exit } = makeExitCapture();
    await main({ argv: ['pause'], env: {}, out: out.io, err: err.io, exit });
    expect(codes).toEqual([EXIT_USER_ERROR]);
    expect(err.errors.join('\n')).toContain('requires <taskId>');
  });

  it('exits 2 on invalid KOOKR_PORT', async () => {
    const out = makeConsoleCapture();
    const err = makeConsoleCapture();
    const { codes, exit } = makeExitCapture();

    await main({ argv: ['status', 'task-1'], env: { KOOKR_PORT: 'abc' }, out: out.io, err: err.io, exit });

    expect(codes).toEqual([EXIT_USER_ERROR]);
    expect(err.errors.join('\n')).toMatch(/KOOKR_PORT/i);
  });

  it('exits 3 when auto-detect finds no reachable Kookr instance', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    try {
      const out = makeConsoleCapture();
      const err = makeConsoleCapture();
      const { codes, exit } = makeExitCapture();

      await main({ argv: ['status', 'task-1'], env: {}, out: out.io, err: err.io, exit });

      expect(codes).toEqual([EXIT_NO_SERVER]);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(err.errors.join('\n')).toContain('no Kookr server reachable');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('exits 3 when auto-detect finds both standard Kookr instances', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ serverStartedAt: '2026-06-07T00:00:00.000Z' }),
    } as Response);
    try {
      const out = makeConsoleCapture();
      const err = makeConsoleCapture();
      const { codes, exit } = makeExitCapture();

      await main({ argv: ['status', 'task-1'], env: {}, out: out.io, err: err.io, exit });

      expect(codes).toEqual([EXIT_NO_SERVER]);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(err.errors.join('\n')).toContain('multiple Kookr instances are running');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('prints status end-to-end against a fake server', async () => {
    const api = await startFakeApi((req) => {
      if (req.method === 'GET' && req.url === '/api/tasks') {
        return {
          status: 200,
          body: JSON.stringify([{ id: 'task-1', ralphLoop: { status: 'running', currentIteration: 1, iterationCap: 5, cumulativeIterations: 1 } }]),
        };
      }
      return { status: 404, body: '{}' };
    });
    server = api.server;
    const { io, logs } = makeConsoleCapture();
    const err = makeConsoleCapture();
    const { codes, exit } = makeExitCapture();

    await main({ argv: ['status', 'task-1'], env: { KOOKR_API_BASE_URL: api.baseUrl }, out: io, err: err.io, exit });

    expect(codes).toEqual([EXIT_OK]);
    expect(logs.join('\n')).toContain('status=running');
    expect(logs.join('\n')).toContain('iteration=1/5');
  });

  it('exits 4 when the task is not found', async () => {
    const api = await startFakeApi((req) => {
      if (req.method === 'GET' && req.url === '/api/tasks') return { status: 200, body: JSON.stringify([]) };
      return { status: 404, body: '{}' };
    });
    server = api.server;
    const out = makeConsoleCapture();
    const err = makeConsoleCapture();
    const { codes, exit } = makeExitCapture();

    await main({ argv: ['status', 'missing'], env: { KOOKR_API_BASE_URL: api.baseUrl }, out: out.io, err: err.io, exit });

    expect(codes).toEqual([EXIT_SERVER_ERROR]);
    expect(err.errors.join('\n')).toContain('Task not found: missing');
  });

  it('exits 4 when the server rejects a control request', async () => {
    const api = await startFakeApi(() => ({
      status: 409,
      body: JSON.stringify({ error: 'conversation context is lost' }),
    }));
    server = api.server;
    const out = makeConsoleCapture();
    const err = makeConsoleCapture();
    const { codes, exit } = makeExitCapture();

    await main({ argv: ['resume', 'task-1'], env: { KOOKR_API_BASE_URL: api.baseUrl }, out: out.io, err: err.io, exit });

    expect(codes).toEqual([EXIT_SERVER_ERROR]);
    expect(err.errors.join('\n')).toContain('conversation context is lost');
  });
});

type ApiResponse = { status: number; body: string; headers?: Record<string, string> };
type ApiHandler = (req: IncomingMessage, bodyText: string) => ApiResponse;

async function startFakeApi(handler: ApiHandler): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const result = handler(req, Buffer.concat(chunks).toString('utf-8'));
      res.writeHead(result.status, { 'Content-Type': 'application/json', ...(result.headers ?? {}) });
      res.end(result.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr !== 'object') throw new Error('no address');
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}
