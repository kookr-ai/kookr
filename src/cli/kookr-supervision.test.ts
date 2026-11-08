import { describe, expect, it } from 'vitest';
import { formatSupervision, parseSupervisionArgs, runSupervisionCli } from './kookr-supervision.js';

const NOW = new Date('2026-11-08T10:00:00.000Z');

function row(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    supervisionId: id,
    health: 'healthy',
    wakesEnabled: true,
    nextWake: { kind: 'heartbeat', at: '2026-11-08T10:45:00.000Z' },
    supervisor: { taskId: 'sv-task' },
    targets: [{ taskId: 'w-1', name: 'worker', status: 'inProgress' }],
    state: { deadlineAt: '2026-11-08T14:00:00.000Z', lastDeliveredAt: '2026-11-08T09:30:00.000Z' },
    ...over,
  };
}

function run(argv: string[], supervisions: unknown[], status = 200, endStatus = 200) {
  const logs: string[] = [];
  const errs: string[] = [];
  const urls: string[] = [];
  const posts: string[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    urls.push(String(url));
    if (init?.method === 'POST') {
      posts.push(String(url));
      return new Response(JSON.stringify({ ok: true }), { status: endStatus });
    }
    return new Response(JSON.stringify({ supervisions }), { status });
  }) as unknown as typeof fetch;
  return {
    logs, errs, urls, posts,
    promise: runSupervisionCli(argv, {
      env: { KOOKR_API_BASE_URL: 'http://127.0.0.1:4999' },
      out: { log: (...a: unknown[]) => logs.push(a.join(' ')) },
      err: { error: (...a: unknown[]) => errs.push(a.join(' ')) },
      fetchImpl,
      now: () => NOW,
    }),
  };
}

describe('parseSupervisionArgs', () => {
  it('parses subcommand, id and flags', () => {
    expect(parseSupervisionArgs(['status', 'sup-1', '--json'])).toEqual({ subcommand: 'status', id: 'sup-1', json: true, help: false });
    expect(parseSupervisionArgs(['status', '--bogus']).error).toMatch(/unknown option/);
    expect(parseSupervisionArgs(['status', 'a', 'b']).error).toMatch(/unexpected extra/);
  });
});

describe('kookr supervision status', () => {
  it('prints a human summary of every supervision', async () => {
    const r = run(['status'], [row('sup-aaa'), row('sup-bbb', { health: 'dead', supervisor: { taskId: null } })]);
    expect(await r.promise).toBe(0);
    expect(r.urls).toEqual(['http://127.0.0.1:4999/api/supervisions']);
    const text = r.logs.join('\n');
    expect(text).toContain('sup-aaa  healthy');
    expect(text).toContain('sup-bbb  dead');
    expect(text).toContain('next wake:  heartbeat 2026-11-08T10:45:00.000Z (in 45m)');
    expect(text).toContain('deadline:   2026-11-08T14:00:00.000Z (in 4h)');
  });

  it('says so when there are none', async () => {
    const r = run(['status'], []);
    expect(await r.promise).toBe(0);
    expect(r.logs.join('\n')).toContain('No supervisions');
  });

  it('selects one by id or unique prefix, as a JSON envelope with --json', async () => {
    const r = run(['status', 'sup-b', '--json'], [row('sup-aaa'), row('sup-bbb')]);
    expect(await r.promise).toBe(0);
    const env = JSON.parse(r.logs[0]);
    expect(env).toMatchObject({ ok: true, code: 'OK' });
    expect(env.details.supervision.supervisionId).toBe('sup-bbb');
  });

  it('lists all in the JSON envelope without an id', async () => {
    const r = run(['status', '--json'], [row('sup-aaa'), row('sup-bbb')]);
    expect(await r.promise).toBe(0);
    expect(JSON.parse(r.logs[0]).details.supervisions).toHaveLength(2);
  });

  it('exits 2 for an unknown id and 5 for an ambiguous prefix', async () => {
    const unknown = run(['status', 'zzz'], [row('sup-aaa')]);
    expect(await unknown.promise).toBe(2);
    expect(unknown.errs.join('')).toContain("no supervision matches 'zzz'");
    const ambiguous = run(['status', 'sup-'], [row('sup-aaa'), row('sup-bbb')]);
    expect(await ambiguous.promise).toBe(5);
  });

  it('exits 4 on a server error and 2 without the status subcommand', async () => {
    expect(await run(['status'], [], 500).promise).toBe(4);
    expect(await run([], []).promise).toBe(2);
    expect(await run(['frobnicate'], []).promise).toBe(2);
  });

  it('shows the kill-switch banner and ended reason', () => {
    const lines = formatSupervision(row('sup-1', { wakesEnabled: false, health: 'ended', state: { deadlineAt: '2026-11-08T08:00:00.000Z', endedReason: 'deadline' } }) as never, NOW);
    expect(lines[0]).toBe('sup-1  ended (deadline)');
    expect(lines.join('\n')).toContain('wakes DISABLED by KOOKR_SUPERVISION_WAKE_DISABLED');
    expect(lines.join('\n')).toContain('(2h ago)');
  });
});

describe('kookr supervision end', () => {
  it('POSTs the end route for the resolved id and says no task was cancelled', async () => {
    const r = run(['end', 'sup-b'], [row('sup-aaa'), row('sup-bbb')]);
    expect(await r.promise).toBe(0);
    expect(r.posts).toEqual(['http://127.0.0.1:4999/api/supervisions/sup-bbb/end']);
    expect(r.logs.join('\n')).toContain('No task was cancelled');
  });

  it('emits a JSON envelope with --json', async () => {
    const r = run(['end', 'sup-aaa', '--json'], [row('sup-aaa')]);
    expect(await r.promise).toBe(0);
    expect(JSON.parse(r.logs[0])).toMatchObject({ ok: true, code: 'OK', details: { supervisionId: 'sup-aaa' } });
  });

  it('needs an id (2), unknown id is 2 without POSTing, ambiguous is 5, server error is 4', async () => {
    expect(await run(['end'], []).promise).toBe(2);
    const unknown = run(['end', 'zzz'], [row('sup-aaa')]);
    expect(await unknown.promise).toBe(2);
    expect(unknown.posts).toEqual([]);
    expect(await run(['end', 'sup-'], [row('sup-aaa'), row('sup-bbb')]).promise).toBe(5);
    expect(await run(['end', 'sup-aaa'], [row('sup-aaa')], 200, 500).promise).toBe(4);
  });
});
