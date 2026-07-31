import { describe, expect, test } from 'vitest';
import { Hono } from 'hono';
import { registerPipelineStarvationRoutes } from './pipeline-starvation-routes.js';
import type { PipelineStarvationService } from '../pipeline-starvation-service.js';
import type { HandleBatchOutcomeResult } from '../pipeline-starvation-service.js';

function mkApp(handle: PipelineStarvationService['handleBatchOutcome']) {
  const app = new Hono();
  registerPipelineStarvationRoutes(app, {
    pipelineStarvation: { handleBatchOutcome: handle } as PipelineStarvationService,
  });
  return app;
}

describe('POST /api/pipeline-starvation/handle', () => {
  test('400 on missing/invalid outcome', async () => {
    const app = mkApp(async () => {
      throw new Error('should not be called');
    });
    const res = await app.request('/api/pipeline-starvation/handle', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ outcome: { schemaVersion: 1 } }),
    });
    expect(res.status).toBe(400);
  });

  test('200 returns engine decision envelope', async () => {
    const fake: HandleBatchOutcomeResult = {
      decision: {
        applicable: true,
        alreadyHandled: false,
        spawnScout: true,
        emitStarvationAlert: false,
        alertSkipReason: 'first blocked-empty in window — alert deferred until second consecutive',
        consecutiveBlockedEmpty: 1,
        blockedEmptyAtAfter: ['2026-07-30T08:15:00.000Z'],
        handledRunKeysAfter: ['run-1'],
      },
      state: {
        schemaVersion: 1,
        repo: 'jeanibarz/lucy',
        blockedEmptyAt: ['2026-07-30T08:15:00.000Z'],
        handledRunKeys: ['run-1'],
        lastStarvationScoutTaskId: 'task-scout-1',
        lastStarvationScoutAt: '2026-07-30T08:15:00.000Z',
        updatedAt: '2026-07-30T08:15:00.000Z',
      },
      spawnedScoutTaskId: 'task-scout-1',
      alertEmitted: false,
      summary: 'pipeline-starvation: consecutive=1; spawned scout taskId=task-scout-1',
    };
    const app = mkApp(async () => fake);
    const res = await app.request('/api/pipeline-starvation/handle', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        outcome: {
          schemaVersion: 1,
          outcome: 'blocked-empty',
          repo: 'jeanibarz/lucy',
          runKey: 'run-1',
          generatedAt: '2026-07-30T08:15:00.000Z',
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.spawnedScoutTaskId).toBe('task-scout-1');
    expect(body.alertEmitted).toBe(false);
    expect(body.consecutiveBlockedEmpty).toBe(1);
  });
});
