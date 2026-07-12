import { describe, expect, test } from 'vitest';
import { Hono } from 'hono';
import { registerDiagnosticsRoutes } from './diagnostics-routes.js';
import type { SessionHealthDiagnostics } from '../../shared/contracts/session-health.js';
import type { RouteDeps } from './shared.js';

describe('session health diagnostics route', () => {
  test('TS-HEALTH-007 exposes the versioned fleet snapshot through the diagnostics surface', async () => {
    const report: SessionHealthDiagnostics = {
      schemaVersion: 'session-health.v1',
      generatedAt: new Date(100_000).toISOString(),
      restartEpoch: new Date(90_000).toISOString(),
      sessions: [],
      coordinatedStall: null,
    };
    const app = new Hono();
    registerDiagnosticsRoutes(app, {
      sessionHealthService: { getDiagnostics: () => report },
    } as unknown as RouteDeps);

    const response = await app.request('/api/diagnostics/session-health');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(report);
  });

  test('returns a safe empty response when health collection is not wired', async () => {
    const app = new Hono();
    registerDiagnosticsRoutes(app, {
      serverStartedAt: new Date(90_000).toISOString(),
    } as unknown as RouteDeps);

    const response = await app.request('/api/diagnostics/session-health');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      schemaVersion: 'session-health.v1',
      generatedAt: expect.any(String),
      restartEpoch: new Date(90_000).toISOString(),
      sessions: [],
      coordinatedStall: null,
    });
  });

  test('maps collection failures to a JSON diagnostic error', async () => {
    const app = new Hono();
    registerDiagnosticsRoutes(app, {
      sessionHealthService: { getDiagnostics: () => { throw new Error('filesystem unavailable'); } },
    } as unknown as RouteDeps);

    const response = await app.request('/api/diagnostics/session-health');

    expect(response.status).toBe(503);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual({ error: 'session health diagnostics unavailable' });
  });
});
