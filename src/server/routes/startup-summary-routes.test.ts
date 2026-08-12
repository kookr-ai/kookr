import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import {
  buildStartupRecoveryHealthSummary,
  registerDiagnosticsRoutes,
} from './diagnostics-routes.js';
import type { RouteDeps } from './shared.js';
import type { CrashRecoveryResult } from '../crash-recovery.js';

function mkApp(startupRecoverySummary: CrashRecoveryResult | null): Hono {
  const app = new Hono();
  registerDiagnosticsRoutes(app, {
    startupRecoverySummary,
    // Minimal deps so /api/health can also be exercised from this suite.
    taskStore: { viewTasks: () => [], listTasks: () => [] },
    queue: {
      getDepth: () => 0,
      getOldestFindingAgeMs: () => null,
    },
  } as unknown as RouteDeps);
  return app;
}

describe('GET /api/startup-summary', () => {
  it('returns null when no recovery was performed', async () => {
    const res = await mkApp(null).request('/api/startup-summary');
    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
  });

  it('returns the recovery summary JSON when present', async () => {
    const summary: CrashRecoveryResult = {
      relaunched: [{
        taskId: 't1',
        oldSessionId: 'old',
        newSessionId: 'new',
        mode: 'fresh',
      }],
      skipped: [],
      failed: [],
    };
    const res = await mkApp(summary).request('/api/startup-summary');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(summary);
  });
});

describe('buildStartupRecoveryHealthSummary (issue #2351)', () => {
  it('counts crash-loop skips separately from other skips', () => {
    const summary: CrashRecoveryResult = {
      relaunched: [
        {
          taskId: 't1',
          oldSessionId: 'old',
          newSessionId: 'new',
          mode: 'resumed',
        },
      ],
      skipped: [
        {
          taskId: 't2',
          sessionId: 's2',
          reason: 'rapid crash-loop (relaunched 3s ago, window is 60s)',
        },
        {
          taskId: 't3',
          sessionId: 's3',
          reason: 'cwd missing',
        },
        {
          taskId: 't4',
          sessionId: 's4',
          reason: 'rapid crash-loop (relaunched 40s ago, window is 60s)',
        },
      ],
      failed: [{ taskId: 't5', sessionId: 's5', error: 'launch failed' }],
    };
    expect(
      buildStartupRecoveryHealthSummary(summary, '2026-08-12T12:00:00.000Z'),
    ).toEqual({
      relaunched: 1,
      skipped: 3,
      failed: 1,
      crashLoopSkips: 2,
      generatedAt: '2026-08-12T12:00:00.000Z',
    });
  });
});
