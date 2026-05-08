import { readdir, stat } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { loadTasks, CorruptTaskFileError } from '../../core/task-persistence.js';
import type { Task } from '../../core/tasks.js';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

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
 * files maximum. No additional cap is required. The RFC originally proposed
 * a cap-at-90 mitigation under the assumption no GC existed; on inspection
 * the GC does exist (`pruneDailySnapshots` / `prunePredeleteSnapshots`),
 * making the cap redundant.
 *
 * Privacy posture: predelete snapshots may contain prompts the user swept
 * for privacy reasons. The cost-comparison wire shape (`PerTaskRow`) does
 * not include `prompt` or `name`, so the panel cannot exhibit a swept
 * prompt directly. The `q` search parameter on the route still matches
 * against prompt+name server-side, exposing a presence-only side channel
 * that pre-existed this change. A user running Kookr behind a port-forward
 * inherits that side channel for swept tasks too.
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

/**
 * Clamp the lower bound of the Codex rollout-scanner directory walk to the
 * earliest known task createdAt minus a 7-day margin
 * (rfc-cost-comparison-coverage-and-perf.md §Change 3).
 *
 * Without the clamp, `window=all` walks every UTC date directory back to epoch
 * — ~57 years × 365 ≈ 21k empty `safeReaddir` calls — for no benefit, since
 * rollouts older than the earliest task can never bind to anything. Cold scans
 * on a real corpus measured 94 s, 19× over R6's 5 s ceiling.
 *
 * The 7-day margin absorbs:
 *   - sub-agent rollouts whose `session_meta.timestamp` may precede the parent
 *     task's `createdAt` by a few seconds-to-minutes,
 *   - cross-machine clock skew,
 *   - Codex sessions started slightly before the corresponding Kookr launch.
 *
 * The result is also clamped above by `windowEndMs - 1` so a future-dated
 * `earliestTaskMs` (clock skew, restored backup with future timestamps) cannot
 * invert the scan range and silently return zero rollouts. With an inverted
 * range, `collectPaths`'s `cursor <= limit` loop returns [] and the panel
 * would attribute $0 to Codex with no diagnostic — a worse failure than a
 * slow scan.
 */
export function clampScanStart(
  windowStartMs: number,
  windowEndMs: number,
  tasks: Task[],
): number {
  if (tasks.length === 0) return windowStartMs;

  let earliestTaskMs = Number.POSITIVE_INFINITY;
  for (const t of tasks) {
    const created = t.createdAt instanceof Date
      ? t.createdAt.getTime()
      : new Date(t.createdAt).getTime();
    if (Number.isFinite(created) && created < earliestTaskMs) {
      earliestTaskMs = created;
    }
  }
  if (!Number.isFinite(earliestTaskMs)) return windowStartMs;

  const candidate = Math.max(windowStartMs, earliestTaskMs - SEVEN_DAYS_MS);
  // Upper guard: never let the clamp invert the scan range. Subtracting 1 ms
  // (vs Math.min(candidate, windowEndMs)) guarantees `start < end` even when
  // the window itself is degenerate.
  return Math.min(candidate, Math.max(windowStartMs, windowEndMs - 1));
}
