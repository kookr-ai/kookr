import { afterEach, describe, expect, it, vi } from 'vitest';
// The CLI ships as a plain ESM .js file in bin/ (same pattern as
// bin/kookr-issue.js) so it runs without a build step. Types come from
// bin/kookr-schedule.d.ts.
import {
  parseArgs,
  resolveId,
  formatScheduleLine,
  selectCascadeHeld,
  UsageError,
  main,
} from '../../bin/kookr-schedule.js';

const EXIT_OK = 0;
const EXIT_USER_ERROR = 2;
const EXIT_NO_SERVER = 3;
const EXIT_SERVER_ERROR = 4;

const BASE_ENV = { KOOKR_API_BASE_URL: 'http://127.0.0.1:4800' } as const;

function mkIO() {
  const logs: string[] = [];
  const errs: string[] = [];
  return {
    out: { log: (m?: unknown) => logs.push(String(m)) },
    err: { error: (m?: unknown) => errs.push(String(m)) },
    logs,
    errs,
  };
}

function mkExit() {
  const calls: number[] = [];
  const exit = (code: number) => {
    calls.push(code);
  };
  exit.calls = calls;
  return exit;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(body === undefined ? '' : JSON.stringify(body), { status });
}

const SCHEDULE_A = {
  id: 'sched-a',
  name: 'Nightly drain',
  enabled: true,
  cron: '0 3 * * *',
  nextRunAt: '2026-07-29T03:00:00.000Z',
  maxTriggers: 10,
  remainingTriggers: 4,
};
const SCHEDULE_B = {
  id: 'sched-b',
  name: 'Hourly smoke',
  enabled: false,
  cron: '0 * * * *',
  nextRunAt: null,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('kookr schedule parseArgs', () => {
  it('parses list with --json', () => {
    expect(parseArgs(['list', '--json'])).toEqual({ verb: 'list', id: null, json: true, help: false, heldBy: null, stopReason: null, heldBefore: null });
  });

  it('parses run with an id', () => {
    expect(parseArgs(['run', 'sched-a'])).toEqual({ verb: 'run', id: 'sched-a', json: false, help: false, heldBy: null, stopReason: null, heldBefore: null });
  });

  it('parses enable/disable with an id and --json', () => {
    expect(parseArgs(['enable', 'sched-a', '--json'])).toEqual({ verb: 'enable', id: 'sched-a', json: true, help: false, heldBy: null, stopReason: null, heldBefore: null });
    expect(parseArgs(['disable', 'sched-b'])).toEqual({ verb: 'disable', id: 'sched-b', json: false, help: false, heldBy: null, stopReason: null, heldBefore: null });
  });

  it('parses --help', () => {
    expect(parseArgs(['--help'])).toEqual({ verb: null, id: null, json: false, help: true, heldBy: null, stopReason: null, heldBefore: null });
  });

  it('parses enable --held-by cascade (space and = forms, plus alias)', () => {
    expect(parseArgs(['enable', '--held-by', 'cascade'])).toEqual({ verb: 'enable', id: null, json: false, help: false, heldBy: 'cascade', stopReason: null, heldBefore: null });
    expect(parseArgs(['enable', '--held-by=cascade'])).toEqual({ verb: 'enable', id: null, json: false, help: false, heldBy: 'cascade', stopReason: null, heldBefore: null });
    expect(parseArgs(['enable', '--held-by', 'consecutive-failures'])).toEqual({ verb: 'enable', id: null, json: false, help: false, heldBy: 'cascade', stopReason: null, heldBefore: null });
  });

  it('throws UsageError on an unknown --held-by value or a missing value', () => {
    expect(() => parseArgs(['enable', '--held-by', 'bogus'])).toThrow(UsageError);
    expect(() => parseArgs(['enable', '--held-by'])).toThrow(UsageError);
  });

  it('parses bulk-recovery flags (issue #2520)', () => {
    expect(parseArgs(['enable', '--stop-reason', 'consecutive_failures'])).toEqual({
      verb: 'enable', id: null, json: false, help: false, heldBy: null, stopReason: 'consecutive_failures', heldBefore: null,
    });
    expect(parseArgs(['enable', '--stop-reason=consecutive_failures', '--held-before', '2026-08-14T02:16:00Z'])).toEqual({
      verb: 'enable', id: null, json: false, help: false, heldBy: null, stopReason: 'consecutive_failures', heldBefore: '2026-08-14T02:16:00Z',
    });
  });

  it('throws UsageError when --stop-reason has no value', () => {
    expect(() => parseArgs(['enable', '--stop-reason'])).toThrow(UsageError);
    expect(() => parseArgs(['enable', '--held-before'])).toThrow(UsageError);
  });

  it('throws UsageError on unknown option', () => {
    expect(() => parseArgs(['list', '--nope'])).toThrow(UsageError);
  });

  it('throws UsageError on an extra positional', () => {
    expect(() => parseArgs(['run', 'a', 'b'])).toThrow(UsageError);
  });
});

describe('kookr schedule resolveId / formatScheduleLine', () => {
  it('trims and rejects blank ids', () => {
    expect(resolveId('  sched-a ')).toBe('sched-a');
    expect(resolveId('   ')).toBeNull();
    expect(resolveId(undefined)).toBeNull();
  });

  it('renders an enabled schedule with trigger budget', () => {
    expect(formatScheduleLine(SCHEDULE_A)).toBe(
      'sched-a  enabled   Nightly drain  cron="0 3 * * *"  next=2026-07-29T03:00:00.000Z  triggers=4/10',
    );
  });

  it('renders a disabled schedule with no next run', () => {
    expect(formatScheduleLine(SCHEDULE_B)).toBe('sched-b  disabled  Hourly smoke  cron="0 * * * *"  next=-');
  });
});

describe('kookr schedule main — argument validation', () => {
  it('exits 2 when no verb given', async () => {
    const io = mkIO();
    const exit = mkExit();
    await main({ argv: [], env: {}, out: io.out, err: io.err, exit });
    expect(exit.calls).toEqual([EXIT_USER_ERROR]);
  });

  it('exits 2 on an unknown verb', async () => {
    const io = mkIO();
    const exit = mkExit();
    await main({ argv: ['bogus'], env: {}, out: io.out, err: io.err, exit });
    expect(exit.calls).toEqual([EXIT_USER_ERROR]);
  });

  it('exits 2 when run is missing an id', async () => {
    const io = mkIO();
    const exit = mkExit();
    await main({ argv: ['run'], env: {}, out: io.out, err: io.err, exit });
    expect(exit.calls).toEqual([EXIT_USER_ERROR]);
    expect(io.errs.join('\n')).toMatch(/schedule id is required/);
  });

  it('exits 2 when enable/disable is missing an id', async () => {
    for (const verb of ['enable', 'disable']) {
      const io = mkIO();
      const exit = mkExit();
      await main({ argv: [verb], env: {}, out: io.out, err: io.err, exit });
      expect(exit.calls).toEqual([EXIT_USER_ERROR]);
      expect(io.errs.join('\n')).toMatch(new RegExp(`kookr schedule ${verb} <id>`));
    }
  });

  it('prints help and exits 0', async () => {
    const io = mkIO();
    const exit = mkExit();
    await main({ argv: ['--help'], env: {}, out: io.out, err: io.err, exit });
    expect(exit.calls).toEqual([EXIT_OK]);
    expect(io.logs.join('\n')).toMatch(/kookr schedule/);
  });
});

describe('kookr schedule list', () => {
  it('renders one line per schedule', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ revision: 1, schedules: [SCHEDULE_A, SCHEDULE_B], status: {} }, 200));
    vi.stubGlobal('fetch', fetchMock);
    const io = mkIO();
    const exit = mkExit();
    await main({ argv: ['list'], env: { ...BASE_ENV }, out: io.out, err: io.err, exit });
    expect(exit.calls).toEqual([EXIT_OK]);
    expect(io.logs).toHaveLength(2);
    expect(io.logs[0]).toContain('sched-a');
    expect(io.logs[1]).toContain('sched-b');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:4800/api/schedules');
    expect(init.method).toBe('GET');
  });

  it('prints "No schedules." when empty', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ revision: 0, schedules: [], status: {} }, 200)));
    const io = mkIO();
    const exit = mkExit();
    await main({ argv: ['list'], env: { ...BASE_ENV }, out: io.out, err: io.err, exit });
    expect(exit.calls).toEqual([EXIT_OK]);
    expect(io.logs).toEqual(['No schedules.']);
  });

  it('warns on stderr when the scheduler is unhealthy/not configured', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ revision: 0, schedules: [], status: { schedulerHealthy: false } }, 200)));
    const io = mkIO();
    const exit = mkExit();
    await main({ argv: ['list'], env: { ...BASE_ENV }, out: io.out, err: io.err, exit });
    expect(exit.calls).toEqual([EXIT_OK]);
    expect(io.logs).toEqual(['No schedules.']);
    expect(io.errs.join('\n')).toMatch(/scheduler is not healthy or not configured/);
  });

  it('emits a JSON envelope with --json', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ revision: 1, schedules: [SCHEDULE_A], status: { schedulerHealthy: true } }, 200)));
    const io = mkIO();
    const exit = mkExit();
    await main({ argv: ['list', '--json'], env: { ...BASE_ENV }, out: io.out, err: io.err, exit });
    expect(exit.calls).toEqual([EXIT_OK]);
    const payload = JSON.parse(io.logs[0]);
    expect(payload.ok).toBe(true);
    expect(payload.code).toBe('OK');
    expect(payload.details.schedules).toHaveLength(1);
    expect(payload.details.status.schedulerHealthy).toBe(true);
  });
});

describe('kookr schedule run', () => {
  it('POSTs to the run route and reports the task id', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, taskId: 'task-123' }, 200));
    vi.stubGlobal('fetch', fetchMock);
    const io = mkIO();
    const exit = mkExit();
    await main({ argv: ['run', 'sched-a'], env: { ...BASE_ENV }, out: io.out, err: io.err, exit });
    expect(exit.calls).toEqual([EXIT_OK]);
    expect(io.logs.join('\n')).toContain('task-123');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:4800/api/schedules/sched-a/run');
    expect(init.method).toBe('POST');
  });

  it('marks a queued run', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: true, taskId: 't-q', queued: true }, 200)));
    const io = mkIO();
    const exit = mkExit();
    await main({ argv: ['run', 'sched-a'], env: { ...BASE_ENV }, out: io.out, err: io.err, exit });
    expect(exit.calls).toEqual([EXIT_OK]);
    expect(io.logs.join('\n')).toContain('(queued)');
  });

  it('reports dependency parking without calling it a capacity queue', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      ok: true,
      taskId: 't-parked',
      queued: true,
      parked: true,
      outcome: 'parked_dependency',
      reasonCode: 'dependency_degraded',
    }, 200)));
    const io = mkIO();
    const exit = mkExit();

    await main({ argv: ['run', 'sched-a'], env: { ...BASE_ENV }, out: io.out, err: io.err, exit });

    expect(exit.calls).toEqual([EXIT_OK]);
    expect(io.logs.join('\n')).toContain('(parked — launch dependency degraded)');
    expect(io.logs.join('\n')).not.toContain('(queued)');
  });

  it('preserves dependency parking classification in JSON output', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      ok: true,
      taskId: 't-parked',
      queued: true,
      parked: true,
      outcome: 'parked_dependency',
      reasonCode: 'dependency_degraded',
    }, 200)));
    const io = mkIO();
    const exit = mkExit();

    await main({ argv: ['run', 'sched-a', '--json'], env: { ...BASE_ENV }, out: io.out, err: io.err, exit });

    const payload = JSON.parse(io.logs[0]);
    expect(payload.details).toMatchObject({
      queued: true,
      parked: true,
      outcome: 'parked_dependency',
      reasonCode: 'dependency_degraded',
    });
  });

  it('exits 4 and surfaces the code when the server rejects (capacity)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'Max active tasks reached', code: 'capacity' }, 409)));
    const io = mkIO();
    const exit = mkExit();
    await main({ argv: ['run', 'sched-a'], env: { ...BASE_ENV }, out: io.out, err: io.err, exit });
    expect(exit.calls).toEqual([EXIT_SERVER_ERROR]);
    expect(io.errs.join('\n')).toContain('Max active tasks reached');
  });

  it('exits 4 with a JSON envelope carrying the server code', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'Server draining', code: 'draining' }, 503)));
    const io = mkIO();
    const exit = mkExit();
    await main({ argv: ['run', 'sched-a', '--json'], env: { ...BASE_ENV }, out: io.out, err: io.err, exit });
    expect(exit.calls).toEqual([EXIT_SERVER_ERROR]);
    const payload = JSON.parse(io.logs[0]);
    expect(payload.ok).toBe(false);
    expect(payload.details.status).toBe(503);
    expect(payload.details.code).toBe('draining');
  });
});

describe('kookr schedule enable / disable', () => {
  it('PATCHes enabled:true and confirms', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ id: 'sched-a', name: 'Nightly drain', enabled: true }, 200));
    vi.stubGlobal('fetch', fetchMock);
    const io = mkIO();
    const exit = mkExit();
    await main({ argv: ['enable', 'sched-a'], env: { ...BASE_ENV }, out: io.out, err: io.err, exit });
    expect(exit.calls).toEqual([EXIT_OK]);
    expect(io.logs.join('\n')).toContain('Enabled schedule sched-a (Nightly drain)');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:4800/api/schedules/sched-a');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ enabled: true });
  });

  it('PATCHes enabled:false for disable', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ id: 'sched-b', name: 'Hourly smoke', enabled: false }, 200));
    vi.stubGlobal('fetch', fetchMock);
    const io = mkIO();
    const exit = mkExit();
    await main({ argv: ['disable', 'sched-b'], env: { ...BASE_ENV }, out: io.out, err: io.err, exit });
    expect(exit.calls).toEqual([EXIT_OK]);
    expect(io.logs.join('\n')).toContain('Disabled schedule sched-b');
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ enabled: false });
  });

  it('exits 4 when scheduling is not configured', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'Scheduling not configured' }, 500)));
    const io = mkIO();
    const exit = mkExit();
    await main({ argv: ['enable', 'sched-a'], env: { ...BASE_ENV }, out: io.out, err: io.err, exit });
    expect(exit.calls).toEqual([EXIT_SERVER_ERROR]);
    expect(io.errs.join('\n')).toContain('Scheduling not configured');
  });
});

describe('kookr schedule selectCascadeHeld (issue #2531)', () => {
  const CASCADE_A = { id: 'cas-a', name: 'orchestrator', enabled: false, stopReason: 'consecutive_failures' };
  const CASCADE_B = { id: 'cas-b', name: 'smoke tick', enabled: false, stopReason: 'consecutive_failures' };
  const OPERATOR_HELD = { id: 'op-a', name: 'manual pause', enabled: false, operatorHold: true };
  const TRIGGER_EXHAUSTED = { id: 'tr-a', name: 'budgeted', enabled: false, stopReason: 'trigger_limit_reached' };
  const RUNNING = { id: 'run-a', name: 'live', enabled: true, stopReason: 'consecutive_failures' };

  it('selects only disabled + consecutive_failures schedules', () => {
    const selected = selectCascadeHeld([CASCADE_A, OPERATOR_HELD, TRIGGER_EXHAUSTED, RUNNING, CASCADE_B]);
    expect(selected.map((s) => s.id)).toEqual(['cas-a', 'cas-b']);
  });

  it('never selects a genuine operator hold or a trigger-limit park', () => {
    expect(selectCascadeHeld([OPERATOR_HELD, TRIGGER_EXHAUSTED])).toEqual([]);
  });

  it('tolerates a non-array input', () => {
    expect(selectCascadeHeld(undefined)).toEqual([]);
    expect(selectCascadeHeld(null)).toEqual([]);
  });
});

describe('kookr schedule enable --held-by cascade (issue #2531)', () => {
  const CASCADE_A = { id: 'cas-a', name: 'orchestrator', enabled: false, stopReason: 'consecutive_failures' };
  const CASCADE_B = { id: 'cas-b', name: 'smoke tick', enabled: false, stopReason: 'consecutive_failures' };
  const OPERATOR_HELD = { id: 'op-a', name: 'manual pause', enabled: false, operatorHold: true };

  function batchFetch(schedules, patchStatusById = {}) {
    return vi.fn(async (url, init) => {
      const method = init?.method;
      if (method === 'GET') return jsonResponse({ revision: 1, schedules, status: {} }, 200);
      if (method === 'PATCH') {
        const id = decodeURIComponent(String(url).split('/').pop());
        const status = patchStatusById[id] ?? 200;
        if (status === 200) return jsonResponse({ id, name: `n-${id}`, enabled: true }, 200);
        return jsonResponse({ error: `rejected ${id}` }, status);
      }
      return jsonResponse({ error: 'unexpected' }, 500);
    });
  }

  it('re-enables only cascade-held schedules and leaves operator holds untouched', async () => {
    const fetchMock = batchFetch([CASCADE_A, OPERATOR_HELD, CASCADE_B]);
    vi.stubGlobal('fetch', fetchMock);
    const io = mkIO();
    const exit = mkExit();
    await main({ argv: ['enable', '--held-by', 'cascade'], env: { ...BASE_ENV }, out: io.out, err: io.err, exit });
    expect(exit.calls).toEqual([EXIT_OK]);

    const patchCalls = fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH');
    const patchedIds = patchCalls.map(([url]) => String(url).split('/').pop());
    expect(patchedIds).toEqual(['cas-a', 'cas-b']);
    expect(patchedIds).not.toContain('op-a');
    for (const [, init] of patchCalls) {
      expect(JSON.parse(init.body as string)).toEqual({ enabled: true });
    }
    const out = io.logs.join('\n');
    expect(out).toContain('cas-a');
    expect(out).toContain('cas-b');
    expect(out).toContain('Re-enabled 2 of 2.');
  });

  it('is idempotent — a clean fleet reports nothing to do, writes nothing, and exits 0', async () => {
    const fetchMock = batchFetch([OPERATOR_HELD, { id: 'live', enabled: true }]);
    vi.stubGlobal('fetch', fetchMock);
    const io = mkIO();
    const exit = mkExit();
    await main({ argv: ['enable', '--held-by', 'cascade'], env: { ...BASE_ENV }, out: io.out, err: io.err, exit });
    expect(exit.calls).toEqual([EXIT_OK]);
    expect(io.logs.join('\n')).toMatch(/No cascade-held schedules/);
    // A no-op must not issue any PATCH writes.
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(0);
  });

  it('emits an empty JSON envelope on a clean fleet', async () => {
    vi.stubGlobal('fetch', batchFetch([OPERATOR_HELD]));
    const io = mkIO();
    const exit = mkExit();
    await main({ argv: ['enable', '--held-by', 'cascade', '--json'], env: { ...BASE_ENV }, out: io.out, err: io.err, exit });
    expect(exit.calls).toEqual([EXIT_OK]);
    const payload = JSON.parse(io.logs[0]);
    expect(payload.ok).toBe(true);
    expect(payload.details).toEqual({ heldBy: 'cascade', total: 0, reenabled: [], failed: [] });
  });

  it('records a failed row (status 0) and exits 4 when a PATCH throws mid-batch', async () => {
    // batchFetch always resolves; wrap it so cas-b's PATCH rejects (network drop).
    const inner = batchFetch([CASCADE_A, CASCADE_B]);
    const fetchMock = vi.fn(async (url, init) => {
      if (init?.method === 'PATCH' && decodeURIComponent(String(url).split('/').pop()) === 'cas-b') {
        throw new Error('ECONNRESET');
      }
      return inner(url, init);
    });
    vi.stubGlobal('fetch', fetchMock);
    const io = mkIO();
    const exit = mkExit();
    await main({ argv: ['enable', '--held-by', 'cascade', '--json'], env: { ...BASE_ENV }, out: io.out, err: io.err, exit });
    expect(exit.calls).toEqual([EXIT_SERVER_ERROR]);
    const payload = JSON.parse(io.logs[0]);
    expect(payload.ok).toBe(false);
    expect(payload.details.reenabled.map((r: { id: string }) => r.id)).toEqual(['cas-a']);
    expect(payload.details.failed).toHaveLength(1);
    expect(payload.details.failed[0]).toMatchObject({ id: 'cas-b', status: 0 });
    expect(payload.details.failed[0].error).toContain('ECONNRESET');
  });

  it('emits a JSON envelope listing what it re-enabled', async () => {
    vi.stubGlobal('fetch', batchFetch([CASCADE_A, CASCADE_B]));
    const io = mkIO();
    const exit = mkExit();
    await main({ argv: ['enable', '--held-by', 'cascade', '--json'], env: { ...BASE_ENV }, out: io.out, err: io.err, exit });
    expect(exit.calls).toEqual([EXIT_OK]);
    const payload = JSON.parse(io.logs[0]);
    expect(payload.ok).toBe(true);
    expect(payload.details.heldBy).toBe('cascade');
    expect(payload.details.total).toBe(2);
    expect(payload.details.reenabled.map((r: { id: string }) => r.id)).toEqual(['cas-a', 'cas-b']);
    expect(payload.details.failed).toEqual([]);
  });

  it('reports partial failure and exits 4 when one PATCH is rejected', async () => {
    vi.stubGlobal('fetch', batchFetch([CASCADE_A, CASCADE_B], { 'cas-b': 500 }));
    const io = mkIO();
    const exit = mkExit();
    await main({ argv: ['enable', '--held-by', 'cascade'], env: { ...BASE_ENV }, out: io.out, err: io.err, exit });
    expect(exit.calls).toEqual([EXIT_SERVER_ERROR]);
    expect(io.logs.join('\n')).toContain('Re-enabled 1 of 2.');
    expect(io.errs.join('\n')).toContain('cas-b');
  });

  it('rejects --held-by combined with an <id>', async () => {
    const io = mkIO();
    const exit = mkExit();
    await main({ argv: ['enable', 'sched-a', '--held-by', 'cascade'], env: { ...BASE_ENV }, out: io.out, err: io.err, exit });
    expect(exit.calls).toEqual([EXIT_USER_ERROR]);
    expect(io.errs.join('\n')).toMatch(/cannot combine/);
  });

  it('rejects --held-by on a non-enable verb', async () => {
    const io = mkIO();
    const exit = mkExit();
    await main({ argv: ['disable', '--held-by', 'cascade'], env: { ...BASE_ENV }, out: io.out, err: io.err, exit });
    expect(exit.calls).toEqual([EXIT_USER_ERROR]);
    expect(io.errs.join('\n')).toMatch(/only valid with "enable"/);
  });
});

describe('kookr schedule enable --stop-reason (bulk recovery, issue #2520)', () => {
  it('POSTs /recover with stopReason + heldBefore and reports recovered schedules', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      ok: true,
      recovered: [{ id: 'sched-a', name: 'Queue Feeder', heldAt: '2026-08-14T00:10:00.000Z' }],
      skipped: [{ id: 'sched-x', name: 'Exhausted', reason: 'trigger_limit_exhausted' }],
    }, 200));
    vi.stubGlobal('fetch', fetchMock);
    const io = mkIO();
    const exit = mkExit();
    await main({
      argv: ['enable', '--stop-reason', 'consecutive_failures', '--held-before', '2026-08-14T02:16:00.000Z'],
      env: { ...BASE_ENV }, out: io.out, err: io.err, exit,
    });
    expect(exit.calls).toEqual([EXIT_OK]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:4800/api/schedules/recover');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      stopReason: 'consecutive_failures',
      heldBefore: '2026-08-14T02:16:00.000Z',
    });
    expect(io.logs.join('\n')).toContain('Recovered 1 consecutive_failures hold');
    expect(io.errs.join('\n')).toContain('trigger_limit_exhausted');
  });

  it('rejects an unsupported --stop-reason without hitting the server', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}, 200));
    vi.stubGlobal('fetch', fetchMock);
    const io = mkIO();
    const exit = mkExit();
    await main({ argv: ['enable', '--stop-reason', 'trigger_limit_reached'], env: { ...BASE_ENV }, out: io.out, err: io.err, exit });
    expect(exit.calls).toEqual([EXIT_USER_ERROR]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects giving both an <id> and --stop-reason', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}, 200));
    vi.stubGlobal('fetch', fetchMock);
    const io = mkIO();
    const exit = mkExit();
    await main({ argv: ['enable', 'sched-a', '--stop-reason', 'consecutive_failures'], env: { ...BASE_ENV }, out: io.out, err: io.err, exit });
    expect(exit.calls).toEqual([EXIT_USER_ERROR]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects --stop-reason on disable', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}, 200));
    vi.stubGlobal('fetch', fetchMock);
    const io = mkIO();
    const exit = mkExit();
    await main({ argv: ['disable', '--stop-reason', 'consecutive_failures'], env: { ...BASE_ENV }, out: io.out, err: io.err, exit });
    expect(exit.calls).toEqual([EXIT_USER_ERROR]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects --held-before on a plain enable (no --stop-reason)', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}, 200));
    vi.stubGlobal('fetch', fetchMock);
    const io = mkIO();
    const exit = mkExit();
    await main({ argv: ['enable', 'sched-a', '--held-before', '2026-08-14T02:16:00Z'], env: { ...BASE_ENV }, out: io.out, err: io.err, exit });
    expect(exit.calls).toEqual([EXIT_USER_ERROR]);
    expect(io.errs.join('\n')).toContain('--held-before requires --stop-reason');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a malformed --held-before without hitting the server', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}, 200));
    vi.stubGlobal('fetch', fetchMock);
    const io = mkIO();
    const exit = mkExit();
    await main({ argv: ['enable', '--stop-reason', 'consecutive_failures', '--held-before', 'not-a-date'], env: { ...BASE_ENV }, out: io.out, err: io.err, exit });
    expect(exit.calls).toEqual([EXIT_USER_ERROR]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('emits a machine-readable envelope for --json bulk recovery', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      ok: true,
      recovered: [{ id: 'sched-a', name: 'Queue Feeder' }],
      skipped: [],
    }, 200));
    vi.stubGlobal('fetch', fetchMock);
    const io = mkIO();
    const exit = mkExit();
    await main({ argv: ['enable', '--stop-reason', 'consecutive_failures', '--json'], env: { ...BASE_ENV }, out: io.out, err: io.err, exit });
    expect(exit.calls).toEqual([EXIT_OK]);
    const payload = JSON.parse(io.logs[0]);
    expect(payload.ok).toBe(true);
    expect(payload.details.recovered).toEqual([{ id: 'sched-a', name: 'Queue Feeder' }]);
  });
});

describe('kookr schedule — server discovery failures', () => {
  it('exits 3 when no server is reachable', async () => {
    const io = mkIO();
    const exit = mkExit();
    // No KOOKR_API_BASE_URL/KOOKR_PORT and a network with nothing listening;
    // stub fetch to always reject so port probing resolves to "none".
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }));
    await main({ argv: ['list'], env: { KOOKR_SPAWN_CONNECT_RETRIES: '1' }, out: io.out, err: io.err, exit });
    expect(exit.calls).toEqual([EXIT_NO_SERVER]);
  });

  it('exits 2 when KOOKR_PORT is invalid', async () => {
    const io = mkIO();
    const exit = mkExit();
    await main({ argv: ['list'], env: { KOOKR_PORT: 'abc' }, out: io.out, err: io.err, exit });
    // Invalid port is surfaced as a user error (2) by resolveBaseUrl's
    // invalid_port branch.
    expect(exit.calls).toEqual([EXIT_USER_ERROR]);
  });
});
