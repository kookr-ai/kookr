import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { Monitor } from '../../core/monitor.js';
import type { Task, TaskStore } from '../../core/tasks.js';
import { isAgedTerminalTask, taskSnapshotRecencyMs } from './snapshot-projection.js';

/**
 * Aged terminal task-record pruning (issue #1526 Phase C / C2 payload diet).
 *
 * The `/api/health` `agents` count is `taskStore.listTasks().length` — during
 * the 2026-07-24 incident it sat at 615 because terminal task records are
 * never removed unless the user manually sweeps (`clearCompleted`). Every one
 * of those records is re-serialized into every WebSocket snapshot candidate,
 * every `GET /api/tasks` response, and every periodic `tasks.json` save
 * (~21 MB), making the unbounded map the incident's force multiplier.
 *
 * This use case removes terminal (completed/cancelled/terminated) tasks whose
 * last activity is older than {@link DEFAULT_TASK_RECORD_MAX_AGE_DAYS} days
 * from the in-memory store; the shrunken set is persisted by the next
 * periodic save tick, so `tasks.json` shrinks without any format change.
 * It runs on the existing scheduled maintenance sweep
 * (`runScheduledMaintenancePrune` in lifecycle-timers) — no new timer.
 *
 * Safety model (mirrors `clearFinishedTasks`):
 *  - a predelete snapshot of `tasks.json` is taken FIRST; if it fails the
 *    prune aborts (`snapshot_failed`) rather than risk unrecoverable loss.
 *    Pruned records therefore remain readable via the historical-snapshot
 *    union (`loadHistoricalTasks`) until snapshot retention expires.
 *  - tree integrity: a terminal task is only pruned when every child task
 *    still present in the store is itself being pruned in the same sweep —
 *    a parent is never deleted out from under a live or recent child.
 *  - each pruned task's sessions are unregistered from the Monitor so its
 *    event windows / auditor records are freed with the record.
 *  - an audit row (`task.pruneAged`) is appended per sweep.
 *
 * Deliberately out of scope: archival of the pruned records to a dedicated
 * history file (the predelete/daily snapshots are the only history carriers;
 * see the follow-up noted on issue #1526).
 */

/**
 * Terminal tasks whose last activity is older than this many days are pruned
 * from the hot in-memory store (and next SQLite flush deletes the rows).
 *
 * Kept short on purpose: completed/cancelled history must not accumulate into
 * a multi-hundred-task hot map that tax every timer tick. Operators still
 * recover older records from daily/predelete JSON snapshots via
 * `loadHistoricalTasks`. Override with the opts.maxAgeDays dial or wire a
 * higher value if a deployment needs longer hot retention.
 */
export const DEFAULT_TASK_RECORD_MAX_AGE_DAYS = 1;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface PruneAgedTaskRecordsDeps {
  taskStore: Pick<TaskStore, 'viewTasks' | 'listTasks' | 'getTask' | 'deleteTask' | 'countTasks'>;
  monitor: Pick<Monitor, 'unregisterAgent'>;
  /**
   * Snapshot `tasks.json` before deleting (wired to the same predelete
   * snapshot `clearCompleted` uses). When present and throwing, the prune
   * aborts. When absent (tests / minimal wirings) the prune proceeds.
   */
  takePredeleteSnapshot?: () => Promise<void>;
  /** Audit log path (`<dataDir>/audit.jsonl`); rows are best-effort. */
  auditLogPath?: string;
  /**
   * Drop in-memory GitHub refs for each pruned task (issue #2485). Same
   * contract as operator delete/clear-completed: once the task record is
   * gone the poller must not keep walking its leftover names.
   */
  githubStateStore?: Pick<
    import('../../core/github-state-store.js').GitHubStateStore,
    'removeTask'
  >;
  /** Injectable clock (ms since epoch) for deterministic tests. */
  now?: () => number;
}

export interface PruneAgedTaskRecordsResult {
  outcome: 'pruned' | 'snapshot_failed';
  /** Ids of the deleted task records (empty when nothing was eligible). */
  prunedTaskIds: string[];
  /** Task-record count remaining in the store after the sweep. */
  remainingTasks: number;
  maxAgeDays: number;
}

/**
 * Compute the prunable set: aged terminal tasks, minus any task with a child
 * still present in the store that is not itself prunable. Iterates to a
 * fixpoint so a chain of parents over one recent leaf is fully protected.
 */
export function selectPrunableTasks(tasks: readonly Task[], cutoffMs: number): Task[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const prunable = new Set(
    tasks.filter((task) => isAgedTerminalTask(task, cutoffMs)).map((task) => task.id),
  );

  // Children per task: the declared childTaskIds union the parentTaskId
  // backrefs, so a child linked only one way still protects its parent.
  const childrenByParent = new Map<string, Set<string>>();
  const addChild = (parentId: string, childId: string): void => {
    let set = childrenByParent.get(parentId);
    if (!set) {
      set = new Set();
      childrenByParent.set(parentId, set);
    }
    set.add(childId);
  };
  for (const task of tasks) {
    if (task.parentTaskId) addChild(task.parentTaskId, task.id);
    for (const childId of task.childTaskIds ?? []) addChild(task.id, childId);
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const id of prunable) {
      const blockingChild = [...(childrenByParent.get(id) ?? [])].some(
        (childId) => byId.has(childId) && !prunable.has(childId),
      );
      if (blockingChild) {
        prunable.delete(id);
        changed = true;
      }
    }
  }

  return tasks.filter((task) => prunable.has(task.id));
}

export async function pruneAgedTaskRecords(
  deps: PruneAgedTaskRecordsDeps,
  opts: { maxAgeDays?: number } = {},
): Promise<PruneAgedTaskRecordsResult> {
  const now = deps.now ?? Date.now;
  const maxAgeDays = opts.maxAgeDays ?? DEFAULT_TASK_RECORD_MAX_AGE_DAYS;
  if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) {
    throw new Error(`maxAgeDays must be a positive number (got ${String(opts.maxAgeDays)})`);
  }
  const cutoffMs = now() - maxAgeDays * MS_PER_DAY;

  // Non-cloning view: prune only needs status/age/parent-child topology, and
  // listTasks() clone thrash was the same force-multiplier as clearCompleted.
  const tasks = typeof deps.taskStore.viewTasks === 'function'
    ? deps.taskStore.viewTasks()
    : deps.taskStore.listTasks();
  const toPrune = selectPrunableTasks(tasks, cutoffMs);
  const remainingBefore = typeof deps.taskStore.countTasks === 'function'
    ? deps.taskStore.countTasks()
    : tasks.length;
  if (toPrune.length === 0) {
    return { outcome: 'pruned', prunedTaskIds: [], remainingTasks: remainingBefore, maxAgeDays };
  }

  if (deps.takePredeleteSnapshot) {
    try {
      await deps.takePredeleteSnapshot();
    } catch (err) {
      console.error(
        '[task-record-prune] predelete snapshot failed, aborting prune to prevent unrecoverable data loss:',
        err,
      );
      return { outcome: 'snapshot_failed', prunedTaskIds: [], remainingTasks: remainingBefore, maxAgeDays };
    }
  }

  const prunedTaskIds: string[] = [];
  for (const task of toPrune) {
    if (!deps.taskStore.getTask(task.id)) continue; // deleted concurrently
    // Terminal record sweep, not an active task delete — no adapter.stop, but
    // free the Monitor's per-session state (mirrors deleteFinishedTaskRecord).
    for (const session of task.sessions) {
      deps.monitor.unregisterAgent(session.tmuxSession);
    }
    try {
      deps.taskStore.deleteTask(task.id);
      deps.githubStateStore?.removeTask(task.id);
      prunedTaskIds.push(task.id);
    } catch (err) {
      console.warn(`[task-record-prune] failed to delete task ${task.id}:`, err);
    }
  }

  const remainingTasks = typeof deps.taskStore.countTasks === 'function'
    ? deps.taskStore.countTasks()
    : deps.taskStore.listTasks().length;
  await writePruneAudit(deps.auditLogPath, { maxAgeDays, prunedTaskIds, remainingTasks, now });
  return { outcome: 'pruned', prunedTaskIds, remainingTasks, maxAgeDays };
}

async function writePruneAudit(
  auditLogPath: string | undefined,
  record: { maxAgeDays: number; prunedTaskIds: string[]; remainingTasks: number; now: () => number },
): Promise<void> {
  if (!auditLogPath) return;
  const row = {
    type: 'task.pruneAged',
    timestamp: new Date(record.now()).toISOString(),
    actor: { source: 'maintenance-prune' },
    maxAgeDays: record.maxAgeDays,
    count: record.prunedTaskIds.length,
    deletedTaskIds: record.prunedTaskIds,
    remainingTasks: record.remainingTasks,
  };
  try {
    await mkdir(dirname(auditLogPath), { recursive: true });
    await appendFile(auditLogPath, `${JSON.stringify(row)}\n`, 'utf-8');
  } catch (err) {
    console.warn('[task-record-prune] failed to append audit row:', err);
  }
}

/** Re-export for callers that gate on the same recency notion. */
export { taskSnapshotRecencyMs };
