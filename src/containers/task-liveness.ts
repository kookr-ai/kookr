import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isTerminalStatus } from '../shared/contracts/task-status.js';
import type { TaskLookupPort } from './ports.js';

interface TaskRow { id?: string; status?: string; updatedAt?: string | number }

function toLiveness(row: TaskRow | undefined): ReturnType<TaskLookupPort> {
  if (!row) return { state: 'unknown' };
  // A row that exists but has no usable status is malformed data, which proves nothing about the task.
  if (typeof row.status !== 'string') return { state: 'store_unreadable' };
  if (!isTerminalStatus(row.status as never)) return { state: 'live' };
  const t = row.updatedAt !== undefined ? new Date(row.updatedAt) : undefined;
  // No usable end time: treat the task as just ended, so retention starts now rather than at the epoch.
  return { state: 'terminal', endedAt: t && !Number.isNaN(t.getTime()) ? t : new Date() };
}

/**
 * Read-only snapshot of the named tasks' liveness from the data dir (`tasks.sqlite` when present, else `tasks.json`).
 * Never opens the store for writing, so it is safe to run next to a live server. An unreadable store makes every
 * task `store_unreadable`, on which the reconciler does nothing at all (a store we cannot read proves nothing).
 */
export async function loadTaskLiveness(dataDir: string, taskIds: string[], env: NodeJS.ProcessEnv = process.env): Promise<TaskLookupPort> {
  const rows = new Map<string, TaskRow>();
  let unreadable = false;
  const dbPath = join(dataDir, 'tasks.sqlite');
  try {
    if (env.KOOKR_TASK_STORE !== 'json' && existsSync(dbPath)) {
      const { default: Database } = await import('better-sqlite3');
      const db = new Database(dbPath, { readonly: true, fileMustExist: true });
      try {
        const stmt = db.prepare('SELECT data FROM tasks WHERE id = ? LIMIT 1');
        for (const id of taskIds) {
          const r = stmt.get(id) as { data: string } | undefined;
          if (r) rows.set(id, JSON.parse(r.data) as TaskRow);
        }
      } finally {
        db.close();
      }
    } else {
      const parsed = JSON.parse(await readFile(join(dataDir, 'tasks.json'), 'utf8')) as unknown;
      const list = Array.isArray(parsed) ? parsed : (parsed as { tasks?: unknown })?.tasks;
      if (!Array.isArray(list)) throw new Error('tasks.json has no task list');
      for (const t of list as TaskRow[]) if (t?.id && taskIds.includes(t.id)) rows.set(t.id, t);
    }
  } catch {
    unreadable = true;
  }
  const asked = new Set(taskIds);
  // An id that was never looked up proves nothing: report it as unreadable, never as an absent (unknown) task.
  return (id) => (unreadable || !asked.has(id) ? { state: 'store_unreadable' } : toLiveness(rows.get(id)));
}
