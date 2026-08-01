/**
 * SQLite-backed task persistence (#1755).
 *
 * Schema: one JSON `data` blob per task + thin promoted predicate columns.
 * Write path: dirty-set flush in a single WAL transaction.
 * Migration: one-shot import from tasks.json when the DB is absent.
 *
 * Mirrors relay/src/state/sqlite.ts for WAL / foreign_keys / integrity_check /
 * per-row quarantine conventions.
 */
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';

import Database from 'better-sqlite3';

import { normalizeAgentType } from './agent-types.js';
import { UNKNOWN_PROVENANCE } from './task-provenance.js';
import type { Task } from './tasks.js';
import { isTerminalStatus } from './task-status.js';
import type { PersistedSnooze } from './types.js';
import type { PersistedSuppressionEntry } from './snooze-suppression.js';
import type { TaskRelation } from '../shared/contracts/task-relations.js';
import {
  isTaskRelationLifecycle,
  isTaskRelationSource,
  isTaskRelationType,
} from '../shared/contracts/task-relations.js';
import { createLogger } from './logger.js';

const logger = createLogger('task-sqlite');

export const TASK_SQLITE_SCHEMA_VERSION = '1';

export interface TaskSqliteLoadResult {
  tasks: Task[];
  lifetimeSpendUsd: number;
  snoozes: PersistedSnooze[];
  suppressionState: PersistedSuppressionEntry[];
  relations: TaskRelation[];
  quarantinedRows: number;
  source: 'sqlite' | 'migrated-json' | 'empty';
  migratedFrom?: string;
}

export interface TaskSqliteFlushInput {
  tasks: Task[];
  deletedTaskIds: string[];
  relations?: TaskRelation[] | null;
  lifetimeSpendUsd?: number;
  snoozes?: PersistedSnooze[] | null;
  suppressionState?: PersistedSuppressionEntry[] | null;
  /** When true, rewrite the full relations table from the provided list. */
  replaceRelations?: boolean;
}

export interface TaskSqliteFlushMetrics {
  taskUpserts: number;
  taskDeletes: number;
  relationReplace: boolean;
  durationMs: number;
  /** UTF-8 bytes of task JSON blobs written this flush (issue #1777). */
  bytes: number;
}

export function resolveTaskSqlitePath(tasksFile: string): string {
  return join(dirname(tasksFile), 'tasks.sqlite');
}

export function resolveTaskStoreMode(env: NodeJS.ProcessEnv = process.env): 'sqlite' | 'json' {
  const raw = env.KOOKR_TASK_STORE?.trim().toLowerCase();
  if (raw === 'json') return 'json';
  return 'sqlite';
}

/** Coerce Date fields after JSON.parse of a Task blob (mirrors loadTasks). */
export function hydrateTaskFromPersistedJson(raw: unknown): Task {
  if (!raw || typeof raw !== 'object') {
    throw new Error('task data is not an object');
  }
  const task = raw as Task;
  if (typeof task.id !== 'string' || !task.id) {
    throw new Error('task data missing id');
  }
  task.agentType = normalizeAgentType(task.agentType);
  if (!task.provenance) task.provenance = { ...UNKNOWN_PROVENANCE };
  task.createdAt = new Date(task.createdAt);
  task.updatedAt = new Date(task.updatedAt);
  if (task.finishedAt) task.finishedAt = new Date(task.finishedAt);
  if (task.terminatedAt) task.terminatedAt = new Date(task.terminatedAt);
  if (!Array.isArray(task.sessions)) task.sessions = [];
  for (const session of task.sessions) {
    session.agentType = normalizeAgentType(session.agentType);
    session.createdAt = new Date(session.createdAt);
  }
  return task;
}

function iso(value: Date | string | undefined | null): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function isTerminalFlag(status: Task['status']): number {
  return isTerminalStatus(status) ? 1 : 0;
}

export class TaskSqliteStore {
  private readonly db: Database.Database;
  private readonly upsertTaskStmt: Database.Statement;
  private readonly deleteTaskStmt: Database.Statement;
  private readonly deleteSessionsForTaskStmt: Database.Statement;
  private readonly insertSessionStmt: Database.Statement;
  private readonly clearRelationsStmt: Database.Statement;
  private readonly upsertRelationStmt: Database.Statement;
  private readonly setMetaStmt: Database.Statement;
  private readonly getMetaStmt: Database.Statement;
  private readonly clearSnoozesStmt: Database.Statement;
  private readonly insertSnoozeStmt: Database.Statement;
  private readonly clearSuppressionStmt: Database.Statement;
  private readonly insertSuppressionStmt: Database.Statement;

  constructor(private readonly dbPath: string) {
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    try {
      this.db = new Database(dbPath);
    } catch (err) {
      throw new Error(`failed to open task store database at ${dbPath}`, { cause: err });
    }
    this.db.pragma('journal_mode = WAL');
    const journalMode = String(
      (this.db.pragma('journal_mode', { simple: true }) as string | undefined) ?? '',
    ).toLowerCase();
    if (dbPath !== ':memory:' && journalMode !== 'wal') {
      throw new Error(`task store database did not enter WAL mode; journal_mode=${journalMode || 'unknown'}`);
    }
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('synchronous = NORMAL');
    this.migrate();
    this.assertIntegrity();

    this.upsertTaskStmt = this.db.prepare(`
      INSERT INTO tasks (
        id, status, parent_task_id, project_id, agent_type,
        created_at, updated_at, finished_at, is_terminal, data
      ) VALUES (
        @id, @status, @parent_task_id, @project_id, @agent_type,
        @created_at, @updated_at, @finished_at, @is_terminal, @data
      )
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        parent_task_id = excluded.parent_task_id,
        project_id = excluded.project_id,
        agent_type = excluded.agent_type,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        finished_at = excluded.finished_at,
        is_terminal = excluded.is_terminal,
        data = excluded.data
    `);
    this.deleteTaskStmt = this.db.prepare('DELETE FROM tasks WHERE id = ?');
    this.deleteSessionsForTaskStmt = this.db.prepare('DELETE FROM task_sessions WHERE task_id = ?');
    this.insertSessionStmt = this.db.prepare(`
      INSERT INTO task_sessions (tmux_session, task_id, last_status)
      VALUES (@tmux_session, @task_id, @last_status)
      ON CONFLICT(tmux_session) DO UPDATE SET
        task_id = excluded.task_id,
        last_status = excluded.last_status
    `);
    this.clearRelationsStmt = this.db.prepare('DELETE FROM task_relations');
    this.upsertRelationStmt = this.db.prepare(`
      INSERT INTO task_relations (
        source_task_id, target_task_id, type, confidence, source,
        lifecycle, created_at, updated_at, data
      ) VALUES (
        @source_task_id, @target_task_id, @type, @confidence, @source,
        @lifecycle, @created_at, @updated_at, @data
      )
      ON CONFLICT(source_task_id, target_task_id, type) DO UPDATE SET
        confidence = excluded.confidence,
        source = excluded.source,
        lifecycle = excluded.lifecycle,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        data = excluded.data
    `);
    this.setMetaStmt = this.db.prepare(`
      INSERT INTO store_meta (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    this.getMetaStmt = this.db.prepare('SELECT value FROM store_meta WHERE key = ?');
    this.clearSnoozesStmt = this.db.prepare('DELETE FROM task_snoozes');
    this.insertSnoozeStmt = this.db.prepare(`
      INSERT INTO task_snoozes (task_id, kind, agent_id, expires_at, data)
      VALUES (@task_id, @kind, @agent_id, @expires_at, @data)
    `);
    this.clearSuppressionStmt = this.db.prepare('DELETE FROM suppression_state');
    this.insertSuppressionStmt = this.db.prepare(`
      INSERT INTO suppression_state (key, data) VALUES (@key, @data)
    `);
  }

  get path(): string {
    return this.dbPath;
  }

  close(): void {
    this.db.close();
  }

  checkpoint(): void {
    this.db.pragma('wal_checkpoint(TRUNCATE)');
  }

  getMeta(key: string): string | undefined {
    const row = this.getMetaStmt.get(key) as { value: string } | undefined;
    return row?.value;
  }

  /**
   * One-shot import of a fully-validated LoadTasks-shaped payload.
   * Single transaction; partial failure rolls back cleanly.
   */
  importSnapshot(input: {
    tasks: Task[];
    lifetimeSpendUsd?: number;
    snoozes?: PersistedSnooze[];
    suppressionState?: PersistedSuppressionEntry[];
    relations?: TaskRelation[];
    migratedFrom?: string;
  }): void {
    const run = this.db.transaction(() => {
      this.db.exec('DELETE FROM task_sessions');
      this.db.exec('DELETE FROM tasks');
      this.clearRelationsStmt.run();
      this.clearSnoozesStmt.run();
      this.clearSuppressionStmt.run();

      for (const task of input.tasks) {
        this.upsertTaskRow(task);
      }
      for (const rel of input.relations ?? []) {
        this.upsertRelationRow(rel);
      }
      this.replaceSnoozes(input.snoozes ?? []);
      this.replaceSuppression(input.suppressionState ?? []);
      this.setMetaStmt.run('schema_version', TASK_SQLITE_SCHEMA_VERSION);
      this.setMetaStmt.run(
        'lifetime_spend_usd',
        String(input.lifetimeSpendUsd ?? 0),
      );
      if (input.migratedFrom) {
        this.setMetaStmt.run('migrated_from', input.migratedFrom);
        this.setMetaStmt.run('migrated_at', new Date().toISOString());
      }
    });
    run();
    this.assertIntegrity();
  }

  loadAll(): TaskSqliteLoadResult {
    let quarantinedRows = 0;
    const tasks: Task[] = [];
    const taskRows = this.db.prepare('SELECT id, data FROM tasks').all() as Array<{ id: string; data: string }>;
    for (const row of taskRows) {
      try {
        const parsed = JSON.parse(row.data) as unknown;
        const task = hydrateTaskFromPersistedJson(parsed);
        if (task.id !== row.id) {
          throw new Error(`task id mismatch: row=${row.id} data=${task.id}`);
        }
        tasks.push(task);
      } catch (err) {
        quarantinedRows += 1;
        this.quarantine(
          'tasks',
          row.id,
          row.data,
          err instanceof Error ? err.message : String(err),
        );
        this.deleteTaskStmt.run(row.id);
      }
    }

    const relations: TaskRelation[] = [];
    const relRows = this.db.prepare('SELECT data FROM task_relations').all() as Array<{ data: string }>;
    for (const row of relRows) {
      try {
        const rel = parseRelation(row.data);
        relations.push(rel);
      } catch (err) {
        quarantinedRows += 1;
        this.quarantine(
          'task_relations',
          'unknown',
          row.data,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    const snoozes: PersistedSnooze[] = [];
    const snoozeRows = this.db.prepare('SELECT data FROM task_snoozes').all() as Array<{ data: string }>;
    for (const row of snoozeRows) {
      try {
        snoozes.push(JSON.parse(row.data) as PersistedSnooze);
      } catch (err) {
        quarantinedRows += 1;
        this.quarantine(
          'task_snoozes',
          'unknown',
          row.data,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    const suppressionState: PersistedSuppressionEntry[] = [];
    const suppRows = this.db.prepare('SELECT key, data FROM suppression_state').all() as Array<{ key: string; data: string }>;
    for (const row of suppRows) {
      try {
        suppressionState.push(JSON.parse(row.data) as PersistedSuppressionEntry);
      } catch (err) {
        quarantinedRows += 1;
        this.quarantine(
          'suppression_state',
          row.key,
          row.data,
          err instanceof Error ? err.message : String(err),
        );
        this.db.prepare('DELETE FROM suppression_state WHERE key = ?').run(row.key);
      }
    }

    const spendRaw = this.getMeta('lifetime_spend_usd');
    const lifetimeSpendUsd = spendRaw !== undefined && Number.isFinite(Number(spendRaw))
      ? Number(spendRaw)
      : 0;

    const migratedFrom = this.getMeta('migrated_from');
    return {
      tasks,
      lifetimeSpendUsd,
      snoozes,
      suppressionState,
      relations,
      quarantinedRows,
      source: migratedFrom ? 'migrated-json' : 'sqlite',
      migratedFrom,
    };
  }

  /**
   * Flush dirty rows in one WAL transaction. Relations are replaced in full
   * when `replaceRelations` is true (the in-memory graph is small and the
   * natural composite key makes partial diffs brittle after deletes).
   */
  flush(input: TaskSqliteFlushInput): TaskSqliteFlushMetrics {
    const started = performance.now();
    let taskUpserts = 0;
    let taskDeletes = 0;
    let bytes = 0;
    const replaceRelations = Boolean(input.replaceRelations && input.relations);

    const run = this.db.transaction(() => {
      for (const id of input.deletedTaskIds) {
        this.deleteSessionsForTaskStmt.run(id);
        this.deleteTaskStmt.run(id);
        taskDeletes += 1;
      }
      for (const task of input.tasks) {
        bytes += this.upsertTaskRow(task);
        taskUpserts += 1;
      }
      if (replaceRelations && input.relations) {
        this.clearRelationsStmt.run();
        for (const rel of input.relations) {
          this.upsertRelationRow(rel);
        }
      }
      if (input.lifetimeSpendUsd !== undefined) {
        this.setMetaStmt.run('lifetime_spend_usd', String(input.lifetimeSpendUsd));
      }
      if (input.snoozes !== undefined && input.snoozes !== null) {
        this.replaceSnoozes(input.snoozes);
      }
      if (input.suppressionState !== undefined && input.suppressionState !== null) {
        this.replaceSuppression(input.suppressionState);
      }
      this.setMetaStmt.run('schema_version', TASK_SQLITE_SCHEMA_VERSION);
    });
    run();

    return {
      taskUpserts,
      taskDeletes,
      relationReplace: replaceRelations,
      durationMs: Math.round((performance.now() - started) * 100) / 100,
      bytes,
    };
  }

  /** Count rows — used by migration cutover verification. */
  countTasks(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number };
    return row.n;
  }

  countRelations(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM task_relations').get() as { n: number };
    return row.n;
  }

  /** Upsert one task row. Returns UTF-8 byte length of the serialized task blob. */
  private upsertTaskRow(task: Task): number {
    const data = JSON.stringify(task);
    this.upsertTaskStmt.run({
      id: task.id,
      status: task.status,
      parent_task_id: task.parentTaskId ?? null,
      project_id: task.projectId ?? null,
      agent_type: task.agentType,
      created_at: iso(task.createdAt) ?? new Date().toISOString(),
      updated_at: iso(task.updatedAt) ?? new Date().toISOString(),
      finished_at: iso(task.finishedAt ?? null),
      is_terminal: isTerminalFlag(task.status),
      data,
    });
    // Rebuild session projection for this task only.
    this.deleteSessionsForTaskStmt.run(task.id);
    for (const session of task.sessions ?? []) {
      if (!session.tmuxSession) continue;
      this.insertSessionStmt.run({
        tmux_session: session.tmuxSession,
        task_id: task.id,
        last_status: session.lastStatus ?? null,
      });
    }
    return Buffer.byteLength(data, 'utf-8');
  }

  private upsertRelationRow(rel: TaskRelation): void {
    this.upsertRelationStmt.run({
      source_task_id: rel.sourceTaskId,
      target_task_id: rel.targetTaskId,
      type: rel.type,
      confidence: rel.confidence,
      source: rel.source,
      lifecycle: rel.lifecycle,
      created_at: rel.createdAt,
      updated_at: rel.updatedAt,
      data: JSON.stringify(rel),
    });
  }

  private replaceSnoozes(snoozes: PersistedSnooze[]): void {
    this.clearSnoozesStmt.run();
    for (const s of snoozes) {
      this.insertSnoozeStmt.run({
        task_id: s.taskId,
        kind: s.kind ?? 'finding',
        agent_id: ('agentId' in s ? s.agentId : null) ?? null,
        expires_at: s.expiresAt ?? null,
        data: JSON.stringify(s),
      });
    }
  }

  private replaceSuppression(entries: PersistedSuppressionEntry[]): void {
    this.clearSuppressionStmt.run();
    for (const entry of entries) {
      this.insertSuppressionStmt.run({
        key: entry.agentId,
        data: JSON.stringify(entry),
      });
    }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id             TEXT PRIMARY KEY,
        status         TEXT NOT NULL,
        parent_task_id TEXT,
        project_id     TEXT,
        agent_type     TEXT NOT NULL,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL,
        finished_at    TEXT,
        is_terminal    INTEGER NOT NULL,
        data           TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tasks_status_idx ON tasks(status);
      CREATE INDEX IF NOT EXISTS tasks_active_created_idx ON tasks(is_terminal, created_at);
      CREATE INDEX IF NOT EXISTS tasks_parent_idx ON tasks(parent_task_id);
      CREATE INDEX IF NOT EXISTS tasks_project_idx ON tasks(project_id);

      CREATE TABLE IF NOT EXISTS task_sessions (
        tmux_session TEXT PRIMARY KEY,
        task_id      TEXT NOT NULL,
        last_status  TEXT,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS task_sessions_task_idx ON task_sessions(task_id);

      CREATE TABLE IF NOT EXISTS task_relations (
        source_task_id TEXT NOT NULL,
        target_task_id TEXT NOT NULL,
        type           TEXT NOT NULL,
        confidence     REAL NOT NULL,
        source         TEXT NOT NULL,
        lifecycle      TEXT NOT NULL,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL,
        data           TEXT NOT NULL,
        PRIMARY KEY (source_task_id, target_task_id, type)
      );
      CREATE INDEX IF NOT EXISTS task_relations_source_idx ON task_relations(source_task_id);
      CREATE INDEX IF NOT EXISTS task_relations_target_idx ON task_relations(target_task_id);

      CREATE TABLE IF NOT EXISTS store_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS task_snoozes (
        rowid      INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id    TEXT NOT NULL,
        kind       TEXT NOT NULL,
        agent_id   TEXT,
        expires_at INTEGER,
        data       TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS task_snoozes_task_idx ON task_snoozes(task_id);

      CREATE TABLE IF NOT EXISTS suppression_state (
        key  TEXT PRIMARY KEY,
        data TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS task_quarantine (
        quarantine_id INTEGER PRIMARY KEY AUTOINCREMENT,
        table_name    TEXT NOT NULL,
        row_id        TEXT NOT NULL,
        payload       TEXT NOT NULL,
        error         TEXT NOT NULL,
        quarantined_at TEXT NOT NULL
      );
    `);
  }

  private assertIntegrity(): void {
    const result = this.db.pragma('integrity_check', { simple: true });
    if (result !== 'ok') {
      throw new Error(`task store database integrity_check failed: ${String(result)}`);
    }
  }

  private quarantine(tableName: string, rowId: string, payload: string, error: string): void {
    logger.warn('task store row quarantined', { tableName, rowId, error });
    this.db.prepare(`
      INSERT INTO task_quarantine (table_name, row_id, payload, error, quarantined_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(tableName, rowId, payload, error, new Date().toISOString());
  }
}

function parseRelation(data: string): TaskRelation {
  const r = JSON.parse(data) as Partial<TaskRelation>;
  if (
    typeof r.id !== 'string'
    || typeof r.sourceTaskId !== 'string'
    || typeof r.targetTaskId !== 'string'
    || !isTaskRelationType(r.type)
    || typeof r.confidence !== 'number'
    || !Number.isFinite(r.confidence)
    || !isTaskRelationSource(r.source)
    || typeof r.createdAt !== 'string'
    || typeof r.updatedAt !== 'string'
    || !isTaskRelationLifecycle(r.lifecycle)
  ) {
    throw new Error('invalid relation row');
  }
  return {
    id: r.id,
    sourceTaskId: r.sourceTaskId,
    targetTaskId: r.targetTaskId,
    type: r.type,
    confidence: r.confidence,
    source: r.source,
    evidence: Array.isArray(r.evidence) ? r.evidence : [],
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    lifecycle: r.lifecycle,
  };
}

/**
 * Rename tasks.json to a backup path after a successful SQLite migration.
 * Never deletes. Returns the backup path.
 */
export function renameTasksJsonBackup(tasksFile: string, now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const backup = `${tasksFile}.pre-sqlite-${stamp}`;
  if (!existsSync(tasksFile)) {
    throw new Error(`cannot rename missing tasks file: ${tasksFile}`);
  }
  renameSync(tasksFile, backup);
  return backup;
}
