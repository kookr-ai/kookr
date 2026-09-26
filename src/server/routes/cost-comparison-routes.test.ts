import { describe, test, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { TaskStore } from '../../core/tasks.js';
import { TokenTracker } from '../../core/token-tracker.js';
import { CodexRolloutScanner } from '../../adapters/codex-rollout-scanner.js';
import type { CostComparisonRouteDeps } from './shared.js';
import { registerCostComparisonRoutes } from './cost-comparison-routes.js';

function mkApp(deps: Partial<CostComparisonRouteDeps>): Hono {
  const app = new Hono();
  registerCostComparisonRoutes(app, deps as unknown as CostComparisonRouteDeps);
  return app;
}

describe('GET /api/cost-comparison', () => {
  test('uses the injected scanner without reading host rollout history', async () => {
    const hostScan = vi.spyOn(CodexRolloutScanner.prototype, 'scan')
      .mockRejectedValue(new Error('Host history must not be read'));
    const costComparisonScanner = {
      scan: vi.fn().mockResolvedValue({
        rollouts: [],
        stats: { rolloutCount: 0, parseErrorCount: 0, abandonedCount: 0, scanDurationMs: 0, codexHome: '/test/rollouts' },
      }),
      bindTasks: vi.fn().mockReturnValue({ outcomes: new Map(), orphanBindings: [] }),
    };
    try {
      const res = await mkApp({
        taskStore: new TaskStore(), serverCwd: '/server', tokenTracker: new TokenTracker(),
        costComparisonScanner,
      }).request('/api/cost-comparison');
      expect(res.status).toBe(200);
      expect(costComparisonScanner.scan).toHaveBeenCalledOnce();
      expect(costComparisonScanner.bindTasks).toHaveBeenCalledWith([], []);
      expect(hostScan).not.toHaveBeenCalled();
      expect(await res.json()).toMatchObject({ perPlaybook: [], perTask: [] });
    } finally {
      hostScan.mockRestore();
    }
  });

  test('returns 500 when the token tracker is not wired', async () => {
    const taskStore = new TaskStore();
    const res = await mkApp({ taskStore, serverCwd: '/server' }).request('/api/cost-comparison');
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('token tracker not wired');
  });
});
