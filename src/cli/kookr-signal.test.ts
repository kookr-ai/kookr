import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseArgs,
  resolveTaskId,
  main,
} from '../../bin/kookr-signal.js';
import { MAX_AGENT_SIGNAL_NOTE_LENGTH } from '../shared/contracts/agent-signal.js';
import * as signalOutbox from '../core/signal-outbox.js';
import { readPendingSignals } from '../core/signal-outbox.js';

const EXIT_OK = 0;
const EXIT_USER_ERROR = 2;
const EXIT_SERVER_ERROR = 4;

const spoolDirs: string[] = [];

afterEach(async () => {
  spoolDirs.length = 0;
  vi.unstubAllGlobals();
});

async function tempSpoolDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kookr-signal-cli-'));
  spoolDirs.push(dir);
  return dir;
}

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

/** Run main with a private spool dir + real outbox module (vitest loads TS). */
async function runSignal(
  opts: {
    argv: string[];
    env?: NodeJS.ProcessEnv;
    out?: { log: (m?: unknown) => void };
    err?: { error: (m?: unknown) => void };
    exit?: ReturnType<typeof vi.fn>;
  },
) {
  const spoolDir = await tempSpoolDir();
  const exit = opts.exit ?? vi.fn();
  await main({
    argv: opts.argv,
    env: opts.env ?? {},
    out: opts.out ?? { log: () => {} },
    err: opts.err ?? { error: () => {} },
    exit,
    outboxModule: signalOutbox,
    spoolDir,
  });
  return { exit, spoolDir };
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
    const { exit } = await runSignal({ argv: ['completion-ready'], env: {}, out, err });
    expect(exit).toHaveBeenCalledWith(EXIT_USER_ERROR);
  });

  it('emits a JSON envelope on user error when requested', async () => {
    const { out, err, logs, errs } = mkConsole();
    const { exit } = await runSignal({
      argv: ['completion-ready', '--json'],
      env: {},
      out,
      err,
    });
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
    const { exit } = await runSignal({
      argv: ['bogus'],
      env: { KOOKR_TASK_ID: 't-1' },
      err,
    });
    expect(exit).toHaveBeenCalledWith(EXIT_USER_ERROR);
  });

  it('prints help and exits 0', async () => {
    const { out, logs } = mkConsole();
    const exit = vi.fn();
    await main({ argv: ['--help'], env: {}, out, err: { error: () => {} }, exit });
    expect(exit).toHaveBeenCalledWith(EXIT_OK);
    expect(logs.join('\n')).toContain('kookr signal');
    expect(logs.join('\n')).toContain('durably spooled');
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
    const { exit } = await runSignal({
      argv: ['completion-ready'],
      env: { KOOKR_TASK_ID: 't-1', KOOKR_PORT: 'nope' },
    });
    expect(exit).toHaveBeenCalledWith(EXIT_USER_ERROR);
  });

  it('exits 0 and POSTs the signal with a signalId on success', async () => {
    const { out } = mkConsole();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { exit, spoolDir } = await runSignal({
      argv: ['completion-ready', '--note', 'tests green'],
      env: { KOOKR_TASK_ID: 't-1', KOOKR_API_BASE_URL: 'http://127.0.0.1:4800' },
      out,
    });
    expect(exit).toHaveBeenCalledWith(EXIT_OK);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('http://127.0.0.1:4800/api/tasks/t-1/signal');
    const body = JSON.parse((init as RequestInit).body as string) as {
      kind: string;
      note: string;
      signalId: string;
    };
    expect(body).toMatchObject({ kind: 'completion_ready', note: 'tests green' });
    expect(typeof body.signalId).toBe('string');
    expect(body.signalId.length).toBeGreaterThan(8);
    // Successful delivery removes the entry from the outbox.
    expect(await readPendingSignals(spoolDir)).toHaveLength(0);
  });

  it('is idempotent: a repeated completion-ready signal still exits 0', async () => {
    const exit = vi.fn();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    for (let i = 0; i < 2; i++) {
      await runSignal({
        argv: ['completion-ready'],
        env: { KOOKR_TASK_ID: 't-1', KOOKR_API_BASE_URL: 'http://127.0.0.1:4800' },
        exit,
      });
    }
    expect(exit).toHaveBeenNthCalledWith(1, EXIT_OK);
    expect(exit).toHaveBeenNthCalledWith(2, EXIT_OK);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('emits a success JSON envelope with server truncation state and signalId', async () => {
    const { out, err, logs, errs } = mkConsole();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, truncated: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { exit } = await runSignal({
      argv: ['completion-ready', '--json'],
      env: { KOOKR_TASK_ID: 't-1', KOOKR_API_BASE_URL: 'http://127.0.0.1:4800' },
      out,
      err,
    });
    expect(exit).toHaveBeenCalledWith(EXIT_OK);
    expect(errs).toEqual([]);
    const envelope = JSON.parse(logs[0] ?? '{}') as {
      ok: boolean;
      code: string;
      message: string;
      details: { truncated: boolean; signalId: string };
    };
    expect(envelope).toMatchObject({
      ok: true,
      code: 'OK',
      message: 'Signal raised.',
      details: { truncated: true },
    });
    expect(typeof envelope.details.signalId).toBe('string');
  });

  it('does not truncate notes before POSTing and reports server truncation', async () => {
    const { out, logs } = mkConsole();
    const note = `${'progress '.repeat(Math.ceil(MAX_AGENT_SIGNAL_NOTE_LENGTH / 'progress '.length))}final ask preserved`;
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, truncated: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { exit } = await runSignal({
      argv: ['completion-ready', '--note', note],
      env: { KOOKR_TASK_ID: 't-1', KOOKR_API_BASE_URL: 'http://127.0.0.1:4800' },
      out,
    });
    expect(exit).toHaveBeenCalledWith(EXIT_OK);
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string) as { note: string };
    expect(body.note).toBe(note);
    expect(logs.join('\n')).toContain('Note was truncated by the server');
  });

  it('exits 4 when the server rejects the signal and drops the outbox entry', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'Task not found' }), { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    const { exit, spoolDir } = await runSignal({
      argv: ['completion-ready'],
      env: { KOOKR_TASK_ID: 'missing', KOOKR_API_BASE_URL: 'http://127.0.0.1:4800' },
    });
    expect(exit).toHaveBeenCalledWith(EXIT_SERVER_ERROR);
    expect(await readPendingSignals(spoolDir)).toHaveLength(0);
  });

  it('emits a JSON envelope when the server rejects the signal', async () => {
    const { out, err, logs, errs } = mkConsole();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'Task not found' }), { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    const { exit } = await runSignal({
      argv: ['completion-ready', '--json'],
      env: { KOOKR_TASK_ID: 'missing', KOOKR_API_BASE_URL: 'http://127.0.0.1:4800' },
      out,
      err,
    });
    expect(exit).toHaveBeenCalledWith(EXIT_SERVER_ERROR);
    expect(errs).toEqual([]);
    const envelope = JSON.parse(logs[0] ?? '{}') as {
      ok: boolean;
      code: string;
      message: string;
      details: { status: number; signalId: string };
    };
    expect(envelope).toMatchObject({
      ok: false,
      code: 'SERVER_ERROR',
      message: 'server rejected the signal (HTTP 404): Task not found',
      details: { status: 404 },
    });
    expect(typeof envelope.details.signalId).toBe('string');
  });

  it('exits 0 and keeps the outbox entry when the daemon is unreachable (issue #1541)', async () => {
    const { out, logs } = mkConsole();
    const fetchMock = vi.fn(async () => {
      throw new Error('connection refused');
    });
    vi.stubGlobal('fetch', fetchMock);
    const { exit, spoolDir } = await runSignal({
      argv: ['completion-ready'],
      env: { KOOKR_TASK_ID: 't-1', KOOKR_API_BASE_URL: 'http://127.0.0.1:4800' },
      out,
    });
    expect(exit).toHaveBeenCalledWith(EXIT_OK);
    expect(logs.join('\n')).toMatch(/spooled/i);
    const pending = await readPendingSignals(spoolDir);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      taskId: 't-1',
      kind: 'completion_ready',
    });
  });

  it('emits a SPOOLED JSON envelope (exit 0) when no server is reachable', async () => {
    const { out, err, logs, errs } = mkConsole();
    const fetchMock = vi.fn(async () => {
      throw new Error('connection refused');
    });
    vi.stubGlobal('fetch', fetchMock);
    const { exit, spoolDir } = await runSignal({
      argv: ['completion-ready', '--json'],
      env: { KOOKR_TASK_ID: 't-1', KOOKR_API_BASE_URL: 'http://127.0.0.1:4800' },
      out,
      err,
    });
    expect(exit).toHaveBeenCalledWith(EXIT_OK);
    expect(errs).toEqual([]);
    const envelope = JSON.parse(logs[0] ?? '{}') as {
      ok: boolean;
      code: string;
      message: string;
      details: { spooled: boolean; signalId: string };
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.code).toBe('SPOOLED');
    expect(envelope.details.spooled).toBe(true);
    expect(typeof envelope.details.signalId).toBe('string');
    expect(await readPendingSignals(spoolDir)).toHaveLength(1);
  });

  it('does NOT apply the outage verdict when multiple servers are reachable (ambiguous) (#2410)', async () => {
    const { out, err, logs, errs } = mkConsole();
    // Both candidate ports answer /api/health with a valid shape → resolveBaseUrl
    // returns `ambiguous` (reachable, can't pick) — NOT an outage.
    const fetchMock = vi.fn(async (url: string | URL) => {
      const href = typeof url === 'string' ? url : url.href;
      if (href.endsWith('/api/health')) {
        return new Response(JSON.stringify({ serverStartedAt: new Date().toISOString() }), { status: 200 });
      }
      throw new Error(`unexpected ${href}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const { exit } = await runSignal({
      argv: ['completion-ready', '--json'],
      env: { KOOKR_TASK_ID: 't-1' }, // no BASE_URL / PORT → auto-sweep → both up → ambiguous
      out,
      err,
    });
    expect(exit).toHaveBeenCalledWith(EXIT_OK);
    expect(errs).toEqual([]);
    const envelope = JSON.parse(logs[0] ?? '{}') as {
      code: string;
      message: string;
      details: Record<string, unknown>;
    };
    expect(envelope.code).toBe('SPOOLED');
    expect(envelope.message).toContain('multiple Kookr servers reachable');
    expect(envelope.message).not.toContain('unexpected outage');
    expect(envelope.details.restartIntent).toBeUndefined();
  });

  it('exits 0 and spools when resolveBaseUrl finds no server', async () => {
    const { out, logs } = mkConsole();
    // No KOOKR_API_BASE_URL and an unused high port → resolveBaseUrl returns none.
    const { exit, spoolDir } = await runSignal({
      argv: ['completion-ready'],
      env: { KOOKR_TASK_ID: 't-1', KOOKR_PORT: '1' },
      out,
    });
    // Port 1 may or may not be open; either way we must not exit non-zero for
    // a connectivity problem. If the port happens to accept, fetch may still
    // fail — both paths are exit 0 under the outbox contract.
    expect(exit).toHaveBeenCalledWith(EXIT_OK);
    // When no server answered, the entry stays spooled.
    const pending = await readPendingSignals(spoolDir);
    // Either delivered (unlikely on :1) or spooled — never lost without a 4xx.
    if (pending.length === 1) {
      expect(logs.join('\n') + pending[0]!.taskId).toContain('t-1');
    }
  });
});
