import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { SupervisionFs } from '../core/supervision/supervision-files.js';
import { parsePlaybook } from '../core/playbook-parser.js';
import { SUPERVISOR_PLAYBOOK_PATH, parseSuperviseArgs, parseUntil, renderBrief, resolveTaskRef, runSuperviseCli, type CompactTask } from './kookr-supervise.js';

const NOW = new Date(2026, 10, 8, 16, 0, 0); // local time

const TASKS: CompactTask[] = [
  { taskId: 'aaaaaaaa-1111', name: 'alpha-worker', status: 'inProgress' },
  { taskId: 'bbbbbbbb-2222', name: 'beta-worker', status: 'pending' },
  { taskId: 'bbbbbbbb-3333', name: 'beta-twin', status: 'inProgress' },
  { taskId: 'cccccccc-4444', name: 'old-done', status: 'completed' },
  { taskId: 'dddddddd-5555', name: 'dup', status: 'completed' },
  { taskId: 'dddddddd-6666', name: 'dup', status: 'inProgress' },
];

interface Req {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: any;
}

function fakeFetch(
  opts: {
    tasks?: CompactTask[];
    launchStatus?: number;
    /** Per-attempt launch outcomes ('throw' = network error, else HTTP status); the last repeats. */
    launchSeq?: Array<number | 'throw'>;
    relationStatus?: number;
    /** Per-POST relation outcomes in order ('throw' = network error); falls back to relationStatus. */
    relationSeq?: Array<number | 'throw'>;
    existingRelations?: Array<Record<string, unknown>>;
  } = {},
) {
  let launchCalls = 0;
  let relationCalls = 0;
  const requests: Req[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body !== undefined ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url, method, headers: (init?.headers ?? {}) as Record<string, string>, body });
    const json = (status: number, data: unknown) => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => data,
      text: async () => JSON.stringify(data),
    }) as unknown as Response;
    if (url.endsWith('/api/health')) return json(url.includes(':4800') ? 200 : 503, {});
    if (url.includes('/api/tasks?view=compact')) return json(200, (opts.tasks ?? TASKS).map((t) => ({ id: t.taskId, ...t })));
    if (url.endsWith('/api/snapshot')) {
      return json(200, [{ agentId: 'ag1', taskId: 'aaaaaaaa-1111', turnState: 'running', sessionHealth: { classification: 'healthy-working' } }]);
    }
    if (url.endsWith('/api/tasks') && method === 'POST') {
      const seq = opts.launchSeq ?? [opts.launchStatus ?? 201];
      const step = seq[Math.min(launchCalls++, seq.length - 1)];
      if (step === 'throw') throw new Error('timeout');
      return json(step, step < 300 ? { id: 'sup-task-1' } : { error: 'boom' });
    }
    if (url.includes('/api/task-relations?') && method === 'GET') {
      const target = new URL(url).searchParams.get('targetTaskId');
      return json(200, { relations: (opts.existingRelations ?? []).filter((r) => r.targetTaskId === target) });
    }
    if (url.endsWith('/api/task-relations')) {
      const step = opts.relationSeq ? opts.relationSeq[relationCalls++] : (opts.relationStatus ?? 201);
      if (step === 'throw') throw new Error('socket hang up');
      return json(step ?? 201, {});
    }
    return json(404, {});
  }) as typeof fetch;
  return { impl, requests };
}

function setup(argv: string[], fopts: Parameters<typeof fakeFetch>[0] = {}, env: NodeJS.ProcessEnv = {}, fs?: SupervisionFs) {
  const sleeps: number[] = [];
  const logs: string[] = [];
  const errors: string[] = [];
  const { impl, requests } = fakeFetch(fopts);
  const dataDir = mkdtempSync(join(tmpdir(), 'sup-cli-'));
  const run = () =>
    runSuperviseCli(argv, {
      env,
      out: { log: (m: unknown) => logs.push(String(m)) },
      err: { error: (m: unknown) => errors.push(String(m)) },
      fetchImpl: impl,
      now: () => NOW,
      cwd: () => '/work/dir',
      newId: () => 'sup-test',
      dataDir,
      fs,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
  return { run, logs, errors, requests, dataDir, sleeps };
}

describe('resolveTaskRef', () => {
  it('resolves exact id, unique prefix (>= 8), and exact name', () => {
    expect(resolveTaskRef('aaaaaaaa-1111', TASKS)).toMatchObject({ ok: true, task: { taskId: 'aaaaaaaa-1111' } });
    expect(resolveTaskRef('aaaaaaaa', TASKS)).toMatchObject({ ok: true, task: { taskId: 'aaaaaaaa-1111' } });
    expect(resolveTaskRef('beta-worker', TASKS)).toMatchObject({ ok: true, task: { taskId: 'bbbbbbbb-2222' } });
  });
  it('prefers the live task among same-named tasks', () => {
    expect(resolveTaskRef('dup', TASKS)).toMatchObject({ ok: true, task: { taskId: 'dddddddd-6666' } });
  });
  it('reports unknown refs, and short prefixes with a hint', () => {
    expect(resolveTaskRef('nope', TASKS)).toMatchObject({ ok: false, code: 'UNKNOWN_TASK' });
    const short = resolveTaskRef('aaaa', TASKS);
    expect(short).toMatchObject({ ok: false, code: 'UNKNOWN_TASK' });
    expect(!short.ok && short.message).toContain('at least 8');
  });
  it('names candidates for an ambiguous prefix', () => {
    const r = resolveTaskRef('bbbbbbbb', TASKS);
    expect(r).toMatchObject({ ok: false, code: 'AMBIGUOUS_TASK' });
    expect(!r.ok && r.message).toContain('bbbbbbbb-2222');
    expect(!r.ok && r.message).toContain('bbbbbbbb-3333');
  });
  it('rejects a terminal task', () => {
    expect(resolveTaskRef('cccccccc-4444', TASKS)).toMatchObject({ ok: false, code: 'TERMINAL_TASK' });
  });
});

describe('parseUntil', () => {
  it('parses +Nh relative to now', () => {
    const d = parseUntil('+4h', NOW) as Date;
    expect(d.getTime() - NOW.getTime()).toBe(4 * 3_600_000);
  });
  it('parses HH:MM today when still ahead, and rolls to tomorrow when passed', () => {
    const later = parseUntil('18:30', NOW) as Date;
    expect([later.getDate(), later.getHours(), later.getMinutes()]).toEqual([8, 18, 30]);
    const rolled = parseUntil('09:15', NOW) as Date;
    expect([rolled.getDate(), rolled.getHours(), rolled.getMinutes()]).toEqual([9, 9, 15]);
    const same = parseUntil('16:00', NOW) as Date;
    expect(same.getDate()).toBe(9);
  });
  it.each(['4h', '+0h', '+999h', '25:00', '12:60', 'noon', '+1.5h'])('rejects %s', (raw) => {
    expect(parseUntil(raw, NOW)).toBeInstanceOf(Error);
  });
});

describe('parseSuperviseArgs', () => {
  it('collects refs, repeatable goals, until and flags', () => {
    expect(parseSuperviseArgs(['a', 'b', '--goal', 'one', '--goal=two', '--until', '+2h', '--print-brief', '--json'])).toMatchObject({
      refs: ['a', 'b'], goals: ['one', 'two'], until: '+2h', printBrief: true, json: true,
    });
  });
  it('flags unknown options and a missing goal value', () => {
    expect(parseSuperviseArgs(['--wat']).error).toContain('unknown option');
    expect(parseSuperviseArgs(['a', '--goal']).error).toContain('--goal');
  });
});

describe('renderBrief', () => {
  it('contains exact ids, names, goals, an absolute deadline and the operator rules', () => {
    const brief = renderBrief({
      supervisionId: 'sup-x',
      targets: [{ taskId: 'aaaaaaaa-1111', name: 'alpha-worker', status: 'inProgress', runState: 'run-state: turnState running' }],
      goals: ['land the PR'],
      deadline: new Date(2026, 10, 8, 20, 0, 0),
      now: NOW,
    });
    expect(brief).toContain('`aaaaaaaa-1111`');
    expect(brief).toContain('alpha-worker');
    expect(brief).toContain('turnState running');
    expect(brief).toContain('- land the PR');
    expect(brief).toContain('2026-11-08 20:00');
    expect(brief).toContain('NEVER buy, subscribe, top up or refill');
    expect(brief).toContain('INPUT_REFUSED');
  });
});

describe('runSuperviseCli', () => {
  it('--print-brief prints the brief and launches nothing', async () => {
    const t = setup(['aaaaaaaa', '--goal', 'g1', '--until', '+2h', '--print-brief']);
    expect(await t.run()).toBe(0);
    expect(t.logs.join('\n')).toContain('aaaaaaaa-1111');
    expect(t.logs.join('\n')).toContain('turnState running');
    expect(t.requests.filter((r) => r.method === 'POST')).toEqual([]);
    expect(existsSync(join(t.dataDir, 'supervisions'))).toBe(false);
  });

  it('launches the supervisor with the plugin playbook and creates one supervises relation per target', async () => {
    const t = setup(['aaaaaaaa-1111', 'beta-worker', 'aaaaaaaa', '--goal', 'ship', '--json']);
    expect(await t.run()).toBe(0);
    const posts = t.requests.filter((r) => r.method === 'POST');
    expect(posts).toHaveLength(3); // duplicate ref collapsed
    const launch = posts[0];
    expect(launch.url).toBe('http://127.0.0.1:4800/api/tasks');
    expect(launch.headers['X-Kookr-Launch-Source']).toBe('cli');
    expect(launch.body).toMatchObject({
      cwd: '/work/dir',
      playbook: { path: 'task-supervisor.md', scope: 'plugin' },
      idempotencyKey: 'supervise-sup-test',
    });
    expect(launch.body.prompt).toContain('`aaaaaaaa-1111`');
    expect(launch.body.prompt).toContain('`bbbbbbbb-2222`');
    expect(posts.slice(1).map((p) => p.body)).toEqual([
      expect.objectContaining({ sourceTaskId: 'sup-task-1', targetTaskId: 'aaaaaaaa-1111', type: 'supervises', confidence: 1, source: 'api' }),
      expect.objectContaining({ sourceTaskId: 'sup-task-1', targetTaskId: 'bbbbbbbb-2222', type: 'supervises', confidence: 1, source: 'api' }),
    ]);
    const env = JSON.parse(t.logs[0]);
    expect(env).toMatchObject({ ok: true, code: 'OK', details: { supervisionId: 'sup-test', supervisorTaskId: 'sup-task-1' } });
    const dir = join(t.dataDir, 'supervisions', 'sup-test');
    expect(readFileSync(join(dir, 'brief.md'), 'utf-8')).toBe(launch.body.prompt);
    expect(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf-8'))).toEqual({
      supervisionId: 'sup-test',
      targets: [{ taskId: 'aaaaaaaa-1111', name: 'alpha-worker' }, { taskId: 'bbbbbbbb-2222', name: 'beta-worker' }],
      goals: ['ship'],
      deadlineAt: new Date(NOW.getTime() + 4 * 3_600_000).toISOString(),
      createdAt: NOW.toISOString(),
      supervisorTaskId: 'sup-task-1',
    });
  });

  it('keeps exit 0 with a warning when a relation write fails', async () => {
    const t = setup(['aaaaaaaa-1111', '--json'], { relationStatus: 500 });
    expect(await t.run()).toBe(0);
    const env = JSON.parse(t.logs[0]);
    expect(env.ok).toBe(true);
    expect(env.details.relationsCreated).toEqual([]);
    expect(env.details.warnings[0]).toContain('aaaaaaaa-1111');
  });

  it('prints the relation warning on stderr in human mode', async () => {
    const t = setup(['aaaaaaaa-1111'], { relationStatus: 500 });
    expect(await t.run()).toBe(0);
    expect(t.errors.join('\n')).toContain('warning');
  });

  it('fails with a server error (4) when the launch is rejected, and posts no relations', async () => {
    const t = setup(['aaaaaaaa-1111'], { launchStatus: 400 });
    expect(await t.run()).toBe(4);
    expect(t.requests.filter((r) => r.url.endsWith('/api/task-relations'))).toEqual([]);
  });

  it('exits 2 for unknown, ambiguous and terminal refs without launching', async () => {
    for (const [ref, rc, code] of [['nope', 2, 'UNKNOWN_TASK'], ['bbbbbbbb', 5, 'AMBIGUOUS_TASK'], ['cccccccc-4444', 2, 'TERMINAL_TASK']] as const) {
      const t = setup([ref, '--json']);
      expect(await t.run()).toBe(rc);
      expect(JSON.parse(t.logs[0]).code).toBe(code);
      expect(JSON.parse(t.logs[0]).ok).toBe(false);
      expect(t.requests.filter((r) => r.method === 'POST')).toEqual([]);
    }
  });

  it('(a) two targets, only the second relation fails: one created, one warning', async () => {
    const t = setup(['aaaaaaaa-1111', 'beta-worker', '--json'], { relationSeq: [201, 500] });
    expect(await t.run()).toBe(0);
    const d = JSON.parse(t.logs[0]).details;
    expect(d.relationsCreated).toEqual(['aaaaaaaa-1111']);
    expect(d.warnings).toHaveLength(1);
    expect(d.warnings[0]).toContain('bbbbbbbb-2222');
  });

  it('(b) a failing second state.json write after launch is a warning, exit 0', async () => {
    let stateWrites = 0;
    const fs: SupervisionFs = {
      mkdirSync: (p, o) => mkdirSync(p, o),
      writeFileSync: (p, d) => {
        if (String(p).includes('state.json')) {
          stateWrites += 1;
          if (stateWrites === 2) throw new Error('ENOSPC');
        }
        writeFileSync(p, d);
      },
      renameSync: (a, b) => renameSync(a, b),
      rmSync: (p, o) => rmSync(p, o),
    };
    const t = setup(['aaaaaaaa-1111', '--json'], {}, {}, fs);
    expect(await t.run()).toBe(0);
    const d = JSON.parse(t.logs[0]).details;
    expect(d.warnings[0]).toContain('state.json');
    expect(d.relationsCreated).toEqual(['aaaaaaaa-1111']);
  });

  it('(c) a relation request that throws is a warning, exit 0', async () => {
    const t = setup(['aaaaaaaa-1111', '--json'], { relationSeq: ['throw'] });
    expect(await t.run()).toBe(0);
    expect(JSON.parse(t.logs[0]).details.warnings[0]).toContain('socket hang up');
  });

  it('(d) refuses a target already supervised by a live supervisor; a terminal one does not block', async () => {
    const tasks: CompactTask[] = [...TASKS, { taskId: 'sup-live-1', name: 'sup-a', status: 'inProgress' }, { taskId: 'sup-dead-1', name: 'sup-b', status: 'completed' }];
    const edge = (src: string, lifecycle = 'active') => ({ sourceTaskId: src, targetTaskId: 'aaaaaaaa-1111', type: 'supervises', lifecycle });
    const blocked = setup(['aaaaaaaa-1111', '--json'], { tasks, existingRelations: [edge('sup-live-1')] });
    expect(await blocked.run()).toBe(2);
    const env = JSON.parse(blocked.logs[0]);
    expect(env.code).toBe('ALREADY_SUPERVISED');
    expect(env.message).toContain('sup-live-1');
    expect(blocked.requests.filter((r) => r.method === 'POST')).toEqual([]);
    expect(blocked.requests.some((r) => r.url.includes('/api/task-relations?targetTaskId=aaaaaaaa-1111&type=supervises'))).toBe(true);

    for (const rels of [[edge('sup-dead-1')], [edge('sup-live-1', 'superseded')]]) {
      const ok = setup(['aaaaaaaa-1111', '--json'], { tasks, existingRelations: rels });
      expect(await ok.run()).toBe(0);
    }
  });

  it.each([['503', [503, 201] as Array<number | 'throw'>], ['network error', ['throw', 201] as Array<number | 'throw'>]])(
    '(e) retries an ambiguous launch (%s) with the identical body and key, creating one supervisor',
    async (_label, launchSeq) => {
      const t = setup(['aaaaaaaa-1111', '--json'], { launchSeq });
      expect(await t.run()).toBe(0);
      const launches = t.requests.filter((r) => r.method === 'POST' && r.url.endsWith('/api/tasks'));
      expect(launches).toHaveLength(2);
      expect(launches[1].body).toEqual(launches[0].body);
      expect(launches[0].body.idempotencyKey).toBe('supervise-sup-test');
      expect(t.sleeps).toHaveLength(1);
      expect(JSON.parse(t.logs[0]).details.supervisorTaskId).toBe('sup-task-1');
    },
  );

  it('(e) after 3 ambiguous attempts reports the supervisionId and idempotency key and posts no relations', async () => {
    const t = setup(['aaaaaaaa-1111', '--json'], { launchSeq: [503] });
    expect(await t.run()).toBe(4);
    const env = JSON.parse(t.logs[0]);
    expect(env.code).toBe('LAUNCH_UNCERTAIN');
    expect(env.message).toContain('supervisionId=sup-test');
    expect(env.message).toContain('idempotencyKey=supervise-sup-test');
    expect(t.requests.filter((r) => r.url.endsWith('/api/tasks') && r.method === 'POST')).toHaveLength(3);
    expect(t.requests.filter((r) => r.url.endsWith('/api/task-relations'))).toEqual([]);
  });

  it('does not retry a definitive 4xx rejection', async () => {
    const t = setup(['aaaaaaaa-1111'], { launchSeq: [400] });
    expect(await t.run()).toBe(4);
    expect(t.requests.filter((r) => r.url.endsWith('/api/tasks') && r.method === 'POST')).toHaveLength(1);
  });

  it('exits 2 for a bad --until and when no ref is given', async () => {
    expect(await setup(['aaaaaaaa-1111', '--until', 'soon']).run()).toBe(2);
    expect(await setup([]).run()).toBe(2);
  });

  it('sends the supervisor token when set', async () => {
    const t = setup(['aaaaaaaa-1111'], {}, { KOOKR_SUPERVISOR_TOKEN: 'tok', KOOKR_PORT: '4800' });
    expect(await t.run()).toBe(0);
    expect(t.requests.filter((r) => r.method === 'POST')).toHaveLength(2);
    expect(t.requests.every((r) => r.headers.Authorization === 'Bearer tok')).toBe(true);
  });
});

describe('task-supervisor playbook', () => {
  it('parses, takes the wrapper prompt parameter, and carries the load-bearing rules', () => {
    const path = join(process.cwd(), 'plugin', 'playbooks', SUPERVISOR_PLAYBOOK_PATH);
    const pb = parsePlaybook(readFileSync(path, 'utf-8'), SUPERVISOR_PLAYBOOK_PATH, process.cwd(), 'plugin');
    expect(pb.parameters.map((p) => p.name)).toEqual(['prompt']);
    expect(pb.parameters.find((p) => p.name === 'prompt')?.required).toBe(true);
    expect(pb.body).not.toMatch(/\{\{(targets|goals|until)\}\}/);
    expect(pb.body).toContain('{{prompt}}');
    for (const needle of ['kookr peek', 'INPUT_REFUSED', '/compact', 'NEVER buy', 'completion-ready', 'run_in_background', 'TEMPORARY']) {
      expect(pb.body).toContain(needle);
    }
  });
});
