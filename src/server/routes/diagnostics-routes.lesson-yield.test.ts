/**
 * Lesson-yield scan scheduling contract for the diagnostics routes
 * (issue #1553, prod OOM of 2026-07-26).
 *
 * `computeLessonYield` is mocked so scan timing is controlled precisely:
 * these tests pin the properties that keep the health hot path safe —
 * never awaited on the request path, single-flight, failure backoff, and
 * a 503 (not a hang) when the bounded scan times out.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { TaskStore } from '../../core/tasks.js';
import { AttentionQueue } from '../../core/attention-queue.js';
import { registerDiagnosticsRoutes } from './diagnostics-routes.js';
import type { RouteDeps } from './shared.js';
import {
  computeLessonYield,
  LESSON_YIELD_SCHEMA_VERSION,
  type LessonYieldSnapshot,
} from '../../core/lesson-decision.js';

vi.mock('../../core/lesson-decision.js', async (importActual) => {
  const actual = await importActual<typeof import('../../core/lesson-decision.js')>();
  return { ...actual, computeLessonYield: vi.fn() };
});

const scanMock = vi.mocked(computeLessonYield);

function mkApp(deps: Partial<RouteDeps>): Hono {
  const app = new Hono();
  registerDiagnosticsRoutes(app, deps as unknown as RouteDeps);
  return app;
}

function baseDeps(): Partial<RouteDeps> {
  return {
    taskStore: new TaskStore(),
    queue: new AttentionQueue(),
    buildInfo: {} as never,
    kookrDir: '/nonexistent/kookr-dir-for-mocked-scans',
  };
}

function snapshot(overrides: Partial<LessonYieldSnapshot> = {}): LessonYieldSnapshot {
  return {
    schemaVersion: LESSON_YIELD_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    windowDays: 1,
    windowStartMs: 0,
    tasksInWindow: 0,
    completedInWindow: 0,
    completedWithLogs: 0,
    buckets: { wroteLesson: 0, explicitSkip: 0, searchOnly: 0, noKbActivity: 0 },
    decided: 0,
    yieldRate: 0,
    yieldRateAmongLogged: 0,
    ...overrides,
  };
}

beforeEach(() => {
  scanMock.mockReset();
});

describe('/api/health lesson-yield scheduling (issue #1553)', () => {
  test('health never awaits the scan and single-flights the background refresh', async () => {
    let resolveScan!: (value: LessonYieldSnapshot) => void;
    scanMock.mockImplementation(() => new Promise((resolve) => { resolveScan = resolve; }));
    const app = mkApp(baseDeps());

    // Three polls while the scan is still pending: every response returns
    // immediately without the block, and only ONE scan is ever started.
    for (let i = 0; i < 3; i++) {
      const res = await app.request('/api/health');
      expect(res.status).toBe(200);
      const body = await res.json() as { lessonYield?: unknown };
      expect(body.lessonYield).toBeUndefined();
    }
    expect(scanMock).toHaveBeenCalledTimes(1);

    resolveScan(snapshot({ decided: 3 }));
    await vi.waitFor(async () => {
      const res = await app.request('/api/health');
      const body = await res.json() as { lessonYield?: { decided: number } };
      expect(body.lessonYield?.decided).toBe(3);
    });
    // Fresh cache: the successful scan is not repeated on the next poll.
    expect(scanMock).toHaveBeenCalledTimes(1);
  });

  test('an expired cache serves the stale snapshot while exactly one refresh runs', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-07-27T00:00:00.000Z'));
      const resolvers: Array<(value: LessonYieldSnapshot) => void> = [];
      scanMock.mockImplementation(() => new Promise((resolve) => { resolvers.push(resolve); }));
      const app = mkApp(baseDeps());

      // Warm the cache via the first background scan.
      await app.request('/api/health');
      expect(scanMock).toHaveBeenCalledTimes(1);
      resolvers[0](snapshot({ decided: 1 }));
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      let body = await (await app.request('/api/health')).json() as { lessonYield?: { decided: number } };
      expect(body.lessonYield?.decided).toBe(1);
      expect(scanMock).toHaveBeenCalledTimes(1);

      // Expire the 60s TTL: the immediate response must still carry the OLD
      // snapshot (stale-while-revalidate — never undefined, never blocking),
      // with exactly one new background scan started.
      vi.setSystemTime(new Date('2026-07-27T00:01:01.000Z'));
      body = await (await app.request('/api/health')).json() as { lessonYield?: { decided: number } };
      expect(body.lessonYield?.decided).toBe(1);
      expect(scanMock).toHaveBeenCalledTimes(2);
      await app.request('/api/health');
      expect(scanMock).toHaveBeenCalledTimes(2);

      // The refresh lands and later polls serve the new snapshot.
      resolvers[1](snapshot({ decided: 2 }));
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      body = await (await app.request('/api/health')).json() as { lessonYield?: { decided: number } };
      expect(body.lessonYield?.decided).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test('a failed background refresh backs off instead of re-scanning every poll', async () => {
    scanMock.mockRejectedValue(new Error('corpus unreadable'));
    const app = mkApp(baseDeps());

    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    // Let the rejection settle so the backoff timestamp is recorded.
    await new Promise((resolve) => setTimeout(resolve, 20));

    await app.request('/api/health');
    await app.request('/api/health');
    expect(scanMock).toHaveBeenCalledTimes(1);
  });

  test('no kookrDir means no scan is ever attempted', async () => {
    const deps = baseDeps();
    delete deps.kookrDir;
    const res = await mkApp(deps).request('/api/health');
    expect(res.status).toBe(200);
    expect(scanMock).not.toHaveBeenCalled();
  });
});

describe('GET /api/diagnostics/lesson-yield scheduling (issue #1553)', () => {
  test('concurrent requests for the same window share one scan', async () => {
    let resolveScan!: (value: LessonYieldSnapshot) => void;
    scanMock.mockImplementation(() => new Promise((resolve) => { resolveScan = resolve; }));
    const app = mkApp(baseDeps());

    const first = app.request('/api/diagnostics/lesson-yield?days=2');
    const second = app.request('/api/diagnostics/lesson-yield?days=2');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(scanMock).toHaveBeenCalledTimes(1);

    resolveScan(snapshot({ windowDays: 2 }));
    const [res1, res2] = await Promise.all([first, second]);
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    const body1 = await res1.json() as { windowDays: number };
    const body2 = await res2.json() as { windowDays: number };
    expect(body1.windowDays).toBe(2);
    expect(body2.windowDays).toBe(2);
  });

  test('a timed-out scan returns 503 lesson_yield_scan_timeout instead of hanging', async () => {
    scanMock.mockRejectedValue(new DOMException('The operation timed out', 'TimeoutError'));
    const res = await mkApp(baseDeps()).request('/api/diagnostics/lesson-yield?days=3');
    expect(res.status).toBe(503);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('lesson_yield_scan_timeout');
  });

  test('a non-abort scan failure still returns 500 with the message', async () => {
    scanMock.mockRejectedValue(new Error('disk exploded'));
    const res = await mkApp(baseDeps()).request('/api/diagnostics/lesson-yield?days=3');
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('disk exploded');
  });
});
