import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AttentionQueue } from '../../core/attention-queue.js';
import { Monitor } from '../../core/monitor.js';
import { TaskStore } from '../../core/tasks.js';
import type { ReadyQueueGateInputs } from '../../core/ready-queue.js';
import { ReadyQueueService } from '../ready-queue-service.js';
import type { TaskRouteDeps } from './shared.js';

vi.mock('../launch-service.js', async (importActual) => {
  const actual = await importActual<typeof import('../launch-service.js')>();
  return { ...actual, launchTask: vi.fn() };
});

import { DrainModeError, launchTask } from '../launch-service.js';
import { registerReadyQueueRoutes } from './ready-queue-routes.js';
import { registerTaskRoutes } from './task-routes.js';

const OPEN_GATES: ReadyQueueGateInputs = {
  accepting: true,
  automationEnabled: true,
  free: 4,
  pendingQueueDepth: 0,
  loadPerCpu: 0.2,
  maxLoadPerCpu: 1.5,
};

describe('ready-queue routes wired to the POST /api/tasks handler (issue #3933)', () => {
  let dir: string;
  let taskStore: TaskStore;
  let readyQueue: ReadyQueueService;
  let app: Hono;
  let p95Ms: number | null;

  beforeEach(async () => {
    vi.mocked(launchTask).mockReset();
    dir = mkdtempSync(join(tmpdir(), 'kookr-ready-queue-routes-'));
    taskStore = new TaskStore();
    p95Ms = null;
    readyQueue = new ReadyQueueService({
      filePath: join(dir, 'ready-queue.json'),
      getGateInputs: () => OPEN_GATES,
      log: () => undefined,
    });
    await readyQueue.load();
    const monitor = new Monitor(taskStore, new AttentionQueue());
    const deps = {
      taskStore,
      monitor,
      queue: new AttentionQueue(),
      broadcastToAll: () => undefined,
      serverCwd: '/server',
      launchServiceDeps: { taskStore, adapterRegistry: {}, lifecycleDeps: {} } as never,
      adapter: {} as never,
      readyQueue,
      admissionControlConfig: { eventLoopDelayThresholdMs: 1_000, retryAfterSeconds: 7 },
      getLatestResourceStatus: () => (p95Ms === null
        ? null
        : { server: { eventLoopDelayP95Ms: p95Ms } }) as never,
    } as unknown as TaskRouteDeps;
    app = new Hono();
    registerTaskRoutes(app, deps);
    registerReadyQueueRoutes(app, { readyQueue });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function postQueue(body: unknown, headers: Record<string, string> = {}) {
    return app.request('/api/ready-queue', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  }

  it('stores a launch without starting it, then the tick starts it through POST /api/tasks', async () => {
    vi.mocked(launchTask).mockImplementation(async (_deps, opts) => ({
      task: taskStore.createTask(opts.prompt, opts.cwd),
      queued: false,
    }));
    const res = await postQueue(
      { prompt: 'fix it', cwd: '/repo', idempotencyKey: 'queue-k1' },
      { 'X-Kookr-Launch-Source': 'cli', 'X-Kookr-Actor': 'lucy' },
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ created: true, position: 1, entry: { state: 'queued', idempotencyKey: 'queue-k1' } });
    expect(launchTask).not.toHaveBeenCalled();
    expect(taskStore.viewTasks()).toHaveLength(0);

    await readyQueue.tick();
    expect(launchTask).toHaveBeenCalledTimes(1);
    expect(vi.mocked(launchTask).mock.calls[0][1]).toMatchObject({
      prompt: 'fix it',
      cwd: '/repo',
      idempotencyKey: 'queue-k1',
      launchSource: 'cli',
      launchActorId: 'lucy',
    });
    const [task] = taskStore.viewTasks();
    const list = await (await app.request('/api/ready-queue')).json();
    expect(list.entries).toEqual([expect.objectContaining({ state: 'started', taskId: task.id, attempts: 0 })]);
    expect(list.health).toMatchObject({ queued: 0, head: null });
  });

  it('a re-sent enqueue with the same key returns the stored entry (200), not a second one', async () => {
    expect((await postQueue({ prompt: 'p', cwd: '/r', idempotencyKey: 'same' })).status).toBe(201);
    const again = await postQueue({ prompt: 'p', cwd: '/r', idempotencyKey: 'same' });
    expect(again.status).toBe(200);
    expect((await again.json()).created).toBe(false);
    expect(readyQueue.list()).toHaveLength(1);
  });

  it('rejects a body with no cwd or no prompt', async () => {
    expect((await postQueue({ prompt: 'p' })).status).toBe(400);
    expect((await postQueue({ cwd: '/r' })).status).toBe(400);
    expect((await postQueue([1])).status).toBe(400);
  });

  it('the event-loop admission 503 makes the entry wait for Retry-After, without an attempt', async () => {
    p95Ms = 5_000;
    await postQueue({ prompt: 'p', cwd: '/r' });
    await readyQueue.tick();
    expect(launchTask).not.toHaveBeenCalled();
    const [entry] = readyQueue.list();
    expect(entry).toMatchObject({ state: 'queued', attempts: 0, waitReason: 'retry_after', lastErrorCode: 'event_loop_saturated' });
    const waitMs = Date.parse(entry.notBefore!) - Date.now();
    expect(waitMs).toBeGreaterThan(5_000);
    expect(waitMs).toBeLessThanOrEqual(7_000);
  });

  it('a drain refusal from the launch path reads as "server draining"', async () => {
    vi.mocked(launchTask).mockRejectedValue(new DrainModeError());
    await postQueue({ prompt: 'p', cwd: '/r' });
    await readyQueue.tick();
    expect(readyQueue.list()[0]).toMatchObject({ state: 'queued', attempts: 0, waitReason: 'draining' });
  });

  it('a validation error from the real handler counts as a failed attempt', async () => {
    await postQueue({ prompt: 'p', cwd: '/r', effort: 42 });
    await readyQueue.tick();
    expect(launchTask).not.toHaveBeenCalled();
    expect(readyQueue.list()[0]).toMatchObject({ state: 'queued', attempts: 1, lastError: 'effort must be a string' });
  });

  it('DELETE removes an entry and answers 404 for an unknown id', async () => {
    const created = await (await postQueue({ prompt: 'p', cwd: '/r' })).json();
    const del = await app.request(`/api/ready-queue/${created.entry.id}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect(readyQueue.list()).toEqual([]);
    expect((await app.request('/api/ready-queue/nope', { method: 'DELETE' })).status).toBe(404);
  });
});
