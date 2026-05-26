import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskStore } from '../../core/tasks.js';
import { loadTasks } from '../../core/task-persistence.js';
import type { TaskRelationsRouteDeps } from './shared.js';
import { registerTaskRelationsRoutes } from './task-relations-routes.js';

function mkApp(deps: Partial<TaskRelationsRouteDeps>): Hono {
  const app = new Hono();
  registerTaskRelationsRoutes(app, deps as unknown as TaskRelationsRouteDeps);
  return app;
}

describe('task-relation graph (issue #599)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'kookr-task-relations-routes-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function mkRelationDeps(taskStore: TaskStore): TaskRelationsRouteDeps {
    return {
      taskStore,
      tasksFile: join(tempDir, 'tasks.json'),
    };
  }

  test('GET /api/task-relations returns the deterministic spawned_by edge', async () => {
    const taskStore = new TaskStore();
    const parent = taskStore.createTask('Parent', '/cwd');
    const child = taskStore.createTask('Child', '/cwd', undefined, parent.id);

    const res = await mkApp(mkRelationDeps(taskStore)).request('/api/task-relations');
    expect(res.status).toBe(200);
    const body = await res.json() as { relations: Array<{ sourceTaskId: string; targetTaskId: string; type: string; confidence: number }> };
    expect(body.relations).toHaveLength(1);
    expect(body.relations[0]).toMatchObject({
      sourceTaskId: child.id,
      targetTaskId: parent.id,
      type: 'spawned_by',
      confidence: 1,
    });
  });

  test('GET /api/task-relations supports filters', async () => {
    const taskStore = new TaskStore();
    const a = taskStore.createTask('A', '/cwd');
    const b = taskStore.createTask('B', '/cwd');
    taskStore.upsertRelation({ sourceTaskId: a.id, targetTaskId: b.id, type: 'related_to', confidence: 0.5, source: 'manual' });
    taskStore.upsertRelation({ sourceTaskId: b.id, targetTaskId: a.id, type: 'depends_on', confidence: 0.5, source: 'manual' });

    const app = mkApp(mkRelationDeps(taskStore));
    const filtered = await app.request(`/api/task-relations?type=depends_on`);
    const body = await filtered.json() as { relations: Array<{ type: string }> };
    expect(body.relations).toHaveLength(1);
    expect(body.relations[0].type).toBe('depends_on');

    const bad = await app.request('/api/task-relations?type=nope');
    expect(bad.status).toBe(400);
  });

  test('POST /api/task-relations upserts and persists to disk', async () => {
    const taskStore = new TaskStore();
    const a = taskStore.createTask('A', '/cwd');
    const b = taskStore.createTask('B', '/cwd');

    const deps = mkRelationDeps(taskStore);
    const res = await mkApp(deps).request('/api/task-relations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceTaskId: a.id,
        targetTaskId: b.id,
        type: 'depends_on',
        confidence: 0.7,
        source: 'manual',
        evidence: [{ snippet: 'note', observedAt: new Date().toISOString() }],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; relation: { id: string; confidence: number } };
    expect(body.ok).toBe(true);
    expect(body.relation.confidence).toBe(0.7);

    const persisted = await loadTasks(deps.tasksFile!);
    expect(persisted.relations ?? []).toHaveLength(1);
    expect((persisted.relations ?? [])[0].id).toBe(body.relation.id);
  });

  test('POST /api/task-relations is idempotent — same (source, target, type) updates instead of duplicating', async () => {
    const taskStore = new TaskStore();
    const a = taskStore.createTask('A', '/cwd');
    const b = taskStore.createTask('B', '/cwd');
    const app = mkApp(mkRelationDeps(taskStore));

    async function post(confidence: number) {
      const res = await app.request('/api/task-relations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceTaskId: a.id, targetTaskId: b.id, type: 'related_to',
          confidence, source: 'manual',
        }),
      });
      expect(res.status).toBe(200);
      return await res.json() as { relation: { id: string; confidence: number } };
    }
    const first = await post(0.3);
    const second = await post(0.9);
    expect(second.relation.id).toBe(first.relation.id);
    expect(second.relation.confidence).toBe(0.9);

    const list = await app.request('/api/task-relations');
    const body = await list.json() as { relations: Array<unknown> };
    expect(body.relations).toHaveLength(1);
  });

  test('POST /api/task-relations rejects invalid payloads', async () => {
    const taskStore = new TaskStore();
    const a = taskStore.createTask('A', '/cwd');
    const b = taskStore.createTask('B', '/cwd');
    const app = mkApp(mkRelationDeps(taskStore));

    const cases: Array<{ body: Record<string, unknown>; status: number; messageHint: string }> = [
      { body: {}, status: 400, messageHint: 'sourceTaskId' },
      { body: { sourceTaskId: a.id }, status: 400, messageHint: 'targetTaskId' },
      { body: { sourceTaskId: a.id, targetTaskId: a.id, type: 'related_to', confidence: 0.5, source: 'manual' }, status: 400, messageHint: 'differ' },
      { body: { sourceTaskId: a.id, targetTaskId: b.id, type: 'bogus', confidence: 0.5, source: 'manual' }, status: 400, messageHint: 'type' },
      { body: { sourceTaskId: a.id, targetTaskId: b.id, type: 'related_to', confidence: 5, source: 'manual' }, status: 400, messageHint: 'confidence' },
      { body: { sourceTaskId: a.id, targetTaskId: b.id, type: 'related_to', confidence: 0.5, source: 'bogus' }, status: 400, messageHint: 'source' },
      { body: { sourceTaskId: 'missing', targetTaskId: b.id, type: 'related_to', confidence: 0.5, source: 'manual' }, status: 404, messageHint: 'Source task' },
      { body: { sourceTaskId: a.id, targetTaskId: 'missing', type: 'related_to', confidence: 0.5, source: 'manual' }, status: 404, messageHint: 'Target task' },
    ];
    for (const c of cases) {
      const res = await app.request('/api/task-relations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(c.body),
      });
      expect(res.status, `payload=${JSON.stringify(c.body)}`).toBe(c.status);
      const json = await res.json() as { error: string };
      expect(json.error.toLowerCase()).toContain(c.messageHint.toLowerCase());
    }
  });
});
