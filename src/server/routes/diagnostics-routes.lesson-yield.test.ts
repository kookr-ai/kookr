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
import { registerDiagnosticsRoutes, HEALTH_BODY_CACHE_MS, LESSON_YIELD_REQUEST_BUDGET_MS } from './diagnostics-routes.js';
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
    let nowMs = 1_700_000_000_000;
    const app = mkApp({ ...baseDeps(), nowMs: () => nowMs });

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
    await Promise.resolve();
    await Promise.resolve();
    // The 1s health-body cache (#2429) still holds the first assembly
    // (no lessonYield). Expire it so the next poll re-reads the warm snapshot.
    nowMs += HEALTH_BODY_CACHE_MS + 1;
    await vi.waitFor(async () => {
      const res = await app.request('/api/health');
      const body = await res.json() as { lessonYield?: { decided: number } };
      expect(body.lessonYield?.decided).toBe(3);
    });
    // Fresh cache: the successful scan is not repeated on the next poll.
    expect(scanMock).toHaveBeenCalledTimes(1);
  });

  test('an expired cache serves the stale snapshot while exactly one refresh runs', async () => {
    // Fake timers: the lesson-yield cache keys its TTL off `Date.now()` (not an
    // injected clock), so `setSystemTime` is the only way to age it. Under SWR
    // (#2492) the health body is served stale and refreshed in the background, so
    // reads settle on the async queue — `pollUntil`/`settleUntil` re-poll while
    // draining that queue via `advanceTimersByTimeAsync(0)` (deterministic, no
    // guessed flush depth, and the 0ms advance never moves the TTL clock).
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-07-27T00:00:00.000Z'));
      const resolvers: Array<(value: LessonYieldSnapshot) => void> = [];
      scanMock.mockImplementation(() => new Promise((resolve) => { resolvers.push(resolve); }));
      // Run the #2492 SWR refresh inline so the lesson-scan scheduling this test
      // pins is deterministic under fake timers (production defers via
      // setImmediate; that deferral is covered separately in diagnostics-routes.test.ts).
      const app = mkApp({ ...baseDeps(), healthRefreshScheduler: (fn) => fn() });

      const settleUntil = async (predicate: () => boolean) => {
        for (let i = 0; i < 200 && !predicate(); i++) await vi.advanceTimersByTimeAsync(0);
      };
      const pollUntilDecided = async (expected: number) => {
        let body: { lessonYield?: { decided: number } } = {};
        for (let i = 0; i < 200; i++) {
          body = await (await app.request('/api/health')).json();
          if (body.lessonYield?.decided === expected) return body;
          await vi.advanceTimersByTimeAsync(0);
        }
        return body;
      };

      // Warm the lesson-yield cache via the first background scan.
      await app.request('/api/health');
      expect(scanMock).toHaveBeenCalledTimes(1);
      resolvers[0](snapshot({ decided: 1 }));
      await settleUntil(() => false); // drain: let the resolved scan populate the lesson cache

      // Expire the 1s health-body cache. Under SWR (#2492) the next poll serves
      // the stale body immediately and refreshes in the background; once that
      // re-assembly lands, the warm lesson snapshot (decided=1) is visible with
      // NO new scan (the lesson cache is still warm — single-flight preserved).
      vi.setSystemTime(new Date('2026-07-27T00:00:01.001Z'));
      expect((await pollUntilDecided(1)).lessonYield?.decided).toBe(1);
      expect(scanMock).toHaveBeenCalledTimes(1);

      // Expire the 60s lesson-yield TTL. The immediate poll still serves the warm
      // health body (decided=1) — never undefined, never blocking; the background
      // health re-assembly re-reads the lesson cache, whose 60s TTL has lapsed, so
      // lesson SWR serves the old snapshot and starts exactly one new scan (#2).
      vi.setSystemTime(new Date('2026-07-27T00:01:02.000Z'));
      const staleBody = await (await app.request('/api/health')).json() as { lessonYield?: { decided: number } };
      expect(staleBody.lessonYield?.decided).toBe(1);
      await settleUntil(() => scanMock.mock.calls.length >= 2);
      expect(scanMock).toHaveBeenCalledTimes(2);
      // Single-flight: another poll at the same clock starts no third scan.
      await app.request('/api/health');
      await settleUntil(() => false);
      expect(scanMock).toHaveBeenCalledTimes(2);

      // The refresh lands; expire the body cache so a later poll's background
      // re-assembly picks up the new snapshot (decided=2).
      resolvers[1](snapshot({ decided: 2 }));
      await settleUntil(() => false);
      vi.setSystemTime(new Date('2026-07-27T00:01:03.001Z'));
      expect((await pollUntilDecided(2)).lessonYield?.decided).toBe(2);
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

  // Issue #1585: the request path is cache-first and can no longer hang.
  test('a warm cache is served without launching a second scan', async () => {
    scanMock.mockResolvedValue(snapshot({ windowDays: 2, decided: 5 }));
    const app = mkApp(baseDeps());

    const first = await app.request('/api/diagnostics/lesson-yield?days=2');
    expect(first.status).toBe(200);
    expect((await first.json() as { decided: number }).decided).toBe(5);
    expect(scanMock).toHaveBeenCalledTimes(1);

    // Fresh cache: the next request returns immediately without a new scan.
    const second = await app.request('/api/diagnostics/lesson-yield?days=2');
    expect(second.status).toBe(200);
    expect((await second.json() as { decided: number }).decided).toBe(5);
    expect(scanMock).toHaveBeenCalledTimes(1);
  });

  test('a cold scan slower than the request budget returns 503 warming, not a hang', async () => {
    vi.useFakeTimers();
    try {
      // Scan never settles: without the budget the request would block up to
      // the 30s scan bound — the exact hang class from prod on 2026-07-26.
      scanMock.mockImplementation(() => new Promise<LessonYieldSnapshot>(() => {}));
      const app = mkApp(baseDeps());

      const pending = app.request('/api/diagnostics/lesson-yield?days=2');
      // Advance past the request budget; the endpoint must give up waiting.
      await vi.advanceTimersByTimeAsync(LESSON_YIELD_REQUEST_BUDGET_MS + 10);
      const res = await pending;

      expect(res.status).toBe(503);
      const body = await res.json() as { error: string; retryAfterMs: number };
      expect(body.error).toBe('lesson_yield_warming');
      expect(body.retryAfterMs).toBe(LESSON_YIELD_REQUEST_BUDGET_MS);
      // The bounded background scan is still the single in-flight scan.
      expect(scanMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test('an expired per-window cache serves the stale snapshot while one refresh runs', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-07-27T00:00:00.000Z'));
      // Warm the cache with a first, immediately-resolving scan.
      scanMock.mockResolvedValueOnce(snapshot({ windowDays: 2, decided: 1 }));
      const app = mkApp(baseDeps());
      const warm = await app.request('/api/diagnostics/lesson-yield?days=2');
      expect((await warm.json() as { decided: number }).decided).toBe(1);
      expect(scanMock).toHaveBeenCalledTimes(1);

      // Switch to a controllable scan and expire the 60s TTL.
      const resolvers: Array<(value: LessonYieldSnapshot) => void> = [];
      scanMock.mockImplementation(() => new Promise((resolve) => { resolvers.push(resolve); }));
      vi.setSystemTime(new Date('2026-07-27T00:01:01.000Z'));

      // Stale response is immediate (old snapshot) with exactly one new scan.
      const staleRes = await app.request('/api/diagnostics/lesson-yield?days=2');
      expect(staleRes.status).toBe(200);
      expect((await staleRes.json() as { decided: number }).decided).toBe(1);
      expect(scanMock).toHaveBeenCalledTimes(2);

      // The refresh lands; a later request serves the new snapshot.
      resolvers[0](snapshot({ windowDays: 2, decided: 2 }));
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      const freshRes = await app.request('/api/diagnostics/lesson-yield?days=2');
      expect((await freshRes.json() as { decided: number }).decided).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
