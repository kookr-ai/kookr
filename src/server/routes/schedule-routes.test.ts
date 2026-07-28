import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ScheduleStore } from '../../core/schedule.js';
import { ScheduleService } from '../schedule-service.js';
import { ScheduleValidator } from '../schedule-validator.js';
import { registerScheduleRoutes } from './schedule-routes.js';
import type { RouteDeps } from './shared.js';

const INVALID_PLAYBOOK_PATH_ERROR = 'Playbook path must stay inside the selected playbooks directory';

function mkApp(deps: Partial<RouteDeps>): Hono {
  const app = new Hono();
  registerScheduleRoutes(app, deps as unknown as RouteDeps);
  return app;
}

async function seedSchedule(service: ScheduleService, cwd: string, name = 'Daily review') {
  return service.createDefinition({
    name,
    cron: '0 9 * * *',
    cwd,
    playbook: { path: 'daily.md', parameters: {} },
  });
}

function writePlaybook(cwd: string): void {
  mkdirSync(join(cwd, '.kookr', 'playbooks'), { recursive: true });
  writeFileSync(join(cwd, '.kookr', 'playbooks', 'daily.md'), `---
name: Daily review
parameters: []
---
Do the daily review.
`);
}

describe('schedule routes', () => {
  let tempDir: string;
  let store: ScheduleStore;
  let service: ScheduleService;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'sched-routes-test-'));
    store = new ScheduleStore(tempDir);
    service = new ScheduleService({ store, validator: new ScheduleValidator() });
    writePlaybook(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('GET /api/schedules', () => {
    test('returns persisted execution ledger entries', async () => {
      const schedule = await seedSchedule(service, tempDir);
      const evaluatedAt = '2026-01-01T09:00:00.000Z';
      store.replace({
        ...store.get(schedule.id)!,
        executionLedger: [
          {
            id: `${schedule.id}:cron:${evaluatedAt}`,
            scheduleId: schedule.id,
            trigger: 'cron',
            decision: 'stale_catch_up',
            scheduledFor: evaluatedAt,
            evaluatedAt,
            completedAt: '2026-01-02T09:00:00.000Z',
            outcome: 'skipped_stale',
            reasonCode: 'stale_catch_up',
            message: 'Due run is outside the catch-up window',
          },
        ],
      });

      const res = await mkApp({ scheduleService: service }).request('/api/schedules');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.schedules[0].executionLedger).toEqual([
        expect.objectContaining({
          decision: 'stale_catch_up',
          outcome: 'skipped_stale',
          reasonCode: 'stale_catch_up',
        }),
      ]);
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/schedules/:id/rollup + /api/schedules/rollups (issue #1584)
  // ---------------------------------------------------------------------------
  describe('rollup endpoints', () => {
    function seedLedger(scheduleId: string) {
      store.replace({
        ...store.get(scheduleId)!,
        executionLedger: [
          {
            id: `${scheduleId}:cron:a`, scheduleId, trigger: 'cron', decision: 'cron_due',
            evaluatedAt: '2026-02-01T09:00:00.000Z', completedAt: '2026-02-01T09:05:00.000Z',
            outcome: 'completed',
            tokenUsage: { inputTokens: 100, outputTokens: 40, cacheReadTokens: 10, cacheWriteTokens: 0, costUsd: 0.25 },
            artifacts: ['https://github.com/o/r/pull/1'],
          },
          {
            id: `${scheduleId}:cron:b`, scheduleId, trigger: 'cron', decision: 'cron_due',
            evaluatedAt: '2026-02-01T10:00:00.000Z', completedAt: '2026-02-01T10:02:00.000Z',
            outcome: 'dispatch_failed',
          },
        ],
      });
    }

    test('GET /api/schedules/:id/rollup matches a manual recount of the ledger', async () => {
      const schedule = await seedSchedule(service, tempDir);
      seedLedger(schedule.id);

      const res = await mkApp({ scheduleService: service }).request(`/api/schedules/${schedule.id}/rollup`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({
        scheduleId: schedule.id,
        fires: 2,
        outcomes: { completed: 1, dispatch_failed: 1 },
        measuredFires: 1,
        costUsd: 0.25,
        tokens: 150,
        artifacts: 1,
        windowStart: '2026-02-01T09:00:00.000Z',
        windowEnd: '2026-02-01T10:02:00.000Z',
      });
    });

    test('performs NO on-request scan — responds with taskStore/hookWatcher absent from deps', async () => {
      const schedule = await seedSchedule(service, tempDir);
      seedLedger(schedule.id);

      // The app is built with ONLY scheduleService wired — no taskStore, no
      // hookWatcher, no tasksFile. A handler that scanned tasks.json/hook logs
      // would need one of those; this proves the rollup path reads only the
      // materialized store.
      const start = Date.now();
      const res = await mkApp({ scheduleService: service }).request(`/api/schedules/${schedule.id}/rollup`);
      const elapsed = Date.now() - start;
      expect(res.status).toBe(200);
      expect(elapsed).toBeLessThan(500);
    });

    test('GET /api/schedules/:id/rollup returns 404 for an unknown schedule', async () => {
      const res = await mkApp({ scheduleService: service }).request('/api/schedules/does-not-exist/rollup');
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Schedule not found' });
    });

    test('GET /api/schedules/:id/rollup returns 500 when scheduling is not configured', async () => {
      const res = await mkApp({}).request('/api/schedules/x/rollup');
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Scheduling not configured' });
    });

    test('GET /api/schedules/rollups returns the fleet-wide list', async () => {
      const a = await seedSchedule(service, tempDir, 'A');
      const b = await seedSchedule(service, tempDir, 'B');
      seedLedger(a.id);

      const res = await mkApp({ scheduleService: service }).request('/api/schedules/rollups');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.rollups).toHaveLength(2);
      const byId = new Map<string, { scheduleId: string; fires: number }>(
        body.rollups.map((r: { scheduleId: string; fires: number }) => [r.scheduleId, r]),
      );
      expect(byId.get(a.id)!.fires).toBe(2);
      expect(byId.get(b.id)!.fires).toBe(0);
    });

    test('GET /api/schedules/rollups returns empty when scheduling is not configured', async () => {
      const res = await mkApp({}).request('/api/schedules/rollups');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ rollups: [] });
    });
  });

  // ---------------------------------------------------------------------------
  // POST /api/schedules
  // ---------------------------------------------------------------------------
  describe('POST /api/schedules', () => {
    test('rejects cron expressions that fire more often than every five minutes', async () => {
      const res = await mkApp({ scheduleService: service }).request(
        '/api/schedules',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'Too fast',
            cron: '* * * * *',
            cwd: tempDir,
            playbook: { path: 'daily.md', parameters: {} },
          }),
        },
      );

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: 'Invalid schedule definition',
        fieldErrors: {
          cron: 'Cron expression must not fire more often than every 5 minutes',
        },
      });
    });

    test('rejects traversal playbook paths without creating a schedule', async () => {
      writeFileSync(join(tempDir, 'escape.md'), `---
name: Escape
parameters: []
---
Do not schedule.
`);

      const res = await mkApp({ scheduleService: service }).request(
        '/api/schedules',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'Traversal',
            cron: '0 9 * * *',
            cwd: tempDir,
            playbook: { path: '../../escape.md', parameters: {} },
          }),
        },
      );

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: 'Invalid schedule definition',
        fieldErrors: { playbook: INVALID_PLAYBOOK_PATH_ERROR },
      });
      expect(store.list()).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // PATCH /api/schedules/:id
  // ---------------------------------------------------------------------------
  describe('PATCH /api/schedules/:id', () => {
    test('rejects cron expressions that fire more often than every five minutes', async () => {
      const schedule = await seedSchedule(service, tempDir);
      const res = await mkApp({ scheduleService: service }).request(
        `/api/schedules/${schedule.id}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cron: '0,1 * * * *' }),
        },
      );

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: 'Invalid schedule definition',
        fieldErrors: {
          cron: 'Cron expression must not fire more often than every 5 minutes',
        },
      });
    });

    test('rejects absolute playbook paths without mutating the schedule', async () => {
      const schedule = await seedSchedule(service, tempDir);
      const escaped = join(tempDir, 'absolute.md');
      writeFileSync(escaped, `---
name: Absolute
parameters: []
---
Do not schedule.
`);

      const res = await mkApp({ scheduleService: service }).request(
        `/api/schedules/${schedule.id}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            playbook: { path: escaped, parameters: {} },
          }),
        },
      );

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: 'Invalid schedule definition',
        fieldErrors: { playbook: INVALID_PLAYBOOK_PATH_ERROR },
      });
      expect(store.get(schedule.id)?.playbook.path).toBe('daily.md');
    });
  });

  // ---------------------------------------------------------------------------
  // DELETE /api/schedules/:id
  // ---------------------------------------------------------------------------
  describe('DELETE /api/schedules/:id', () => {
    test('deletes an existing schedule and returns {ok:true}', async () => {
      const schedule = await seedSchedule(service, tempDir);
      expect(store.list()).toHaveLength(1);

      const res = await mkApp({ scheduleService: service }).request(
        `/api/schedules/${schedule.id}`,
        { method: 'DELETE' },
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(store.list()).toHaveLength(0);
    });

    test('returns 404 when the schedule id is unknown', async () => {
      const res = await mkApp({ scheduleService: service }).request(
        '/api/schedules/does-not-exist',
        { method: 'DELETE' },
      );
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Schedule not found' });
    });

    test('returns 500 when scheduling is not configured', async () => {
      const res = await mkApp({}).request('/api/schedules/anything', { method: 'DELETE' });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Scheduling not configured' });
    });
  });

  // ---------------------------------------------------------------------------
  // POST /api/schedules/:id/run
  // ---------------------------------------------------------------------------
  describe('POST /api/schedules/:id/run', () => {
    test('returns {ok:true, taskId} when the runner fires the schedule', async () => {
      const scheduleRunner = {
        runNow: async (id: string) => ({ taskId: `task-for-${id}` }),
      };
      const res = await mkApp({ scheduleRunner: scheduleRunner as never })
        .request('/api/schedules/sched-1/run', { method: 'POST' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, taskId: 'task-for-sched-1' });
    });

    test('surfaces runner queued flag', async () => {
      const scheduleRunner = {
        runNow: async () => ({ taskId: 'task-q', queued: true }),
      };
      const res = await mkApp({ scheduleRunner: scheduleRunner as never })
        .request('/api/schedules/sched-1/run', { method: 'POST' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.queued).toBe(true);
    });

    test('returns 400 when the runner reports an error', async () => {
      const scheduleRunner = {
        runNow: async () => ({ error: 'Schedule not found' }),
      };
      const res = await mkApp({ scheduleRunner: scheduleRunner as never })
        .request('/api/schedules/missing/run', { method: 'POST' });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Schedule not found', code: 'validation' });
    });

    test('returns 500 when the runner is not wired', async () => {
      const res = await mkApp({}).request('/api/schedules/x/run', { method: 'POST' });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Scheduling not configured' });
    });
  });

  // ---------------------------------------------------------------------------
  // POST /api/schedules/preview
  // ---------------------------------------------------------------------------
  describe('POST /api/schedules/preview', () => {
    test('returns the next-run preview for a valid cron', async () => {
      const res = await mkApp({ scheduleService: service }).request(
        '/api/schedules/preview',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cron: '0 9 * * *' }),
        },
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.cronDescription).toEqual(expect.any(String));
      expect(Array.isArray(body.nextRuns)).toBe(true);
      expect(body.nextRuns.length).toBeGreaterThan(0);
      expect(body.timezone).toEqual(expect.any(String));
    });

    test('returns 400 when the cron field is missing', async () => {
      const res = await mkApp({ scheduleService: service }).request(
        '/api/schedules/preview',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        },
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'cron is required' });
    });

    test('returns 400 when the cron expression is invalid', async () => {
      const res = await mkApp({ scheduleService: service }).request(
        '/api/schedules/preview',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cron: 'not a cron' }),
        },
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('Invalid');
    });

    test('returns 400 when the cron expression fires too often', async () => {
      const res = await mkApp({ scheduleService: service }).request(
        '/api/schedules/preview',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cron: '* * * * *' }),
        },
      );

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: 'Invalid cron expression',
        fieldErrors: {
          cron: 'Cron expression must not fire more often than every 5 minutes',
        },
      });
    });

    test('returns 500 when scheduling is not configured', async () => {
      const res = await mkApp({}).request('/api/schedules/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cron: '0 9 * * *' }),
      });
      expect(res.status).toBe(500);
    });
  });
});
