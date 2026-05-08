import { readdir, stat } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { loadTasks, CorruptTaskFileError } from '../../core/task-persistence.js';
import type { Task } from '../../core/tasks.js';

/**
 * Read swept-task history from on-disk snapshots and union with the live store.
 *
 * Snapshots come in two flavors (see src/core/task-persistence.ts §"Snapshot rotation"):
 *   - tasks.json.daily.YYYYMMDD              — first save of each local day, 7-day retention
 *   - tasks.json.predelete.YYYYMMDDTHHMMSS   — taken before clearCompleted, last-5 retention
 *
 * The cost-comparison panel relies on this to fight the load-bearing limitation
 * documented in `rfc-cost-comparison-panel.md` §Phase 0 findings — Finding A
 * ("Kookr task history is ephemeral"). Without snapshot reads the panel renders
 * structurally empty: a swept task disappears from cost-comparison the moment
 * `clearCompleted` runs.
 *
 * Merge rule:
 *   - Live tasks always win on (id) collision — they may have been mutated since
 *     the most recent snapshot (status flipped, feedback rating set, token usage
 *     accumulated).
 *   - Among snapshot files, last-seen-by-mtime wins. The freshest snapshot copy
 *     of a still-live or recently-swept task is the most accurate reflection of
 *     its terminal state.
 *
 * Best-effort: a corrupt snapshot file is logged and skipped, never thrown. The
 * caller (cost-comparison route) is read-only telemetry — degraded data is
 * preferable to a 500.
 *
 * Bounds: the existing snapshot rotation caps daily files at 7 (one per UTC
 * day, 7-day retention) and predelete files at 5, so the union covers ~12
 * files maximum. No additional cap is required.
 */
export async function loadHistoricalTasks(
  liveTasks: Task[],
  tasksFile: string,
): Promise<Task[]> {
  const dir = dirname(tasksFile);
  const base = basename(tasksFile);
  const dailyPrefix = `${base}.daily.`;
  const predeletePrefix = `${base}.predelete.`;

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return liveTasks;
  }

  const snapshotPaths = entries
    .filter(e => e.startsWith(dailyPrefix) || e.startsWith(predeletePrefix))
    .map(e => join(dir, e));

  if (snapshotPaths.length === 0) return liveTasks;

  const stamped: { path: string; mtimeMs: number }[] = [];
  for (const p of snapshotPaths) {
    try {
      const s = await stat(p);
      stamped.push({ path: p, mtimeMs: s.mtimeMs });
    } catch {
      // Snapshot vanished between readdir and stat (concurrent prune). Benign.
    }
  }
  stamped.sort((a, b) => a.mtimeMs - b.mtimeMs);

  const liveIds = new Set(liveTasks.map(t => t.id));
  const merged = new Map<string, Task>();
  for (const t of liveTasks) merged.set(t.id, t);

  for (const { path } of stamped) {
    let result;
    try {
      result = await loadTasks(path);
    } catch (err) {
      if (err instanceof CorruptTaskFileError) {
        console.warn(`[load-historical-tasks] skipping corrupt snapshot ${path}`);
        continue;
      }
      throw err;
    }
    for (const t of result.tasks) {
      if (liveIds.has(t.id)) continue;
      merged.set(t.id, t);
    }
  }

  return Array.from(merged.values());
}
