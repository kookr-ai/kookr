import { describe, test, expect } from 'vitest';
import { Hono } from 'hono';
import { TaskStore } from '../../core/tasks.js';
import type { CostComparisonRouteDeps } from './shared.js';
import { registerCostComparisonRoutes } from './cost-comparison-routes.js';

function mkApp(deps: Partial<CostComparisonRouteDeps>): Hono {
  const app = new Hono();
  registerCostComparisonRoutes(app, deps as unknown as CostComparisonRouteDeps);
  return app;
}

describe('GET /api/cost-comparison', () => {
  test('returns 500 when the token tracker is not wired', async () => {
    const taskStore = new TaskStore();
    const res = await mkApp({ taskStore, serverCwd: '/server' }).request('/api/cost-comparison');
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('token tracker not wired');
  });
});
