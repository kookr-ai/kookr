import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Task } from '../core/tasks.js';
import { resolveTaskSqlitePath, TaskSqliteStore } from '../core/task-sqlite-store.js';
import { loadTaskLiveness } from './task-liveness.js';

describe('loadTaskLiveness (tasks.json)', () => {
  let dir: string;
  const env = { KOOKR_TASK_STORE: 'json' } as NodeJS.ProcessEnv;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'oc-live-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('classifies live, terminal (with end time) and unknown tasks', async () => {
    writeFileSync(join(dir, 'tasks.json'), JSON.stringify({ version: 2, tasks: [
      { id: 'a', status: 'inProgress' },
      { id: 'b', status: 'completed', updatedAt: '2026-01-01T00:00:00Z' },
    ] }));
    const look = await loadTaskLiveness(dir, ['a', 'b', 'c'], env);
    expect(look('a')).toEqual({ state: 'live' });
    expect(look('b')).toEqual({ state: 'terminal', endedAt: new Date('2026-01-01T00:00:00Z') });
    expect(look('c')).toEqual({ state: 'unknown' });
  });
  test('KOOKR_TASK_STORE is normalised like the server (case/space) and a stale tasks.sqlite is then ignored', async () => {
    writeFileSync(join(dir, 'tasks.sqlite'), 'not a database');
    writeFileSync(join(dir, 'tasks.json'), JSON.stringify({ version: 2, tasks: [{ id: 'a', status: 'inProgress' }] }));
    for (const v of ['JSON', ' Json ', 'json']) {
      expect((await loadTaskLiveness(dir, ['a'], { KOOKR_TASK_STORE: v } as NodeJS.ProcessEnv))('a')).toEqual({ state: 'live' });
    }
  });
  test('an id that was not requested is store_unreadable, never unknown', async () => {
    writeFileSync(join(dir, 'tasks.json'), JSON.stringify({ version: 2, tasks: [{ id: 'T', status: 'inProgress' }] }));
    expect((await loadTaskLiveness(dir, ['other'], env))('T')).toEqual({ state: 'store_unreadable' });
  });
  test('a row without a usable status is store_unreadable, not unknown', async () => {
    writeFileSync(join(dir, 'tasks.json'), JSON.stringify({ version: 2, tasks: [{ id: 'a' }] }));
    expect((await loadTaskLiveness(dir, ['a'], env))('a')).toEqual({ state: 'store_unreadable' });
  });
  test('a missing, corrupt or shapeless store is store_unreadable for every task (never unknown)', async () => {
    expect((await loadTaskLiveness(dir, ['a'], env))('a')).toEqual({ state: 'store_unreadable' });
    writeFileSync(join(dir, 'tasks.json'), '{nope');
    expect((await loadTaskLiveness(dir, ['a'], env))('a')).toEqual({ state: 'store_unreadable' });
    writeFileSync(join(dir, 'tasks.json'), '{"foo":1}');
    expect((await loadTaskLiveness(dir, ['a'], env))('a')).toEqual({ state: 'store_unreadable' });
  });
});

describe('loadTaskLiveness (tasks.sqlite)', () => {
  let dir: string;
  // Explicit empty env: the default (sqlite) mode must not depend on the host's KOOKR_TASK_STORE.
  const env = {} as NodeJS.ProcessEnv;
  const task = (id: string, status: string, updatedAt: string) =>
    ({ id, status, agentType: 'claude', createdAt: '2026-01-01T00:00:00Z', updatedAt }) as unknown as Task;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oc-live-sql-'));
    // A tasks.json that contradicts the database: if it were read instead, every assertion below would fail.
    writeFileSync(join(dir, 'tasks.json'), JSON.stringify({ version: 2, tasks: [
      { id: 'a', status: 'completed', updatedAt: '2020-01-01T00:00:00Z' },
      { id: 'b', status: 'inProgress' },
      { id: 'c', status: 'inProgress' },
    ] }));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('reads a database written by the real TaskSqliteStore, while the writer still holds it open', async () => {
    const dbPath = resolveTaskSqlitePath(join(dir, 'tasks.json'));
    expect(dbPath).toBe(join(dir, 'tasks.sqlite'));
    const store = new TaskSqliteStore(dbPath);
    try {
      store.importSnapshot({ tasks: [task('a', 'inProgress', '2026-01-02T00:00:00Z'), task('b', 'completed', '2026-01-03T04:05:06Z')] });
      const look = await loadTaskLiveness(dir, ['a', 'b', 'c'], env);
      expect(look('a')).toEqual({ state: 'live' });
      expect(look('b')).toEqual({ state: 'terminal', endedAt: new Date('2026-01-03T04:05:06Z') });
      expect(look('c')).toEqual({ state: 'unknown' });
      expect(look('not-asked')).toEqual({ state: 'store_unreadable' });
    } finally {
      store.close();
    }
  });

  test('a corrupt tasks.sqlite is store_unreadable for every task and never falls back to tasks.json', async () => {
    writeFileSync(join(dir, 'tasks.sqlite'), 'not a database');
    const look = await loadTaskLiveness(dir, ['a', 'b', 'c'], env);
    for (const id of ['a', 'b', 'c']) expect(look(id)).toEqual({ state: 'store_unreadable' });
  });
});
