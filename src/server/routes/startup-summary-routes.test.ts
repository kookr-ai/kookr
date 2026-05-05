import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { registerDiagnosticsRoutes } from './diagnostics-routes.js';
import type { RouteDeps } from './shared.js';
import type { CrashRecoveryResult } from '../crash-recovery.js';

function mkApp(startupRecoverySummary: CrashRecoveryResult | null): Hono {
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
      relaunched: [{ taskId: 't1', oldTmux: 'old', newTmux: 'new' }],
      skipped: [],
      failed: [],
    };
    const res = await mkApp(summary).request('/api/startup-summary');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(summary);
  });
});
