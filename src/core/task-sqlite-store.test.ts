import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { TaskStore } from './tasks.js';
import {
  openTaskStateStore,
  persistTaskState,
  saveTasks,
  loadTasks,
} from './task-persistence.js';
import {
  hydrateTaskFromPersistedJson,
  resolveTaskSqlitePath,
  resolveTaskStoreMode,
  TaskSqliteStore,
} from './task-sqlite-store.js';

describe('task-sqlite-store', () => {
  let tempDir: string;
  let tasksFile: string;
  let prevMode: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'kookr-sqlite-'));
    tasksFile = join(tempDir, 'tasks.json');
    prevMode = process.env.KOOKR_TASK_STORE;
    delete process.env.KOOKR_TASK_STORE;
  });

  afterEach(() => {
    if (prevMode === undefined) delete process.env.KOOKR_TASK_STORE;
    else process.env.KOOKR_TASK_STORE = prevMode;
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('resolveTaskStoreMode defaults to sqlite and honors KOOKR_TASK_STORE=json', () => {
    expect(resolveTaskStoreMode({})).toBe('sqlite');
    expect(resolveTaskStoreMode({ KOOKR_TASK_STORE: 'json' })).toBe('json');
    expect(resolveTaskStoreMode({ KOOKR_TASK_STORE: 'JSON' })).toBe('json');
    expect(resolveTaskStoreMode({ KOOKR_TASK_STORE: 'sqlite' })).toBe('sqlite');
  });

  test('round-trip full Task shape through data blob', () => {
    const store = new TaskStore();
    const created = store.createTask({
      prompt: 'Fix the thing',
      userPrompt: 'please fix',
      cwd: '/repo',
      criteria: 'tests green',
      projectId: 'proj-1',
      metadata: { note: 'x' },
    });
    store.startTask(created.id);
    store.addSession(created.id, {
      tmuxSession: 'kookr-sess-1',
      agentType: 'claude-code',
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    store.setCompletionDigest(created.id, {
      bullets: ['did stuff'],
      filesChanged: ['a.ts'],
    });
    store.completeTask(created.id);
    store.updateTokenUsage(created.id, {
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.01,
    });

    const live = store.getTask(created.id)!;
    const db = new TaskSqliteStore(join(tempDir, 'roundtrip.sqlite'));
    try {
      db.importSnapshot({
        tasks: [live],
        lifetimeSpendUsd: store.getLifetimeSpendUsd(),
        relations: store.listRelations(),
      });
      const loaded = db.loadAll();
      expect(loaded.tasks).toHaveLength(1);
      const t = loaded.tasks[0]!;
      expect(t.id).toBe(live.id);
      expect(t.prompt).toBe('Fix the thing');
      expect(t.userPrompt).toBe('please fix');
      expect(t.criteria).toBe('tests green');
      expect(t.status).toBe('completed');
      expect(t.projectId).toBe('proj-1');
      expect(t.sessions[0]?.tmuxSession).toBe('kookr-sess-1');
      expect(t.completionDigest?.bullets).toEqual(['did stuff']);
      expect(t.tokenUsage?.costUsd).toBe(0.01);
      expect(t.createdAt).toBeInstanceOf(Date);
      expect(t.updatedAt).toBeInstanceOf(Date);
      expect(t.finishedAt).toBeInstanceOf(Date);
      expect(loaded.lifetimeSpendUsd).toBeCloseTo(0.01);
    } finally {
      db.close();
    }
  });

  test('dirty flush upserts only changed tasks', async () => {
    const mem = new TaskStore();
    const a = mem.createTask('A', '/repo');
    const b = mem.createTask('B', '/repo');
    mem.clearDirtyPersistence();

    const opened = await openTaskStateStore(tasksFile);
    expect(opened.mode).toBe('sqlite');
    expect(opened.sqliteStore).not.toBeNull();
    const db = opened.sqliteStore!;

    // Seed both tasks as a full import.
    db.importSnapshot({ tasks: mem.getAllTasks(), lifetimeSpendUsd: 0 });
    mem.clearDirtyPersistence();

    mem.renameTask(a.id, 'Alpha');
    expect(mem.hasDirtyPersistence()).toBe(true);
    const dirty = mem.drainDirtyState();
    expect(dirty.dirtyTaskIds).toEqual([a.id]);
    expect(dirty.deletedTaskIds).toEqual([]);

    // Re-mark and flush via persistTaskState.
    mem.renameTask(a.id, 'Alpha2');
    await persistTaskState({
      taskStore: mem,
      tasksFile,
      sqliteStore: db,
      policy: 'none',
    });
    expect(mem.hasDirtyPersistence()).toBe(false);

    const reloaded = db.loadAll();
    expect(reloaded.tasks).toHaveLength(2);
    expect(reloaded.tasks.find((t) => t.id === a.id)?.name).toBe('Alpha2');
    expect(reloaded.tasks.find((t) => t.id === b.id)?.prompt).toBe('B');
    db.close();
  });

  test('delete flushes as a row removal', async () => {
    const mem = new TaskStore();
    const a = mem.createTask('A', '/repo');
    const b = mem.createTask('B', '/repo');
    const opened = await openTaskStateStore(tasksFile);
    const db = opened.sqliteStore!;
    db.importSnapshot({ tasks: mem.getAllTasks() });
    mem.clearDirtyPersistence();

    mem.deleteTask(a.id);
    await persistTaskState({ taskStore: mem, tasksFile, sqliteStore: db });
    const reloaded = db.loadAll();
    expect(reloaded.tasks.map((t) => t.id).sort()).toEqual([b.id].sort());
    db.close();
  });

  test('one-shot migration from tasks.json renames backup and loads DB', async () => {
    const mem = new TaskStore();
    const t1 = mem.createTask('Migrated task', '/repo');
    mem.upsertRelation({
      sourceTaskId: t1.id,
      targetTaskId: t1.id + '-ghost',
      type: 'depends_on',
      confidence: 0.5,
      source: 'manual',
    });
    await saveTasks(
      mem.getAllTasks(),
      tasksFile,
      12.5,
      undefined,
      undefined,
      mem.listRelations(),
    );
    expect(existsSync(tasksFile)).toBe(true);

    const opened = await openTaskStateStore(tasksFile);
    try {
      expect(opened.mode).toBe('sqlite');
      expect(opened.load.tasks).toHaveLength(1);
      expect(opened.load.tasks[0]!.prompt).toBe('Migrated task');
      expect(opened.load.lifetimeSpendUsd).toBe(12.5);
      expect(opened.load.relations ?? []).toHaveLength(1);
      expect(existsSync(tasksFile)).toBe(false);
      expect(existsSync(resolveTaskSqlitePath(tasksFile))).toBe(true);
      // Backup rename, not delete.
      const backupMention = opened.loadedFrom.includes('pre-sqlite-');
      expect(backupMention).toBe(true);
      // Idempotent: re-open uses existing DB, no second migration needed.
      opened.sqliteStore!.close();
      const again = await openTaskStateStore(tasksFile);
      try {
        expect(again.load.tasks).toHaveLength(1);
        expect(again.load.tasks[0]!.id).toBe(t1.id);
      } finally {
        again.sqliteStore?.close();
      }
    } finally {
      // first store already closed above in happy path
    }
  });

  test('migration is skipped when DB already exists', async () => {
    const dbPath = resolveTaskSqlitePath(tasksFile);
    const db = new TaskSqliteStore(dbPath);
    const mem = new TaskStore();
    const existing = mem.createTask('Already in DB', '/repo');
    db.importSnapshot({ tasks: mem.getAllTasks() });
    db.close();

    // A stale JSON must not overwrite the DB.
    writeFileSync(tasksFile, JSON.stringify({
      version: 2,
      lifetimeSpendUsd: 0,
      tasks: [{
        id: 'should-not-import',
        prompt: 'stale',
        cwd: '/x',
        agentType: 'claude-code',
        status: 'open',
        sessions: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }],
    }));

    const opened = await openTaskStateStore(tasksFile);
    try {
      expect(opened.load.tasks).toHaveLength(1);
      expect(opened.load.tasks[0]!.id).toBe(existing.id);
      expect(existsSync(tasksFile)).toBe(true); // not renamed when DB already present
    } finally {
      opened.sqliteStore?.close();
    }
  });

  test('crash-recovery: reopened DB retains last committed flush', async () => {
    const dbPath = join(tempDir, 'crash.sqlite');
    const mem = new TaskStore();
    const t = mem.createTask('durable', '/repo');
    let db = new TaskSqliteStore(dbPath);
    db.importSnapshot({ tasks: mem.getAllTasks() });
    mem.renameTask(t.id, 'committed');
    await persistTaskState({ taskStore: mem, tasksFile, sqliteStore: db });
    db.close();

    db = new TaskSqliteStore(dbPath);
    try {
      const loaded = db.loadAll();
      expect(loaded.tasks[0]!.name).toBe('committed');
    } finally {
      db.close();
    }
  });

  test('corrupt data row is quarantined and boot still loads peers', () => {
    const dbPath = join(tempDir, 'quarantine.sqlite');
    const mem = new TaskStore();
    const good = mem.createTask('good', '/repo');
    const db = new TaskSqliteStore(dbPath);
    db.importSnapshot({ tasks: mem.getAllTasks() });
    db.close();

    // Inject a corrupt row via raw SQL.
    const raw = new Database(dbPath);
    raw.prepare(`
      INSERT INTO tasks (id, status, parent_task_id, project_id, agent_type, created_at, updated_at, finished_at, is_terminal, data)
      VALUES ('bad-id', 'open', NULL, NULL, 'claude-code', '2026-01-01', '2026-01-01', NULL, 0, 'NOT-JSON')
    `).run();
    raw.close();

    const reopened = new TaskSqliteStore(dbPath);
    try {
      const loaded = reopened.loadAll();
      expect(loaded.tasks.map((t) => t.id)).toEqual([good.id]);
      expect(loaded.quarantinedRows).toBe(1);
    } finally {
      reopened.close();
    }
  });

  test('API-contract parity: SQLite load matches JSON load on same fixture', async () => {
    const mem = new TaskStore();
    const parent = mem.createTask({ prompt: 'parent', cwd: '/repo', projectId: 'p1' });
    const child = mem.createTask({
      prompt: 'child',
      cwd: '/repo',
      parentTaskId: parent.id,
      projectId: 'p1',
    });
    mem.addSession(child.id, {
      tmuxSession: 'sess-child',
      agentType: 'claude-code',
      createdAt: new Date('2026-02-01T00:00:00Z'),
    });
    mem.updateTokenUsage(child.id, {
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.02,
    });
    mem.completeTask(child.id);

    await saveTasks(
      mem.getAllTasks(),
      tasksFile,
      mem.getLifetimeSpendUsd(),
      undefined,
      undefined,
      mem.listRelations(),
    );
    const fromJson = await loadTasks(tasksFile);

    // Migrate + load via SQLite path.
    const opened = await openTaskStateStore(tasksFile);
    try {
      const fromSql = opened.load;
      expect(fromSql.tasks).toHaveLength(fromJson.tasks.length);
      expect(fromSql.lifetimeSpendUsd).toBe(fromJson.lifetimeSpendUsd);
      expect((fromSql.relations ?? []).length).toBe((fromJson.relations ?? []).length);

      const jsonById = new Map(fromJson.tasks.map((t) => [t.id, t]));
      for (const t of fromSql.tasks) {
        const j = jsonById.get(t.id)!;
        expect(t.prompt).toBe(j.prompt);
        expect(t.status).toBe(j.status);
        expect(t.projectId).toBe(j.projectId);
        expect(t.parentTaskId).toBe(j.parentTaskId);
        expect(t.tokenUsage?.costUsd).toBe(j.tokenUsage?.costUsd);
        expect(t.sessions.map((s) => s.tmuxSession)).toEqual(j.sessions.map((s) => s.tmuxSession));
      }

      // In-memory store loaded from either source exposes the same public API.
      const storeA = new TaskStore();
      storeA.loadTasks(fromJson.tasks, fromJson.lifetimeSpendUsd);
      storeA.loadRelations(fromJson.relations ?? []);
      const storeB = new TaskStore();
      storeB.loadTasks(fromSql.tasks, fromSql.lifetimeSpendUsd);
      storeB.loadRelations(fromSql.relations ?? []);

      expect(storeB.getActiveCount()).toBe(storeA.getActiveCount());
      expect(storeB.getPendingCount()).toBe(storeA.getPendingCount());
      expect(storeB.getProjectIds().sort()).toEqual(storeA.getProjectIds().sort());
      expect(storeB.listTasksByProject('p1').map((t) => t.id).sort())
        .toEqual(storeA.listTasksByProject('p1').map((t) => t.id).sort());
      expect(storeB.findTaskBySession('sess-child')?.id)
        .toBe(storeA.findTaskBySession('sess-child')?.id);
      expect(storeB.listRelations()).toHaveLength(storeA.listRelations().length);
      expect(storeB.getLifetimeSpendUsd()).toBe(storeA.getLifetimeSpendUsd());
      // beginLaunch CAS still works (in-memory, unaffected by persistence).
      const openTask = storeB.listTasks({ status: 'open' })[0]!;
      expect(storeB.beginLaunch(openTask.id)).toBe(true);
      expect(storeB.beginLaunch(openTask.id)).toBe(false);
    } finally {
      opened.sqliteStore?.close();
    }
  });

  test('KOOKR_TASK_STORE=json keeps legacy whole-file path', async () => {
    process.env.KOOKR_TASK_STORE = 'json';
    const mem = new TaskStore();
    mem.createTask('legacy', '/repo');
    const opened = await openTaskStateStore(tasksFile);
    expect(opened.mode).toBe('json');
    expect(opened.sqliteStore).toBeNull();

    await persistTaskState({
      taskStore: mem,
      tasksFile,
      sqliteStore: null,
      policy: 'none',
    });
    expect(existsSync(tasksFile)).toBe(true);
    const loaded = await loadTasks(tasksFile);
    expect(loaded.tasks).toHaveLength(1);
    expect(existsSync(resolveTaskSqlitePath(tasksFile))).toBe(false);
  });

  test('hydrateTaskFromPersistedJson restores Date instances', () => {
    const hydrated = hydrateTaskFromPersistedJson({
      id: 't1',
      prompt: 'p',
      cwd: '/c',
      agentType: 'claude-code',
      status: 'open',
      sessions: [{
        tmuxSession: 's1',
        agentType: 'claude-code',
        createdAt: '2026-03-01T12:00:00.000Z',
      }],
      createdAt: '2026-03-01T12:00:00.000Z',
      updatedAt: '2026-03-01T12:00:00.000Z',
    });
    expect(hydrated.createdAt).toBeInstanceOf(Date);
    expect(hydrated.sessions[0]!.createdAt).toBeInstanceOf(Date);
    expect(hydrated.provenance).toBeDefined();
  });

  test('getTaskForMutation marks dirty pessimistically', () => {
    const store = new TaskStore();
    const t = store.createTask('x', '/repo');
    store.clearDirtyPersistence();
    expect(store.hasDirtyPersistence()).toBe(false);
    const live = store.getTaskForMutation(t.id)!;
    live.name = 'mutated-out-of-band';
    expect(store.hasDirtyPersistence()).toBe(true);
    const drained = store.drainDirtyState();
    expect(drained.dirtyTaskIds).toEqual([t.id]);
  });

  test('single-mutation flush does not require getAllTasks clone of peers', async () => {
    const mem = new TaskStore();
    for (let i = 0; i < 20; i++) mem.createTask(`task-${i}`, '/repo');
    const opened = await openTaskStateStore(tasksFile);
    const db = opened.sqliteStore!;
    db.importSnapshot({ tasks: mem.getAllTasks() });
    mem.clearDirtyPersistence();

    const target = mem.listTasks()[0]!;
    mem.renameTask(target.id, 'only-me');

    const getAllSpy = (mem as unknown as { getAllTasks: () => unknown }).getAllTasks;
    let getAllCalls = 0;
    const original = getAllSpy.bind(mem);
    (mem as unknown as { getAllTasks: () => unknown }).getAllTasks = () => {
      getAllCalls += 1;
      return original();
    };

    await persistTaskState({ taskStore: mem, tasksFile, sqliteStore: db, policy: 'none' });
    // Dirty flush path must not call getAllTasks.
    expect(getAllCalls).toBe(0);
    expect(db.loadAll().tasks.find((t) => t.id === target.id)?.name).toBe('only-me');
    db.close();
  });
});
