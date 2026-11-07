import { describe, it, expect, afterEach } from 'vitest';
import { Hono } from 'hono';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerPluginDriftRoutes } from './plugin-drift-routes.js';
import { CONFIG_EPOCH_FILENAME } from '../plugin-manager/config-epoch.js';
import type { TaskStore } from '../../core/tasks.js';
import type { Task } from '../../core/task-read-model.js';
import type { ConfigDriftSurface } from '../../shared/contracts/plugins.js';

function task(partial: Partial<Task> & Pick<Task, 'id'>): Task {
  return {
    agentType: 'claude-code',
    status: 'inProgress',
    createdAt: new Date('2026-11-07T10:00:00.000Z'),
    prompt: '',
    cwd: '/tmp',
    ...partial,
  } as Task;
}

describe('GET /api/plugins/config-drift', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function makeApp(tasks: Task[], epoch?: number): Hono {
    dir = mkdtempSync(join(tmpdir(), 'plugin-drift-'));
    if (epoch !== undefined) {
      writeFileSync(join(dir, CONFIG_EPOCH_FILENAME), JSON.stringify({ version: 1, epoch, bumpedAt: null }));
    }
    const taskStore = { getAllTasks: () => tasks } as unknown as TaskStore;
    const app = new Hono();
    registerPluginDriftRoutes(app, { taskStore, kookrDir: dir, serverCwd: dir });
    return app;
  }

  it('reports Kookr-managed claude sessions behind the current epoch', async () => {
    const app = makeApp(
      [
        task({ id: 'stale', configEpochAtStart: 1, name: 'My run' }),
        task({ id: 'current', configEpochAtStart: 3 }),
        task({ id: 'terminal', configEpochAtStart: 1, status: 'completed' }),
        task({ id: 'codex', configEpochAtStart: 1, agentType: 'codex' }),
      ],
      3,
    );
    const res = await app.request('/api/plugins/config-drift');
    expect(res.status).toBe(200);
    const body = (await res.json()) as ConfigDriftSurface;
    expect(body.currentEpoch).toBe(3);
    expect(body.staleCount).toBe(1);
    expect(body.staleSessions[0]).toMatchObject({ taskId: 'stale', startedEpoch: 1, title: 'My run' });
    expect(body.externalCoverageNote).toMatch(/external terminals/i);
  });

  it('is empty when no epoch file exists (epoch 0)', async () => {
    const app = makeApp([task({ id: 'x', configEpochAtStart: 0 })]);
    const body = (await app.request('/api/plugins/config-drift').then((r) => r.json())) as ConfigDriftSurface;
    expect(body.currentEpoch).toBe(0);
    expect(body.staleCount).toBe(0);
  });

  it('degrades to an empty surface instead of 500 when reading tasks throws', async () => {
    dir = mkdtempSync(join(tmpdir(), 'plugin-drift-'));
    const taskStore = {
      getAllTasks: () => {
        throw new Error('task store unavailable');
      },
    } as unknown as TaskStore;
    const app = new Hono();
    registerPluginDriftRoutes(app, { taskStore, kookrDir: dir, serverCwd: dir });
    const res = await app.request('/api/plugins/config-drift');
    expect(res.status).toBe(200);
    const body = (await res.json()) as ConfigDriftSurface;
    expect(body.staleCount).toBe(0);
    expect(body.externalCoverageNote).toMatch(/external terminals/i);
  });
});
