import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { runReflectCli } from './kookr-reflect.js';
import type { IssueProbe, RawIssueState } from '../core/reflection-ideas.js';

function captureIo() {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    out: { log: (...a: unknown[]) => logs.push(a.map(String).join(' ')) },
    err: { error: (...a: unknown[]) => errors.push(a.map(String).join(' ')) },
  };
}

const NOW = () => new Date('2026-08-01T00:00:00.000Z');

const OPEN: RawIssueState = { state: 'OPEN', stateReason: null, closingPrs: [] };
const SHIPPED = (pr: number): RawIssueState => ({
  state: 'CLOSED',
  stateReason: 'COMPLETED',
  closingPrs: [{ number: pr, url: `https://github.com/o/r/pull/${pr}`, merged: true }],
});

describe('kookr reflect (dispatch)', () => {
  test('no args prints usage', async () => {
    const io = captureIo();
    const code = await runReflectCli([], { ...io, env: {} });
    expect(code).toBe(0);
    expect(io.logs.join('\n')).toContain('kookr reflect');
  });

  test('unknown verb errors', async () => {
    const io = captureIo();
    const code = await runReflectCli(['bogus'], { ...io, env: {} });
    expect(code).toBe(2);
    expect(io.errors.join('\n')).toContain('Unknown verb');
  });
});

describe('kookr reflect ideas', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'reflect-ideas-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const probe: IssueProbe = async (ref) => (ref.number === 1705 ? SHIPPED(1710) : OPEN);

  test('resolves ideasFiled and emits JSON', async () => {
    const log = join(dir, 'log.jsonl');
    await writeFile(
      log,
      [
        '{"date":"2026-07-30","ideasFiled":["https://github.com/kookr-ai/kookr/issues/1705"]}',
        '{"date":"2026-07-31","ideasFiled":["https://github.com/kookr-ai/kookr/issues/1751"]}',
      ].join('\n'),
    );
    const io = captureIo();
    const code = await runReflectCli(['ideas', '--json', '--log', log], {
      ...io,
      env: {},
      probe,
      now: NOW,
    });
    expect(code).toBe(0);
    const payload = JSON.parse(io.logs[0]!);
    expect(payload.ok).toBe(true);
    expect(payload.ideas).toHaveLength(1); // default runs=1 → latest entry only
    expect(payload.ideas[0]).toMatchObject({ number: 1751, state: 'open' });
  });

  test('--runs widens the window and resolves shipped state', async () => {
    const log = join(dir, 'log.jsonl');
    await writeFile(
      log,
      [
        '{"date":"2026-07-30","ideasFiled":["https://github.com/kookr-ai/kookr/issues/1705"]}',
        '{"date":"2026-07-31","ideasFiled":["https://github.com/kookr-ai/kookr/issues/1751"]}',
      ].join('\n'),
    );
    const io = captureIo();
    const code = await runReflectCli(['ideas', '--json', '--log', log, '--runs', '2'], {
      ...io,
      env: {},
      probe,
      now: NOW,
    });
    expect(code).toBe(0);
    const payload = JSON.parse(io.logs[0]!);
    expect(payload.ideas).toHaveLength(2);
    const shipped = payload.ideas.find((i: { number: number }) => i.number === 1705);
    expect(shipped).toMatchObject({ state: 'shipped', shippedByPr: 1710 });
  });

  test('renders a human table by default', async () => {
    const log = join(dir, 'log.jsonl');
    await writeFile(log, '{"date":"2026-07-31","ideasFiled":["https://github.com/kookr-ai/kookr/issues/1751"]}');
    const io = captureIo();
    const code = await runReflectCli(['ideas', '--log', log], { ...io, env: {}, probe, now: NOW });
    expect(code).toBe(0);
    expect(io.logs.join('\n')).toContain('kookr#1751');
    expect(io.logs.join('\n')).toContain('filed→shipped');
  });

  test('missing log is treated as a first run, not an error', async () => {
    const io = captureIo();
    const code = await runReflectCli(['ideas', '--json', '--log', join(dir, 'nope.jsonl')], {
      ...io,
      env: {},
      probe,
      now: NOW,
    });
    expect(code).toBe(0);
    const payload = JSON.parse(io.logs[0]!);
    expect(payload.ok).toBe(true);
    expect(payload.ideas).toEqual([]);
  });

  test('rejects invalid --runs', async () => {
    const io = captureIo();
    const code = await runReflectCli(['ideas', '--runs', '0'], { ...io, env: {}, probe });
    expect(code).toBe(2);
    expect(io.errors.join('\n')).toContain('--runs');
  });

  test('rejects an empty --log= value symmetrically with the space form', async () => {
    const io = captureIo();
    const code = await runReflectCli(['ideas', '--log='], { ...io, env: {}, probe });
    expect(code).toBe(2);
    expect(io.errors.join('\n')).toContain('--log requires a path');
  });

  test('rejects an unknown arg', async () => {
    const io = captureIo();
    const code = await runReflectCli(['ideas', '--bogus'], { ...io, env: {}, probe });
    expect(code).toBe(2);
    expect(io.errors.join('\n')).toContain('Unknown arg');
  });
});

describe('kookr reflect outcomes', () => {
  const ledger = {
    schemaVersion: 'outcome-ledger.v1',
    readiness: 'ready',
    window: { value: '24h' },
    summary: {
      taskCount: 118,
      terminalTaskCount: 110,
      completedTaskCount: 99,
      terminatedTaskCount: 8,
      cancelledTaskCount: 3,
      activeTaskCount: 8,
      completionRate: 0.9,
      prTaskCount: 41,
      verifiedTaskCount: 60,
      thumbsUp: 20,
      thumbsDown: 2,
      totalKnownCostUsd: 12.34,
    },
  };

  function fetchStub(healthyPort: number): typeof fetch {
    return (async (url: string | URL) => {
      const u = String(url);
      if (u.includes('/api/health')) {
        return new Response('{}', { status: u.includes(`:${healthyPort}`) ? 200 : 500 });
      }
      if (u.includes('/api/outcome-ledger')) {
        return new Response(JSON.stringify(ledger), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;
  }

  test('projects the ledger summary into a compact JSON tally', async () => {
    const io = captureIo();
    const code = await runReflectCli(['outcomes', '--json'], {
      ...io,
      env: { KOOKR_API_BASE_URL: 'http://127.0.0.1:4800' },
      fetchImpl: fetchStub(4800),
      now: NOW,
    });
    expect(code).toBe(0);
    const payload = JSON.parse(io.logs[0]!);
    expect(payload.ok).toBe(true);
    expect(payload.source).toBe('outcome-ledger.v1');
    expect(payload.tally).toMatchObject({
      ran: 118,
      completed: 99,
      terminated: 8,
      cancelled: 3,
      active: 8,
      tasksWithPr: 41,
    });
  });

  test('renders a human tally with the terminated=failed hint', async () => {
    const io = captureIo();
    const code = await runReflectCli(['outcomes'], {
      ...io,
      env: { KOOKR_PORT: '4800' },
      fetchImpl: fetchStub(4800),
      now: NOW,
    });
    expect(code).toBe(0);
    const text = io.logs.join('\n');
    expect(text).toContain('ran         118');
    expect(text).toContain('terminated  8   (failed)');
    expect(text).toContain('readiness ready');
  });

  test('auto-probes ports when no base is configured', async () => {
    const io = captureIo();
    const code = await runReflectCli(['outcomes', '--json'], {
      ...io,
      env: {},
      fetchImpl: fetchStub(4801),
      now: NOW,
    });
    expect(code).toBe(0);
    expect(JSON.parse(io.logs[0]!).ok).toBe(true);
  });

  test('reports fetch-error when the ledger endpoint fails', async () => {
    const io = captureIo();
    const brokenLedger = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes('/api/health')) return new Response('{}', { status: 200 });
      return new Response('boom', { status: 500 }); // outcome-ledger fails
    }) as unknown as typeof fetch;
    const code = await runReflectCli(['outcomes', '--json'], {
      ...io,
      env: { KOOKR_API_BASE_URL: 'http://127.0.0.1:4800' },
      fetchImpl: brokenLedger,
      now: NOW,
    });
    expect(code).toBe(1);
    expect(JSON.parse(io.logs[0]!)).toMatchObject({ ok: false, code: 'fetch-error' });
  });

  test('projects a partial/malformed ledger defensively', async () => {
    const io = captureIo();
    const partial = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes('/api/health')) return new Response('{}', { status: 200 });
      return new Response(JSON.stringify({ summary: { taskCount: 5 } }), { status: 200 });
    }) as unknown as typeof fetch;
    const code = await runReflectCli(['outcomes', '--json'], {
      ...io,
      env: { KOOKR_API_BASE_URL: 'http://127.0.0.1:4800' },
      fetchImpl: partial,
      now: NOW,
    });
    expect(code).toBe(0);
    const payload = JSON.parse(io.logs[0]!);
    expect(payload.tally).toMatchObject({ ran: 5, completed: 0, completionRate: null });
  });

  test('reports no-server when nothing responds', async () => {
    const io = captureIo();
    const dead = (async () => new Response('x', { status: 500 })) as unknown as typeof fetch;
    const code = await runReflectCli(['outcomes', '--json'], {
      ...io,
      env: {},
      fetchImpl: dead,
      now: NOW,
    });
    expect(code).toBe(1);
    expect(JSON.parse(io.logs[0]!)).toMatchObject({ ok: false, code: 'no-server' });
  });

  test('rejects an invalid --window', async () => {
    const io = captureIo();
    const code = await runReflectCli(['outcomes', '--window', 'yearly'], { ...io, env: {} });
    expect(code).toBe(2);
    expect(io.errors.join('\n')).toContain('--window');
  });
});
