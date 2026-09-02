import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import {
  buildStartupRecoveryHealthSummary,
  registerDiagnosticsRoutes,
} from './diagnostics-routes.js';
import type { RouteDeps } from './shared.js';
import type { CrashRecoveryResult } from '../crash-recovery.js';
import type { StartupRecoverySummary } from '../startup-recovery.js';

function mkApp(startupRecoverySummary: StartupRecoverySummary | null): Hono {
  const app = new Hono();
  registerDiagnosticsRoutes(app, { startupRecoverySummary } as unknown as RouteDeps);
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

  it('exposes the optional post-restart verification block (issue #2839)', async () => {
    const summary: StartupRecoverySummary = {
      relaunched: [],
      skipped: [],
      failed: [],
      postRestartRecovery: {
        restartEpoch: 1_700_000_000_000,
        verified: [
          {
            sessionId: 's1',
            classification: 'recovered-live',
            restartEpoch: 1_700_000_000_000,
            repairAttempts: 0,
            identityVerified: true,
            masterPid: 100,
            agentPid: 101,
            livenessObserved: true,
            elapsedMs: 5,
          },
        ],
        errors: [{ sessionId: 's2', error: 'attach failed' }],
        live: 1,
        idle: 0,
        repaired: 0,
        unverified: 0,
      },
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
