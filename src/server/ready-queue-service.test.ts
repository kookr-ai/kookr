import { mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  READY_QUEUE_SCHEMA,
  type ReadyQueueGateInputs,
} from '../core/ready-queue.js';
import {
  ReadyQueueService,
  buildReadyQueueGateInputs,
  classifyReadyQueueDispatch,
  type ReadyQueueDispatchRequest,
  type ReadyQueueDispatchResponse,
} from './ready-queue-service.js';

const T0 = Date.parse('2026-11-16T10:00:00.000Z');

/**
 * A fake fleet: `capacity` slots, a set of running task ids, and a dispatcher
 * that behaves like POST /api/tasks with an idempotency ledger (a re-sent key
 * replays the task it already created).
 */
function makeFleet(capacity: number) {
  const running = new Set<string>();
  const byKey = new Map<string, string>();
  const launches: ReadyQueueDispatchRequest[] = [];
  let created = 0;
  const gates: ReadyQueueGateInputs = {
    accepting: true,
    automationEnabled: true,
    free: capacity,
    pendingQueueDepth: 0,
    loadPerCpu: 0.5,
    maxLoadPerCpu: 1.5,
  };
  const getGateInputs = (): ReadyQueueGateInputs => ({ ...gates, free: capacity - running.size });
  const dispatch = vi.fn(async (request: ReadyQueueDispatchRequest): Promise<ReadyQueueDispatchResponse> => {
    launches.push(request);
    const key = String(request.body.idempotencyKey);
    const replay = byKey.get(key);
    if (replay) return { status: 200, body: { id: replay, idempotentReplay: true } };
    created += 1;
    const id = `task-${created}`;
    byKey.set(key, id);
    running.add(id);
    return { status: 201, body: { id } };
  });
  return {
    running,
    launches,
    gates,
    getGateInputs,
    dispatch,
    createdCount: () => created,
    finish: (id: string) => running.delete(id),
  };
}

describe('ReadyQueueService', () => {
  let dir: string;
  let filePath: string;
  let now: number;
  let ids: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kookr-ready-queue-'));
    filePath = join(dir, 'ready-queue.json');
    now = T0;
    ids = 0;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function makeService(
    fleet: ReturnType<typeof makeFleet>,
    extra: { emitAlert?: (alert: unknown) => void } = {},
  ): Promise<ReadyQueueService> {
    const service = new ReadyQueueService({
      filePath,
      getGateInputs: fleet.getGateInputs,
      now: () => now,
      log: () => undefined,
      newId: () => `e${String(++ids).padStart(2, '0')}`,
      ...(extra.emitAlert ? { emitAlert: extra.emitAlert as never } : {}),
    });
    await service.load();
    service.setDispatcher(fleet.dispatch);
    return service;
  }

  async function enqueue(service: ReadyQueueService, n: number): Promise<void> {
    for (let i = 1; i <= n; i += 1) {
      await service.enqueue({ request: { prompt: `job ${i}`, cwd: '/repo' }, launchSource: 'cli' });
      now += 1_000;
    }
  }

  async function tickEvery30s(service: ReadyQueueService, ticks: number): Promise<void> {
    for (let i = 0; i < ticks; i += 1) {
      now += 30_000;
      await service.tick();
    }
  }

  it('ten queued launches with two free slots: two start, the rest one by one as slots free, in order', async () => {
    const fleet = makeFleet(2);
    const service = await makeService(fleet);
    await enqueue(service, 10);

    // One entry per tick: the first two ticks fill both slots, then nothing.
    await tickEvery30s(service, 5);
    expect(fleet.launches.map((l) => l.body.prompt)).toEqual(['job 1', 'job 2']);
    expect(service.getHealthSnapshot()).toMatchObject({
      queued: 8,
      head: { waitReason: 'no_free_slot', waiting: 'waiting: no free slot' },
    });

    // Each freed slot lets exactly the next entry in.
    for (let started = 2; started < 10; started += 1) {
      fleet.finish(`task-${started - 1}`);
      await tickEvery30s(service, 3);
      expect(fleet.launches).toHaveLength(started + 1);
    }
    expect(fleet.launches.map((l) => l.body.prompt)).toEqual(
      Array.from({ length: 10 }, (_, i) => `job ${i + 1}`),
    );
    expect(service.list().map((entry) => [entry.state, entry.taskId])).toEqual(
      Array.from({ length: 10 }, (_, i) => ['started', `task-${i + 1}`]),
    );
    expect(service.getHealthSnapshot()).toMatchObject({ queued: 0, head: null, stalled: false });
  });

  it('keeps the reserved slots and waits while the overflow queue holds launches', async () => {
    const fleet = makeFleet(4);
    const service = new ReadyQueueService({
      filePath,
      getGateInputs: () => ({ ...fleet.getGateInputs(), free: 2, freeForGeneralSources: 0 }),
      now: () => now,
      log: () => undefined,
    });
    await service.load();
    service.setDispatcher(fleet.dispatch);
    await enqueue(service, 1);
    await tickEvery30s(service, 2);
    expect(fleet.dispatch).not.toHaveBeenCalled();
    expect(service.getHealthSnapshot().head?.waitReason).toBe('no_free_slot');

    const pendingService = new ReadyQueueService({
      filePath: join(dir, 'other.json'),
      getGateInputs: () => ({ ...fleet.getGateInputs(), pendingQueueDepth: 1 }),
      now: () => now,
      log: () => undefined,
    });
    await pendingService.load();
    pendingService.setDispatcher(fleet.dispatch);
    await enqueue(pendingService, 1);
    await tickEvery30s(pendingService, 2);
    expect(fleet.dispatch).not.toHaveBeenCalled();
  });

  it('load above the limit: nothing starts and health says "waiting: host load"', async () => {
    const fleet = makeFleet(4);
    fleet.gates.loadPerCpu = 1.8;
    const service = await makeService(fleet);
    await enqueue(service, 3);
    await tickEvery30s(service, 4);
    expect(fleet.dispatch).not.toHaveBeenCalled();
    const health = service.getHealthSnapshot();
    expect(health).toMatchObject({
      queued: 3,
      head: { id: 'e01', waitReason: 'host_load', waiting: 'waiting: host load' },
      stalled: false,
    });

    // Fifteen minutes on, the head is reported as stalled.
    now += 15 * 60_000;
    await service.tick();
    expect(service.getHealthSnapshot()).toMatchObject({ stalled: true, head: { waiting: 'waiting: host load' } });

    // Load drops: the queue resumes in order.
    fleet.gates.loadPerCpu = 1.0;
    await tickEvery30s(service, 1);
    expect(fleet.launches.map((l) => l.body.prompt)).toEqual(['job 1']);
  });

  it('does not start while draining or in SAFE MODE', async () => {
    const fleet = makeFleet(4);
    fleet.gates.accepting = false;
    const service = await makeService(fleet);
    await enqueue(service, 1);
    await tickEvery30s(service, 1);
    expect(service.getHealthSnapshot().head?.waiting).toBe('waiting: server draining for a deploy');
    fleet.gates.accepting = true;
    fleet.gates.automationEnabled = false;
    await tickEvery30s(service, 1);
    expect(service.getHealthSnapshot().head?.waitReason).toBe('automation_paused');
    expect(fleet.dispatch).not.toHaveBeenCalled();
  });

  it('a restart between ticks loses nothing and starts nothing twice', async () => {
    const fleet = makeFleet(1);
    const first = await makeService(fleet);
    await enqueue(first, 3);
    await tickEvery30s(first, 2);
    expect(fleet.launches).toHaveLength(1);
    await first.stop();

    const second = await makeService(fleet);
    expect(second.list().map((entry) => [entry.id, entry.state])).toEqual([
      ['e01', 'started'],
      ['e02', 'queued'],
      ['e03', 'queued'],
    ]);
    fleet.finish('task-1');
    await tickEvery30s(second, 2);
    fleet.finish('task-2');
    await tickEvery30s(second, 2);
    expect(fleet.launches.map((l) => l.body.prompt)).toEqual(['job 1', 'job 2', 'job 3']);
    expect(fleet.createdCount()).toBe(3);
  });

  it('a crash after the launch but before the state write re-sends the same key and starts nothing twice', async () => {
    const fleet = makeFleet(2);
    const service = await makeService(fleet);
    await enqueue(service, 1);
    await service.stop();

    // Simulate the crash: the server launched the task, but the file still
    // records the entry as being started.
    const file = JSON.parse(readFileSync(filePath, 'utf8'));
    const key = file.entries[0].idempotencyKey as string;
    await fleet.dispatch({ body: { ...file.entries[0].request, idempotencyKey: key }, launchSource: 'cli' });
    file.entries[0].state = 'launching';
    writeFileSync(filePath, JSON.stringify(file));
    expect(fleet.createdCount()).toBe(1);

    const restarted = await makeService(fleet);
    expect(restarted.list()[0].state).toBe('queued');
    await tickEvery30s(restarted, 1);
    expect(fleet.launches).toHaveLength(2);
    expect(fleet.launches[1].body.idempotencyKey).toBe(key);
    expect(fleet.createdCount()).toBe(1);
    expect(restarted.list()[0]).toMatchObject({ state: 'started', taskId: 'task-1' });
  });

  it('a launch failure is retried twice more, then marked failed and reported once', async () => {
    const fleet = makeFleet(4);
    const alerts: unknown[] = [];
    const service = await makeService(fleet, { emitAlert: (alert) => alerts.push(alert) });
    fleet.dispatch.mockImplementation(async (request) => {
      fleet.launches.push(request);
      return { status: 400, body: { error: 'cwd does not exist', code: 'cwd_not_found' } };
    });
    await enqueue(service, 2);

    await tickEvery30s(service, 1);
    expect(service.list()[0]).toMatchObject({ state: 'queued', attempts: 1, waitReason: 'launch_failed' });
    await tickEvery30s(service, 2);
    expect(service.list()[0]).toMatchObject({
      state: 'failed',
      attempts: 3,
      lastError: 'cwd does not exist',
      lastErrorCode: 'cwd_not_found',
      alerted: true,
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      type: 'alert',
      severity: 'warning',
      operationalAlert: { key: 'ready-queue:e01', metric: 'ready_queue_launch_failed', state: 'fired' },
    });
    // The failed head no longer blocks the queue; the next entry is tried.
    expect(fleet.launches.map((l) => l.body.prompt)).toEqual(['job 1', 'job 1', 'job 1']);
    await tickEvery30s(service, 1);
    expect(fleet.launches.at(-1)?.body.prompt).toBe('job 2');

    // A restart does not resend the alert for the entry already failed.
    await service.stop();
    const restarted = await makeService(fleet, { emitAlert: (alert) => alerts.push(alert) });
    expect(restarted.list()[0]).toMatchObject({ state: 'failed', alerted: true });
    expect(alerts).toHaveLength(1);
  });

  it('a thrown dispatch counts as a failed attempt', async () => {
    const fleet = makeFleet(4);
    const service = await makeService(fleet);
    fleet.dispatch.mockImplementation(async () => {
      throw new Error('boom');
    });
    await enqueue(service, 1);
    await tickEvery30s(service, 1);
    expect(service.list()[0]).toMatchObject({ state: 'queued', attempts: 1, lastError: 'boom' });
  });

  it('a "retry after" refusal waits that long and does not count as an attempt', async () => {
    const fleet = makeFleet(4);
    const service = await makeService(fleet);
    let refuse = true;
    const original = fleet.dispatch.getMockImplementation()!;
    fleet.dispatch.mockImplementation(async (request) => {
      if (!refuse) return original(request);
      fleet.launches.push(request);
      return {
        status: 503,
        retryAfterSeconds: 90,
        body: { error: 'event loop saturated', code: 'event_loop_saturated' },
      };
    });
    await enqueue(service, 1);
    await tickEvery30s(service, 1);
    expect(service.list()[0]).toMatchObject({ state: 'queued', attempts: 0, lastErrorCode: 'event_loop_saturated' });
    refuse = false;
    // 30s and 60s later: still inside the 90s Retry-After window.
    await tickEvery30s(service, 2);
    expect(fleet.launches).toHaveLength(1);
    expect(service.getHealthSnapshot().head?.waitReason).toBe('retry_after');
    await tickEvery30s(service, 1);
    expect(fleet.launches).toHaveLength(2);
    expect(service.list()[0]).toMatchObject({ state: 'started', attempts: 0 });
  });

  describe('a head that keeps getting the same "retry later" refusal (#3968)', () => {
    type Refusal = { status: number; retryAfterSeconds?: number; body: Record<string, unknown> } | null;

    /** Answer every launch with `refusal.current`, or launch normally once it is null. */
    function refuseWith(fleet: ReturnType<typeof makeFleet>, initial: Refusal) {
      const refusal = { current: initial };
      const original = fleet.dispatch.getMockImplementation()!;
      fleet.dispatch.mockImplementation(async (request) => {
        if (!refusal.current) return original(request);
        fleet.launches.push(request);
        return refusal.current;
      });
      return refusal;
    }

    const authPreflight: Refusal = {
      status: 503,
      body: { error: 'grok auth preflight failed', code: 'grok_auth_preflight' },
    };

    function refusedAlerts(alerts: unknown[]): unknown[] {
      return alerts.filter((alert) => (alert as { operationalAlert?: { metric?: string } })
        .operationalAlert?.metric === 'ready_queue_head_refused');
    }

    it('sends one alert once the head has been refused with the same code for 15 minutes', async () => {
      const fleet = makeFleet(4);
      const alerts: unknown[] = [];
      const service = await makeService(fleet, { emitAlert: (alert) => alerts.push(alert) });
      refuseWith(fleet, authPreflight);
      await enqueue(service, 3);

      // First refusal at tick 1; 29 ticks later the run has lasted 14.5 minutes.
      await tickEvery30s(service, 30);
      expect(alerts).toHaveLength(0);
      await tickEvery30s(service, 1);
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({
        type: 'alert',
        severity: 'warning',
        summary: 'Ready queue: launch e01 has been refused (grok_auth_preflight) for 15 minutes; 2 entries wait behind it',
        operationalAlert: { key: 'ready-queue-refused:e01', metric: 'ready_queue_head_refused', state: 'fired' },
      });
      expect((alerts[0] as { details: string }).details).toContain('grok auth preflight failed');
      expect((alerts[0] as { details: string }).details).toContain('kookr queue remove e01');

      // An hour more of the same refusal: no second alert, and the head still holds the queue.
      await tickEvery30s(service, 120);
      expect(alerts).toHaveLength(1);
      expect(new Set(fleet.launches.map((l) => l.body.prompt))).toEqual(new Set(['job 1']));
      expect(service.list()[0]).toMatchObject({ state: 'queued', attempts: 0 });
    });

    it('stays silent when the refusal clears before 15 minutes', async () => {
      const fleet = makeFleet(4);
      const alerts: unknown[] = [];
      const service = await makeService(fleet, { emitAlert: (alert) => alerts.push(alert) });
      const refusal = refuseWith(fleet, authPreflight);
      await enqueue(service, 1);
      await tickEvery30s(service, 29);
      refusal.current = null;
      await tickEvery30s(service, 5);
      expect(service.list()[0]).toMatchObject({ state: 'started' });
      expect(alerts).toHaveLength(0);
    });

    it('a different refusal code starts a new run', async () => {
      const fleet = makeFleet(4);
      const alerts: unknown[] = [];
      const service = await makeService(fleet, { emitAlert: (alert) => alerts.push(alert) });
      const refusal = refuseWith(fleet, authPreflight);
      await enqueue(service, 1);
      await tickEvery30s(service, 29);
      refusal.current = { status: 429, body: { error: 'quota exceeded', code: 'quota_exceeded' } };
      // The new code's first refusal starts the run; 14.5 minutes later, still silent
      // although the head has been refused for over 28 minutes in all.
      await tickEvery30s(service, 30);
      expect(alerts).toHaveLength(0);
      await tickEvery30s(service, 1);
      expect(refusedAlerts(alerts)).toHaveLength(1);
      expect((alerts[0] as { summary: string }).summary).toContain('(quota_exceeded)');
    });

    it('alerts on a 429 with no code and no Retry-After', async () => {
      const fleet = makeFleet(4);
      const alerts: unknown[] = [];
      const service = await makeService(fleet, { emitAlert: (alert) => alerts.push(alert) });
      refuseWith(fleet, { status: 429, body: {} });
      await enqueue(service, 1);
      await tickEvery30s(service, 31);
      expect(refusedAlerts(alerts)).toHaveLength(1);
      expect((alerts[0] as { summary: string }).summary)
        .toBe('Ready queue: launch e01 has been refused (retry_after) for 15 minutes; 0 entries wait behind it');
      expect((alerts[0] as { details: string }).details).toContain('HTTP 429');
    });

    it('a long Retry-After still alerts on the second refusal', async () => {
      const fleet = makeFleet(4);
      const alerts: unknown[] = [];
      const service = await makeService(fleet, { emitAlert: (alert) => alerts.push(alert) });
      refuseWith(fleet, { status: 503, retryAfterSeconds: 20 * 60, body: { error: 'quota', code: 'quota_exceeded' } });
      await enqueue(service, 1);
      await tickEvery30s(service, 1);
      expect(fleet.launches).toHaveLength(1);
      // The wait ticks during the 20-minute Retry-After neither alert nor end the run.
      await tickEvery30s(service, 39);
      expect(fleet.launches).toHaveLength(1);
      expect(alerts).toHaveLength(0);
      await tickEvery30s(service, 1);
      expect(fleet.launches).toHaveLength(2);
      expect(refusedAlerts(alerts)).toHaveLength(1);
      expect((alerts[0] as { summary: string }).summary).toContain('for 20 minutes');
    });

    it('a failed alert channel does not break the tick', async () => {
      const fleet = makeFleet(4);
      const service = await makeService(fleet, {
        emitAlert: () => {
          throw new Error('alert sink down');
        },
      });
      const refusal = refuseWith(fleet, authPreflight);
      await enqueue(service, 1);
      await tickEvery30s(service, 31);
      refusal.current = null;
      await tickEvery30s(service, 1);
      expect(service.list()[0]).toMatchObject({ state: 'started' });
    });

    it('an entry that got the refused alert and then fails three times still gets the failed alert', async () => {
      const fleet = makeFleet(4);
      const alerts: unknown[] = [];
      const service = await makeService(fleet, { emitAlert: (alert) => alerts.push(alert) });
      const refusal = refuseWith(fleet, authPreflight);
      await enqueue(service, 1);
      await tickEvery30s(service, 31);
      expect(refusedAlerts(alerts)).toHaveLength(1);
      refusal.current = { status: 400, body: { error: 'cwd does not exist', code: 'cwd_not_found' } };
      await tickEvery30s(service, 3);
      expect(service.list()[0]).toMatchObject({ state: 'failed', attempts: 3 });
      expect(alerts).toHaveLength(2);
      expect(alerts[1]).toMatchObject({
        operationalAlert: { key: 'ready-queue:e01', metric: 'ready_queue_launch_failed', state: 'fired' },
      });
    });

    it('is not persisted: after a restart the alert can fire once more if the refusal persists', async () => {
      const fleet = makeFleet(4);
      const alerts: unknown[] = [];
      const service = await makeService(fleet, { emitAlert: (alert) => alerts.push(alert) });
      refuseWith(fleet, authPreflight);
      await enqueue(service, 1);
      await tickEvery30s(service, 31);
      expect(refusedAlerts(alerts)).toHaveLength(1);
      await service.stop();

      const restarted = await makeService(fleet, { emitAlert: (alert) => alerts.push(alert) });
      await tickEvery30s(restarted, 30);
      expect(refusedAlerts(alerts)).toHaveLength(1);
      await tickEvery30s(restarted, 1);
      expect(refusedAlerts(alerts)).toHaveLength(2);
    });
  });

  it('enqueue is idempotent on the request key and remove refuses an entry being started', async () => {
    const fleet = makeFleet(4);
    const service = await makeService(fleet);
    const a = await service.enqueue({ request: { prompt: 'p', cwd: '/r', idempotencyKey: 'k1' }, launchSource: 'cli' });
    const b = await service.enqueue({ request: { prompt: 'p', cwd: '/r', idempotencyKey: 'k1' }, launchSource: 'cli' });
    expect(a.created).toBe(true);
    expect(b).toMatchObject({ created: false, entry: { id: a.entry.id } });
    expect(service.list()).toHaveLength(1);

    let release!: () => void;
    fleet.dispatch.mockImplementation(() => new Promise((resolve) => {
      release = () => resolve({ status: 201, body: { id: 'task-x' } });
    }));
    now += 30_000;
    const ticking = service.tick();
    await vi.waitFor(() => expect(fleet.dispatch).toHaveBeenCalled());
    expect(await service.remove(a.entry.id)).toBe('launching');
    release();
    await ticking;
    expect(await service.remove(a.entry.id)).toBe('removed');
    expect(await service.remove(a.entry.id)).toBe('not_found');
    expect(JSON.parse(readFileSync(filePath, 'utf8')).entries).toEqual([]);
  });

  it('prunes started entries after 24 hours', async () => {
    const fleet = makeFleet(4);
    const service = await makeService(fleet);
    await enqueue(service, 1);
    await tickEvery30s(service, 1);
    expect(service.list()[0].state).toBe('started');
    now += 24 * 60 * 60_000;
    await service.tick();
    expect(service.list()).toEqual([]);
  });

  it('moves an unreadable queue file aside instead of overwriting it', async () => {
    writeFileSync(filePath, '{not json');
    const fleet = makeFleet(1);
    const service = await makeService(fleet);
    expect(service.list()).toEqual([]);
    expect(readdirSync(dir).some((name) => name.startsWith('ready-queue.json.corrupt-'))).toBe(true);
    await enqueue(service, 1);
    expect(JSON.parse(readFileSync(filePath, 'utf8')).schema).toBe(READY_QUEUE_SCHEMA);
  });
});

describe('classifyReadyQueueDispatch', () => {
  it('treats 2xx as started, including a replay or a dedup to an existing task', () => {
    expect(classifyReadyQueueDispatch({ status: 201, body: { id: 't1' } })).toEqual({ kind: 'started', taskId: 't1' });
    expect(classifyReadyQueueDispatch({ status: 200, body: { task: { id: 't2' }, duplicate: true } }))
      .toEqual({ kind: 'started', taskId: 't2' });
    expect(classifyReadyQueueDispatch({ status: 201, body: {} }).kind).toBe('failed');
  });

  it('treats 429 and 503 as "retry later", mapping the code to a wait reason', () => {
    expect(classifyReadyQueueDispatch({ status: 429, body: { error: 'x', code: 'host_load_admission' } }))
      .toMatchObject({ kind: 'refused', reason: 'host_load' });
    expect(classifyReadyQueueDispatch({ status: 503, retryAfterSeconds: 5, body: { error: 'x', code: 'draining' } }))
      .toMatchObject({ kind: 'refused', reason: 'draining', retryAfterMs: 5_000 });
    expect(classifyReadyQueueDispatch({ status: 429, body: { error: 'x', code: 'pending_queue_full' } }))
      .toMatchObject({ kind: 'refused', reason: 'no_free_slot' });
    expect(classifyReadyQueueDispatch({ status: 429, body: { error: 'x', code: 'spawn_burst_limit', retryAfterMs: 4_000 } }))
      .toMatchObject({ kind: 'refused', reason: 'retry_after', retryAfterMs: 4_000 });
  });

  it('treats any other status as a failed attempt', () => {
    expect(classifyReadyQueueDispatch({ status: 409, body: { error: 'claim held', code: 'issue_claim_held' } }))
      .toEqual({ kind: 'failed', error: 'claim held', code: 'issue_claim_held' });
    expect(classifyReadyQueueDispatch({ status: 500, body: null })).toEqual({ kind: 'failed', error: 'HTTP 500' });
  });
});

describe('buildReadyQueueGateInputs', () => {
  const base = {
    accepting: true,
    automationKillSwitch: false,
    settingsLoadError: false,
    ledger: { free: 3, freeForGeneralSources: 1, pendingQueueDepth: 2 },
    load1m: 24,
    cpuCount: 16,
    maxLoadPerCpu: 1.5,
  };

  it('maps the live state onto the gates', () => {
    expect(buildReadyQueueGateInputs(base)).toEqual({
      accepting: true,
      automationEnabled: true,
      free: 3,
      freeForGeneralSources: 1,
      pendingQueueDepth: 2,
      loadPerCpu: 1.5,
      maxLoadPerCpu: 1.5,
    });
  });

  it('treats SAFE MODE and a settings load error as automation off', () => {
    expect(buildReadyQueueGateInputs({ ...base, automationKillSwitch: true }).automationEnabled).toBe(false);
    expect(buildReadyQueueGateInputs({ ...base, settingsLoadError: true }).automationEnabled).toBe(false);
    expect(buildReadyQueueGateInputs({ ...base, accepting: false }).accepting).toBe(false);
  });

  it('omits the reserved-slot view when the ledger has none, and has no load sample without CPUs', () => {
    const gates = buildReadyQueueGateInputs({ ...base, ledger: { free: 2, pendingQueueDepth: 0 }, cpuCount: 0 });
    expect(gates).not.toHaveProperty('freeForGeneralSources');
    expect(gates.loadPerCpu).toBeNull();
  });
});
