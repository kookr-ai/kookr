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
      expect(await res.json()).toEqual({ error: 'Schedule not found' });
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
