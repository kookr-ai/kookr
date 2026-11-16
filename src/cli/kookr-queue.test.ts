import { describe, expect, it, vi } from 'vitest';

import {
  EXIT_NO_SERVER,
  EXIT_OK,
  EXIT_SERVER_ERROR,
  EXIT_USER_ERROR,
  QUEUE_HELP_TEXT,
  formatQueueList,
  parseQueueArgs,
  runQueueCli,
} from './kookr-queue.js';

function io(fetchImpl: typeof fetch, env: NodeJS.ProcessEnv = { KOOKR_API_BASE_URL: 'http://kookr.test' }) {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    io: {
      env,
      out: { log: (msg: unknown) => logs.push(String(msg)) },
      err: { error: (msg: unknown) => errors.push(String(msg)) },
      fetchImpl,
      now: () => Date.parse('2026-11-16T12:00:00.000Z'),
    },
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const ENTRIES = [
  {
    id: 'aaaa1111',
    state: 'started',
    attempts: 0,
    enqueuedAt: '2026-11-16T11:00:00.000Z',
    taskId: 'task-1',
    request: { prompt: 'fix the flaky test', cwd: '/r' },
  },
  {
    id: 'bbbb2222',
    state: 'queued',
    attempts: 1,
    enqueuedAt: '2026-11-16T11:40:00.000Z',
    waitReason: 'host_load',
    request: { cwd: '/r', playbook: { path: 'implement-github-issue.md' } },
  },
];

describe('parseQueueArgs', () => {
  it('parses list and remove', () => {
    expect(parseQueueArgs(['list', '--json'])).toEqual({ subcommand: 'list', json: true, help: false });
    expect(parseQueueArgs(['remove', 'abc'])).toMatchObject({ subcommand: 'remove', id: 'abc' });
  });

  it('rejects a missing subcommand, a missing id and unknown options', () => {
    expect(parseQueueArgs([]).error).toContain('subcommand is required');
    expect(parseQueueArgs(['remove']).error).toContain('exactly one entry id');
    expect(parseQueueArgs(['list', '--all']).error).toContain('unknown option: --all');
    expect(parseQueueArgs(['pop']).error).toContain('unknown subcommand: pop');
  });
});

describe('formatQueueList', () => {
  it('shows state, attempts, age and the wait reason of each entry', () => {
    const text = formatQueueList(ENTRIES, Date.parse('2026-11-16T12:00:00.000Z'));
    expect(text).toContain('Ready queue: 1 queued, 2 listed.');
    expect(text).toMatch(/aaaa1111\s+started\s+attempts=0\s+age=1h00m\s+fix the flaky test\s+\[task task-1\]/);
    expect(text).toMatch(/bbbb2222\s+queued\s+attempts=1\s+age=20m\s+playbook implement-github-issue\.md\s+\[waiting: host load\]/);
  });

  it('says how to add an entry when the queue is empty', () => {
    expect(formatQueueList([], 0)).toContain('kookr spawn --queue');
  });
});

describe('runQueueCli', () => {
  it('prints help', async () => {
    const t = io(vi.fn());
    expect(await runQueueCli(['--help'], t.io)).toBe(EXIT_OK);
    expect(t.logs).toEqual([QUEUE_HELP_TEXT]);
  });

  it('list --json gives each entry state, attempts and wait reason', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { entries: ENTRIES, health: { queued: 1 } }));
    const t = io(fetchImpl as unknown as typeof fetch);
    expect(await runQueueCli(['list', '--json'], t.io)).toBe(EXIT_OK);
    expect(fetchImpl).toHaveBeenCalledWith('http://kookr.test/api/ready-queue', expect.objectContaining({ method: 'GET' }));
    const envelope = JSON.parse(t.logs[0]);
    expect(envelope.ok).toBe(true);
    expect(envelope.details.entries.map((e: { id: string; state: string; attempts: number; waitReason?: string }) => [e.id, e.state, e.attempts, e.waitReason]))
      .toEqual([['aaaa1111', 'started', 0, undefined], ['bbbb2222', 'queued', 1, 'host_load']]);
    expect(envelope.details.health).toEqual({ queued: 1 });
  });

  it('remove sends DELETE for the id (URL-encoded)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { ok: true, id: 'a/b' }));
    const t = io(fetchImpl as unknown as typeof fetch);
    expect(await runQueueCli(['remove', 'a/b'], t.io)).toBe(EXIT_OK);
    expect(fetchImpl).toHaveBeenCalledWith('http://kookr.test/api/ready-queue/a%2Fb', expect.objectContaining({ method: 'DELETE' }));
    expect(t.logs).toEqual(['Removed a/b from the ready queue.']);
  });

  it('reports an unknown entry and an entry being started as server errors', async () => {
    const notFound = io(vi.fn(async () => jsonResponse(404, { error: 'No ready-queue entry x', code: 'not_found' })) as unknown as typeof fetch);
    expect(await runQueueCli(['remove', 'x', '--json'], notFound.io)).toBe(EXIT_SERVER_ERROR);
    expect(JSON.parse(notFound.logs[0])).toMatchObject({ ok: false, code: 'NOT_FOUND' });

    const launching = io(vi.fn(async () => jsonResponse(409, { error: 'Entry x is being started right now', code: 'launching' })) as unknown as typeof fetch);
    expect(await runQueueCli(['remove', 'x'], launching.io)).toBe(EXIT_SERVER_ERROR);
    expect(launching.errors.join('\n')).toContain('being started right now');
  });

  it('tells the operator when the server predates the ready queue', async () => {
    const t = io(vi.fn(async () => new Response('Not Found', { status: 404 })) as unknown as typeof fetch);
    expect(await runQueueCli(['list'], t.io)).toBe(EXIT_SERVER_ERROR);
    expect(t.errors.join('\n')).toContain('has no ready queue');
  });

  it('exits NO_SERVER when the request throws, USER_ERROR on bad usage', async () => {
    const down = io(vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch);
    expect(await runQueueCli(['list'], down.io)).toBe(EXIT_NO_SERVER);
    const bad = io(vi.fn() as unknown as typeof fetch);
    expect(await runQueueCli(['remove'], bad.io)).toBe(EXIT_USER_ERROR);
  });
});
