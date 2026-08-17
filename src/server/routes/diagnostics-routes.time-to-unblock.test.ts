import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { Hono } from 'hono';
import { AttentionQueue } from '../../core/attention-queue.js';
import { TaskStore } from '../../core/tasks.js';
import type { TimeToUnblockSnapshot } from '../../shared/contracts/time-to-unblock.js';
import { registerDiagnosticsRoutes } from './diagnostics-routes.js';
import type { RouteDeps } from './shared.js';

const NOW = Date.parse('2026-08-17T15:00:00.000Z');

function mkApp(deps: Partial<RouteDeps>): Hono {
  const app = new Hono();
  registerDiagnosticsRoutes(app, deps as unknown as RouteDeps);
  return app;
}

function event(durationMs: number, extras: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'finding_resolved',
    agentId: 'agent-1',
    anomalyType: 'needs_input',
    method: 'input',
    durationMs,
    timestamp: new Date(NOW - 60_000).toISOString(),
    ...extras,
  });
}

describe('GET /api/diagnostics/time-to-unblock', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  test('returns an empty snapshot when kookrDir is missing', async () => {
    const app = mkApp({
      taskStore: new TaskStore(),
      queue: new AttentionQueue(),
      buildInfo: {} as never,
      nowMs: () => NOW,
    });
    const res = await app.request('/api/diagnostics/time-to-unblock');
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      schemaVersion: 'time-to-unblock.v1',
      medianMs: null,
      sampleCount: 0,
      windowMs: 24 * 60 * 60 * 1000,
      generatedAt: new Date(NOW).toISOString(),
    } satisfies TimeToUnblockSnapshot);
  });

  test('computes the median from session finding_resolved input events', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kookr-ttu-route-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'sessions', 's1'), { recursive: true });
    writeFileSync(
      join(dir, 'sessions', 's1', 'interactions.jsonl'),
      [
        event(2 * 60_000),
        event(5 * 60_000, { agentId: 'a2' }),
        event(12 * 60_000, { agentId: 'a3' }),
        event(40 * 60_000, { agentId: 'a4' }),
        event(3 * 60 * 60 * 1000, { agentId: 'a5' }),
        event(1, { method: 'skip', agentId: 'skip' }),
      ].join('\n') + '\n',
    );

    const app = mkApp({
      taskStore: new TaskStore(),
      queue: new AttentionQueue(),
      buildInfo: {} as never,
      kookrDir: dir,
      nowMs: () => NOW,
    });
    const res = await app.request('/api/diagnostics/time-to-unblock');
    expect(res.status).toBe(200);
    const body = await res.json() as TimeToUnblockSnapshot;
    expect(body.sampleCount).toBe(5);
    expect(body.medianMs).toBe(12 * 60_000);
  });
});
