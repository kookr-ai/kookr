import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { SUPERVISOR_ACTOR_HEADER } from '../shared/contracts/supervisor-actions.js';
import { defaultReadStdin, HELP_TEXT, parseReplyArgs, runReplyCli } from './kookr-reply.js';

/** A pipe-like stream: async-iterable with `isTTY` left undefined, as Node does. */
function pipedStdin(value: string): Readable & { isTTY?: boolean } {
  return Readable.from([value]) as Readable & { isTTY?: boolean };
}
/** A TTY-like stream: `isTTY === true`. */
function ttyStdin(): Readable & { isTTY?: boolean } {
  const s = Readable.from([]) as Readable & { isTTY?: boolean };
  s.isTTY = true;
  return s;
}

function captureIo() {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    out: { log: (m: unknown) => logs.push(String(m)) },
    err: { error: (m: unknown) => errors.push(String(m)) },
  };
}

interface FakeRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

/**
 * A fetch double serving `/api/health` (for port auto-detect), `/api/snapshot`
 * (returning `agents`), and `/api/agents/:id/message` (returning `messageResult`
 * or `messageStatus` for non-2xx). Records every request in `requests`.
 */
function fakeFetch({
  port = 4800,
  agents = [] as Array<{ agentId: string; taskId?: string; taskName?: string; taskStatus?: string }>,
  messageStatus = 200,
  messageResult = { ok: true, agentId: '', delivered: true } as unknown,
} = {}) {
  const requests: FakeRequest[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body !== undefined ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url, method, headers, body });

    const portMatch = url.match(/127\.0\.0\.1:(\d+)/);
    const reqPort = portMatch ? Number(portMatch[1]) : NaN;

    if (url.includes('/api/health')) {
      if (reqPort === port) return { ok: true } as Response;
      throw new Error('ECONNREFUSED');
    }
    if (url.includes('/api/snapshot')) {
      return { ok: true, json: async () => agents } as unknown as Response;
    }
    if (url.includes('/message')) {
      const bodyText = JSON.stringify(messageResult);
      return { ok: messageStatus >= 200 && messageStatus < 300, status: messageStatus, text: async () => bodyText } as unknown as Response;
    }
    throw new Error(`unexpected url: ${url}`);
  }) as unknown as typeof fetch;
  return { impl, requests };
}

function stdinSeam(value: string | undefined) {
  return async () => value;
}

describe('parseReplyArgs', () => {
  it('reads taskRef, text, --json, and --help in any order', () => {
    expect(parseReplyArgs(['t1', 'hello there', '--json'])).toEqual({
      json: true,
      help: false,
      taskRef: 't1',
      text: 'hello there',
    });
    expect(parseReplyArgs(['--help', 't1'])).toMatchObject({ help: true, taskRef: 't1' });
  });

  it('flags an unknown option', () => {
    expect(parseReplyArgs(['--bogus']).error).toContain('unknown option');
  });

  it('flags an unexpected extra positional', () => {
    expect(parseReplyArgs(['t1', 'text', 'extra']).error).toContain('unexpected extra argument');
  });
});

describe('runReplyCli — arg parsing', () => {
  it('prints help and exits 0', async () => {
    const io = captureIo();
    const code = await runReplyCli(['--help'], { env: {}, out: io.out, err: io.err });
    expect(code).toBe(0);
    expect(io.logs).toEqual([HELP_TEXT]);
  });

  it('rejects an unknown option with exit 2', async () => {
    const io = captureIo();
    const code = await runReplyCli(['--bogus', '--json'], { env: {}, out: io.out, err: io.err });
    expect(code).toBe(2);
    expect(JSON.parse(io.logs[0])).toMatchObject({ ok: false, code: 'USER_ERROR' });
  });

  it('requires a taskId|name', async () => {
    const io = captureIo();
    const code = await runReplyCli(['--json'], { env: {}, out: io.out, err: io.err, readStdin: stdinSeam(undefined) });
    expect(code).toBe(2);
    expect(JSON.parse(io.logs[0])).toMatchObject({ ok: false, code: 'USER_ERROR' });
  });

  it('reads reply text from piped stdin when no positional text is given', async () => {
    const io = captureIo();
    const { impl, requests } = fakeFetch({
      agents: [{ agentId: 'agent-1', taskId: 't1', taskName: 'Task One', taskStatus: 'inProgress' }],
      messageResult: { ok: true, agentId: 'agent-1', delivered: true },
    });
    const code = await runReplyCli(['t1'], {
      env: {},
      out: io.out,
      err: io.err,
      fetchImpl: impl,
      readStdin: stdinSeam('piped reply text\n'),
    });
    expect(code).toBe(0);
    const messageReq = requests.find((r) => r.url.includes('/message'));
    expect(messageReq?.body).toEqual({ input: 'piped reply text' });
  });

  it('errors USER_ERROR when text is missing and stdin is not piped (TTY)', async () => {
    const io = captureIo();
    const code = await runReplyCli(['t1', '--json'], {
      env: {},
      out: io.out,
      err: io.err,
      readStdin: stdinSeam(undefined),
    });
    expect(code).toBe(2);
    expect(JSON.parse(io.logs[0])).toMatchObject({ ok: false, code: 'USER_ERROR' });
  });

  it('errors USER_ERROR when piped stdin is empty', async () => {
    const io = captureIo();
    const code = await runReplyCli(['t1', '--json'], {
      env: {},
      out: io.out,
      err: io.err,
      readStdin: stdinSeam('   \n'),
    });
    expect(code).toBe(2);
    expect(JSON.parse(io.logs[0])).toMatchObject({ ok: false, code: 'USER_ERROR' });
  });
});

describe('runReplyCli — resolution and delivery', () => {
  it('delivers to the single agent matched by taskId, with the CLI actor header, and exits 0', async () => {
    const io = captureIo();
    const { impl, requests } = fakeFetch({
      agents: [{ agentId: 'agent-1', taskId: 't1', taskName: 'Task One', taskStatus: 'inProgress' }],
      messageResult: { ok: true, agentId: 'agent-1', delivered: true },
    });
    const code = await runReplyCli(['t1', 'hello agent'], { env: {}, out: io.out, err: io.err, fetchImpl: impl });
    expect(code).toBe(0);
    const messageReq = requests.find((r) => r.url.includes('/message'));
    expect(messageReq).toBeDefined();
    expect(messageReq?.url).toBe('http://127.0.0.1:4800/api/agents/agent-1/message');
    expect(messageReq?.method).toBe('POST');
    expect(messageReq?.body).toEqual({ input: 'hello agent' });
    expect(messageReq?.headers[SUPERVISOR_ACTOR_HEADER]).toBe('cli');
    expect(io.logs.join('\n')).toContain('Delivered reply to agent agent-1');
  });

  it('delivers to the single agent matched by exact taskName', async () => {
    const io = captureIo();
    const { impl, requests } = fakeFetch({
      agents: [{ agentId: 'agent-2', taskId: 't2', taskName: 'My Task', taskStatus: 'open' }],
      messageResult: { ok: true, agentId: 'agent-2', delivered: true },
    });
    const code = await runReplyCli(['My Task', 'hi'], { env: {}, out: io.out, err: io.err, fetchImpl: impl });
    expect(code).toBe(0);
    const messageReq = requests.find((r) => r.url.includes('/message'));
    expect(messageReq?.url).toBe('http://127.0.0.1:4800/api/agents/agent-2/message');
  });

  it('emits a structured --json success envelope', async () => {
    const io = captureIo();
    const { impl } = fakeFetch({
      agents: [{ agentId: 'agent-1', taskId: 't1', taskName: 'Task One', taskStatus: 'inProgress' }],
      messageResult: { ok: true, agentId: 'agent-1', delivered: true },
    });
    const code = await runReplyCli(['t1', 'hi', '--json'], { env: {}, out: io.out, err: io.err, fetchImpl: impl });
    expect(code).toBe(0);
    expect(JSON.parse(io.logs[0])).toEqual({
      ok: true,
      code: 'OK',
      message: 'Delivered reply to agent agent-1 (task t1).',
      details: { taskId: 't1', agentId: 'agent-1', delivered: true },
    });
  });

  it('fails with NO_AGENT (exit 2) when no live agent matches, and issues no POST', async () => {
    const io = captureIo();
    const { impl, requests } = fakeFetch({ agents: [] });
    const code = await runReplyCli(['unknown-task', 'hi'], { env: {}, out: io.out, err: io.err, fetchImpl: impl });
    expect(code).toBe(2);
    expect(io.errors.join('\n')).toContain('no live agent found');
    expect(requests.some((r) => r.url.includes('/message'))).toBe(false);
  });

  it('excludes agents whose taskStatus is terminal', async () => {
    const io = captureIo();
    const { impl, requests } = fakeFetch({
      agents: [{ agentId: 'agent-1', taskId: 't1', taskName: 'Task One', taskStatus: 'completed' }],
    });
    const code = await runReplyCli(['t1', 'hi', '--json'], { env: {}, out: io.out, err: io.err, fetchImpl: impl });
    expect(code).toBe(2);
    expect(JSON.parse(io.logs[0])).toMatchObject({ ok: false, code: 'NO_AGENT' });
    expect(requests.some((r) => r.url.includes('/message'))).toBe(false);
  });

  it('fails with AMBIGUOUS_AGENT (exit 5) when multiple live agents match, listing candidates, and issues no POST', async () => {
    const io = captureIo();
    const { impl, requests } = fakeFetch({
      agents: [
        { agentId: 'agent-1', taskId: 't1', taskName: 'dup', taskStatus: 'inProgress' },
        { agentId: 'agent-2', taskId: 't1', taskName: 'dup', taskStatus: 'open' },
      ],
    });
    const code = await runReplyCli(['t1', 'hi', '--json'], { env: {}, out: io.out, err: io.err, fetchImpl: impl });
    expect(code).toBe(5);
    const parsed = JSON.parse(io.logs[0]);
    expect(parsed).toMatchObject({ ok: false, code: 'AMBIGUOUS_AGENT' });
    expect(parsed.details.candidates).toEqual([
      { agentId: 'agent-1', taskName: 'dup', taskStatus: 'inProgress' },
      { agentId: 'agent-2', taskName: 'dup', taskStatus: 'open' },
    ]);
    expect(requests.some((r) => r.url.includes('/message'))).toBe(false);
  });

  it('fails with NO_SERVER (exit 3) when nothing is running', async () => {
    const io = captureIo();
    const { impl } = fakeFetch({ port: -1 });
    const code = await runReplyCli(['t1', 'hi'], { env: {}, out: io.out, err: io.err, fetchImpl: impl });
    expect(code).toBe(3);
    expect(io.errors.join('\n')).toContain('no Kookr server reachable');
  });

  it('fails with AMBIGUOUS_PORT (exit 5) when two instances are live', async () => {
    const io = captureIo();
    const impl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/api/health')) return { ok: true } as Response;
      throw new Error(`unexpected url: ${url}`);
    }) as unknown as typeof fetch;
    const code = await runReplyCli(['t1', 'hi'], { env: {}, out: io.out, err: io.err, fetchImpl: impl });
    expect(code).toBe(5);
    expect(io.errors.join('\n')).toContain('two Kookr instances');
  });

  it('fails with SERVER_ERROR (exit 4) when delivery returns a non-2xx response', async () => {
    const io = captureIo();
    const { impl, requests } = fakeFetch({
      agents: [{ agentId: 'agent-1', taskId: 't1', taskName: 'Task One', taskStatus: 'inProgress' }],
      messageStatus: 500,
      messageResult: { error: 'boom' },
    });
    const code = await runReplyCli(['t1', 'hi', '--json'], { env: {}, out: io.out, err: io.err, fetchImpl: impl });
    expect(code).toBe(4);
    expect(JSON.parse(io.logs[0])).toMatchObject({ ok: false, code: 'SERVER_ERROR', message: 'boom' });
    expect(requests.some((r) => r.url.includes('/message'))).toBe(true);
  });

  it('fails with SERVER_ERROR (exit 4) when delivery returns 404 agent-not-found', async () => {
    const io = captureIo();
    const { impl } = fakeFetch({
      agents: [{ agentId: 'agent-1', taskId: 't1', taskName: 'Task One', taskStatus: 'inProgress' }],
      messageStatus: 404,
      messageResult: { error: 'Agent not found: agent-1' },
    });
    const code = await runReplyCli(['t1', 'hi', '--json'], { env: {}, out: io.out, err: io.err, fetchImpl: impl });
    expect(code).toBe(4);
    expect(JSON.parse(io.logs[0])).toMatchObject({ ok: false, code: 'SERVER_ERROR', message: 'Agent not found: agent-1' });
  });
});

describe('defaultReadStdin (real read path, not the injected seam)', () => {
  // Regression guard (#3103 review): a `stdin.isTTY !== false` guard silently
  // never read piped input, because Node leaves `isTTY` undefined on a pipe.
  it('reads all bytes from a piped (non-TTY) stdin', async () => {
    const text = await defaultReadStdin(pipedStdin('hello from a pipe\n'));
    expect(text).toBe('hello from a pipe\n');
  });

  it('returns undefined for an interactive TTY stdin (does not block on read)', async () => {
    const text = await defaultReadStdin(ttyStdin());
    expect(text).toBeUndefined();
  });
});
